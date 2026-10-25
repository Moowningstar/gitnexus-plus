/**
 * Bounded graph projection for the panel's graph view.
 *
 * WHY A PROJECTION AND NOT CYPHER OVER HTTP
 * -----------------------------------------
 * The graph itself is the product here: it answers "what is in this index" better than
 * any table. But a view that accepts Cypher from a browser turns a read-only panel into
 * an arbitrary query endpoint over the user's code graph — and the roadmap's rule is a
 * whitelist of projections, never raw forwarding. So this module exposes exactly two
 * shapes:
 *
 *   `communities`  every community as a node, with aggregated cross-community edges
 *   `community`    one community's member symbols and the relations among them
 *
 * Both are bounded by a node budget and an edge budget, and both report what they left
 * out. A 93k-node repository must not be able to freeze the panel, and a view that
 * silently drops half the graph is worse than one that says it did.
 *
 * WHERE THIS RUNS
 * ---------------
 * `projectGraph` talks to LadybugDB, so it can only run on the system Node — the host
 * is Electron's Node and cannot load the native addon (see `search.ts`). The host calls
 * `projectViaHelper`, which starts `lib/bin/graph-helper.js` and parses one JSON object,
 * exactly like the search path. Keeping the query code in the helper process also means
 * a query that crashes the native engine takes down a short-lived child, not the panel.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isProjectRoot, readIndexMeta } from './index-meta.js';
import { loadAdapter } from './search.js';
import type { ShellLike } from '../shell.js';
import { exitDetail, parseHelperOutput, readLineNumber } from '../shell.js';
import { shellRunner, type Runner } from '../subprocess.js';

/** The projections a caller may ask for. Anything else is refused, not guessed. */
export type GraphView = 'communities' | 'community' | 'symbols';

export const GRAPH_VIEWS: readonly GraphView[] = ['communities', 'community', 'symbols'];

/** A node as the view needs it — enough to draw it, label it, and open its file. */
export interface GraphNode {
  id: string;
  /** GitNexus's own label (Community, Function, Class, …), not a translated kind. */
  kind: string;
  name: string;
  /** Repo-relative path, for the click-to-open behaviour. Null on community nodes. */
  filePath: string | null;
  startLine: number | null;
  /** Community nodes only: how many symbols it holds. */
  symbolCount?: number;
  /**
   * Community nodes only: the file with the most member symbols.
   *
   * GitNexus's community label is a folder name, so it repeats (`Gitnexus` ×18). A
   * representative file is what makes two communities with the same label readable
   * without opening each one.
   */
  representativeFile?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** GitNexus's relation type (CALLS, USES, ACCESSES, …). */
  type: string;
  /** Number of underlying relations this edge aggregates. */
  weight: number;
}

export interface GraphProjection {
  view: GraphView;
  /** The community a drill-down is scoped to; null for the overview. */
  scope: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How many nodes exist before the budget, when the count is known. */
  total: number;
  truncated: boolean;
  budget: { nodes: number; edges: number };
  notes: string[];
  readAt: string;
}

export interface GraphOptions {
  view?: GraphView;
  /** Required for `community`; refused when it could not be a literal safely. */
  id?: string;
  /** The plugin-owned GitNexus prefix, when one was installed from the panel. */
  managedPrefix?: string;
  env?: NodeJS.ProcessEnv;
  nodeBudget?: number;
  edgeBudget?: number;
}

/**
 * A projection failure, in the shape the route and the helper both need.
 *
 * Separate from `SearchError` because the codes are different states: a viewer asking
 * for a community that does not exist is a 400 about the request, not a search failure.
 */
export type GraphErrorCode =
  | 'invalid-view'
  | 'invalid-id'
  | 'not-a-project'
  | 'no-index'
  | 'no-index-store'
  | 'graph-unavailable'
  | 'index-busy'
  | 'graph-cancelled'
  | 'graph-failed';

export class GraphError extends Error {
  code: GraphErrorCode;
  status: number;
  constructor(code: GraphErrorCode, status: number, message: string) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_NODE_BUDGET = 220;
const DEFAULT_EDGE_BUDGET = 800;

/** The character set a node/community id is allowed to contain. */
const ID_PATTERN = /^[\p{L}\p{N}_.:@/#+\-~ ]{1,200}$/u;

/**
 * Reduce a caller-supplied id to something safe inside a single-quoted Cypher literal.
 *
 * The id is interpolated rather than bound because LadybugDB's prepare path does not
 * accept a parameter in every position this query needs (the same limitation `search.ts`
 * documents for `CONTAINS`). Safety comes from **refusing** anything outside a known
 * alphabet — quotes and backslashes cannot appear — rather than from escaping.
 *
 * @returns the id, or null when it is not acceptable
 */
export function sanitizeGraphId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Whether a value names a projection this module implements. */
export function isGraphView(value: unknown): value is GraphView {
  return value === 'communities' || value === 'community' || value === 'symbols';
}

function clampBudget(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Rows from `executePrepared` are the driver's objects; narrow them field by field. */
function rowsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : [];
}

/** One scalar `count(*)` result, defaulting to 0 when the shape is unexpected. */
function countOf(value: unknown): number {
  const [first] = rowsOf(value);
  const total = first === undefined ? undefined : first.total ?? first.count ?? Object.values(first)[0];
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * Read one projection.
 *
 * @param repoPath absolute repository root
 */
export async function projectGraph(repoPath: string, options: GraphOptions = {}): Promise<GraphProjection> {
  const absRepo = path.resolve(repoPath);
  const view: GraphView = options.view ?? 'communities';
  if (!isGraphView(view)) {
    throw new GraphError('invalid-view', 400, `未知的图视图：${String(options.view)}`);
  }
  const nodeBudget = clampBudget(options.nodeBudget, DEFAULT_NODE_BUDGET, 1000);
  const edgeBudget = clampBudget(options.edgeBudget, DEFAULT_EDGE_BUDGET, 4000);

  if (!(await isProjectRoot(absRepo))) {
    throw new GraphError('not-a-project', 404, '目录不是 GitNexus 索引，也不是 git 项目根。');
  }
  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    throw new GraphError('no-index', 409, '该项目还没有 GitNexus 索引；初始化后才能看图。');
  }
  const lbugPath = path.join(absRepo, '.gitnexus', 'lbug');
  if (!existsSync(lbugPath)) {
    throw new GraphError('no-index-store', 409, '索引缺少 .gitnexus/lbug 图存储，无法读图。');
  }

  let scope: string | null = null;
  const notes: string[] = [];
  if (view === 'community') {
    scope = sanitizeGraphId(options.id);
    if (scope === null) {
      throw new GraphError('invalid-id', 400, 'community 视图需要合法的 id 参数。');
    }
  }

  // One adapter load per projection, and one connection for both the page of rows and
  // its total. Reopening the store per query would double the cost of every drill-down.
  let adapter;
  try {
    adapter = await loadAdapter({ env: options.env, managedPrefix: options.managedPrefix });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new GraphError('graph-unavailable', 503, `图数据库适配器不可用：${message}`);
  }

  const runQuery = async (cypher: string): Promise<unknown> => {
    try {
      return await adapter.withLbugDb(lbugPath, async () => adapter.executePrepared(cypher, {}), {
        readOnly: true,
        skipFts: true,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/busy|locked|lock held|another process|timeout/i.test(message)) {
        throw new GraphError('index-busy', 503, '索引正被另一个 GitNexus 操作占用，稍后重试。');
      }
      throw new GraphError('graph-failed', 500, `图查询失败：${message}`);
    }
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let total = 0;

  if (view === 'communities') {
    const communityRows = rowsOf(
      await runQuery(
        `MATCH (c:Community)
         RETURN c.id AS id, c.label AS label, c.symbolCount AS symbolCount
         ORDER BY symbolCount DESC
         LIMIT ${nodeBudget}`,
      ),
    );
    total = countOf(await runQuery('MATCH (c:Community) RETURN count(*) AS total'));

    for (const row of communityRows) {
      const id = asString(row.id);
      if (id === '') continue;
      const label = asString(row.label);
      nodes.push({
        id,
        kind: 'Community',
        name: label === '' ? id : label,
        filePath: null,
        startLine: null,
        symbolCount: typeof row.symbolCount === 'number' ? row.symbolCount : 0,
      });
    }

    // The label alone repeats across sibling folders. Ask which member file each
    // community draws the most symbols from; the client prints that next to the label.
    // This is one extra read per overview, bounded by the member count, not a drill-down
    // per community.
    const representativeRows = rowsOf(
      await runQuery(
        `MATCH (s)-[:CodeRelation {type:'MEMBER_OF'}]->(c:Community)
         RETURN c.id AS communityId, s.filePath AS filePath, count(*) AS weight
         ORDER BY weight DESC
         LIMIT 2000`,
      ),
    );
    const representativeByCommunity = new Map<string, string>();
    for (const row of representativeRows) {
      const communityId = asString(row.communityId);
      const filePath = typeof row.filePath === 'string' ? row.filePath : '';
      if (communityId === '' || filePath === '' || representativeByCommunity.has(communityId)) continue;
      representativeByCommunity.set(communityId, filePath);
    }
    for (const node of nodes) {
      node.representativeFile = representativeByCommunity.get(node.id) ?? null;
    }

    // Cross-community edges are aggregated from the member-to-member relations: one
    // edge per pair of communities per relation type. Two directions are collapsed
    // (`ca.id < cb.id`) so the view does not draw every link twice.
    const edgeRows = rowsOf(
      await runQuery(
        `MATCH (a)-[r:CodeRelation]->(b)
         MATCH (a)-[:CodeRelation {type:'MEMBER_OF'}]->(ca:Community)
         MATCH (b)-[:CodeRelation {type:'MEMBER_OF'}]->(cb:Community)
         WHERE ca.id < cb.id
         RETURN ca.id AS source, cb.id AS target, r.type AS type, count(*) AS weight
         ORDER BY weight DESC
         LIMIT ${edgeBudget}`,
      ),
    );
    for (const row of edgeRows) {
      const source = asString(row.source);
      const target = asString(row.target);
      if (source === '' || target === '') continue;
      edges.push({
        source,
        target,
        type: asString(row.type),
        weight: typeof row.weight === 'number' ? row.weight : 1,
      });
    }
  } else if (view === 'community') {
    const scopeLiteral = scope as string;
    const memberRows = rowsOf(
      await runQuery(
        `MATCH (s)-[:CodeRelation {type:'MEMBER_OF'}]->(c:Community {id:'${scopeLiteral}'})
         RETURN s.id AS id, label(s) AS kind, s.name AS name,
                s.filePath AS filePath, s.startLine AS startLine
         ORDER BY name
         LIMIT ${nodeBudget}`,
      ),
    );
    total = countOf(
      await runQuery(
        `MATCH (s)-[:CodeRelation {type:'MEMBER_OF'}]->(c:Community {id:'${scopeLiteral}'})
         RETURN count(*) AS total`,
      ),
    );

    for (const row of memberRows) {
      const id = asString(row.id);
      if (id === '') continue;
      const { name, filePath, startLine, kind } = row;
      nodes.push({
        id,
        kind: asString(kind),
        name: asString(name) === '' ? id : asString(name),
        filePath: typeof filePath === 'string' && filePath !== '' ? filePath : null,
        startLine: readLineNumber(startLine),
      });
    }

    const edgeRows = rowsOf(
      await runQuery(
        `MATCH (a)-[r:CodeRelation]->(b)
         MATCH (a)-[:CodeRelation {type:'MEMBER_OF'}]->(c:Community {id:'${scopeLiteral}'})
         MATCH (b)-[:CodeRelation {type:'MEMBER_OF'}]->(c)
         RETURN a.id AS source, b.id AS target, r.type AS type, count(*) AS weight
         ORDER BY weight DESC
         LIMIT ${edgeBudget}`,
      ),
    );
    for (const row of edgeRows) {
      const source = asString(row.source);
      const target = asString(row.target);
      if (source === '' || target === '') continue;
      edges.push({
        source,
        target,
        type: asString(row.type),
        weight: typeof row.weight === 'number' ? row.weight : 1,
      });
    }
    if (total === 0 && nodes.length === 0) {
      notes.push('该社区没有成员符号；索引可能是旧版本，或社区已被重新划分。');
    }
  } else {
    // All-symbol view: bounded and honest about the truncation. Communities answer
    // "where is the weight"; this view answers "can I see a symbol outside my community".
    const symbolRows = rowsOf(
      await runQuery(
        `MATCH (s)
         WHERE s.filePath IS NOT NULL
         RETURN s.id AS id, label(s) AS kind, s.name AS name,
                s.filePath AS filePath, s.startLine AS startLine
         ORDER BY filePath, startLine
         LIMIT ${nodeBudget}`,
      ),
    );
    total = countOf(
      await runQuery('MATCH (s) WHERE s.filePath IS NOT NULL RETURN count(*) AS total'),
    );
    for (const row of symbolRows) {
      const id = asString(row.id);
      if (id === '') continue;
      const { name, filePath, startLine, kind } = row;
      nodes.push({
        id,
        kind: asString(kind),
        name: asString(name) === '' ? id : asString(name),
        filePath: typeof filePath === 'string' && filePath !== '' ? filePath : null,
        startLine: readLineNumber(startLine),
      });
    }

    const edgeRows = rowsOf(
      await runQuery(
        `MATCH (a)-[r:CodeRelation]->(b)
         WHERE a.filePath IS NOT NULL AND b.filePath IS NOT NULL
           AND r.type IN ['CALLS','USES','ACCESSES','IMPORTS','IMPLEMENTS','EXTENDS',
                          'HAS_METHOD','HAS_PROPERTY','DEFINES']
         RETURN a.id AS source, b.id AS target, r.type AS type, count(*) AS weight
         ORDER BY weight DESC
         LIMIT ${edgeBudget}`,
      ),
    );
    for (const row of edgeRows) {
      const source = asString(row.source);
      const target = asString(row.target);
      if (source === '' || target === '') continue;
      edges.push({
        source,
        target,
        type: asString(row.type),
        weight: typeof row.weight === 'number' ? row.weight : 1,
      });
    }
  }

  // An edge whose endpoint fell outside the node budget cannot be drawn. Dropping it
  // here keeps the client from having to special-case dangling ids, and the count is
  // reported rather than silently swallowed.
  const present = new Set(nodes.map((node) => node.id));
  const kept = edges.filter((edge) => present.has(edge.source) && present.has(edge.target));
  const droppedEdges = edges.length - kept.length;
  if (droppedEdges > 0) {
    notes.push(`${droppedEdges} 条边因端点超出节点预算未显示`);
  }

  const truncated = total > nodes.length || edges.length >= edgeBudget;
  if (total > nodes.length) {
    notes.push(
      view === 'communities'
        ? `共 ${total} 个社区，显示符号数最多的 ${nodes.length} 个`
        : view === 'symbols'
          ? `共 ${total} 个符号，按文件顺序显示前 ${nodes.length} 个；可用社区视图看全貌`
          : `该社区共 ${total} 个符号，显示前 ${nodes.length} 个`,
    );
  }
  if (edges.length >= edgeBudget) {
    notes.push(`边达到上限 ${edgeBudget}，只保留了权重最高的部分`);
  }

  return {
    view,
    scope,
    nodes,
    edges: kept,
    total,
    truncated,
    budget: { nodes: nodeBudget, edges: edgeBudget },
    notes,
    readAt: new Date().toISOString(),
  };
}

/** Options for the subprocess projection. */
export interface HelperGraphOptions {
  /** The host's shell executor; `null` when the deployment has none. */
  shell: ShellLike | null;
  /**
   * The plugin's process runner, when one was built from the host's seams.
   *
   * Optional so existing callers keep the `ctx.shell` behaviour; when present the helper
   * goes out as `argv` through `ctx.subprocess` if the host exposes that seam.
   */
  runner?: Runner | null;
  /** Absolute path to `lib/bin/graph-helper.js`. */
  helperPath: string;
  managedPrefix?: string;
  nodeBudget?: number;
  edgeBudget?: number;
  /**
   * A policy the host resolved for this repository's index directory.
   *
   * A no-session route otherwise falls back to the DSH application directory, whose
   * Windows ACL grant fails under Program Files. Rooting at `.gitnexus` also keeps the
   * inheritable ACE small: granting the whole repository makes Windows propagate it
   * across every source file (minutes on a large workspace).
   */
  sandboxPolicy?: (indexPath: string) => unknown;
}

function graphErrorCode(value: unknown): GraphErrorCode {
  switch (value) {
    case 'invalid-view':
    case 'invalid-id':
    case 'not-a-project':
    case 'no-index':
    case 'no-index-store':
    case 'graph-unavailable':
    case 'index-busy':
    case 'graph-cancelled':
    case 'graph-failed':
      return value;
    default:
      return 'graph-failed';
  }
}

function asProjection(value: unknown): GraphProjection | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  if (!isGraphView(raw.view)) return null;
  const nodes: GraphNode[] = [];
  for (const item of raw.nodes) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id === '') continue;
    nodes.push({
      id: row.id,
      kind: typeof row.kind === 'string' ? row.kind : 'Unknown',
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      filePath: typeof row.filePath === 'string' && row.filePath !== '' ? row.filePath : null,
      startLine: readLineNumber(row.startLine),
      ...(typeof row.symbolCount === 'number' ? { symbolCount: row.symbolCount } : {}),
    });
  }
  const edges: GraphEdge[] = [];
  for (const item of raw.edges) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.source !== 'string' || typeof row.target !== 'string') continue;
    edges.push({
      source: row.source,
      target: row.target,
      type: typeof row.type === 'string' ? row.type : 'Related',
      weight: typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : 1,
    });
  }
  const budget = (raw.budget ?? {}) as Record<string, unknown>;
  return {
    view: raw.view,
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    nodes,
    edges,
    total: typeof raw.total === 'number' ? raw.total : nodes.length,
    truncated: raw.truncated === true,
    budget: {
      nodes: typeof budget.nodes === 'number' ? budget.nodes : nodes.length,
      edges: typeof budget.edges === 'number' ? budget.edges : edges.length,
    },
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note: unknown): note is string => typeof note === 'string') : [],
    readAt: typeof raw.readAt === 'string' ? raw.readAt : new Date().toISOString(),
  };
}

/**
 * Read a projection in a child Node process.
 *
 * Same execution boundary as `searchViaHelper`, for the same measured reason: the host
 * cannot load `lbugjs.node`. A failure to start the child is reported as
 * `graph-unavailable`, and this plugin never widens the sandbox to make it work.
 */
export async function projectViaHelper(
  repoPath: string,
  view: GraphView,
  id: string | null,
  options: HelperGraphOptions,
): Promise<GraphProjection> {
  const absRepo = path.resolve(repoPath);
  if (!(await isProjectRoot(absRepo))) {
    throw new GraphError('not-a-project', 404, '目录不是 GitNexus 索引，也不是 git 项目根。');
  }
  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    throw new GraphError('no-index', 409, '该项目还没有 GitNexus 索引；初始化后才能看图。');
  }
  if (!existsSync(path.join(absRepo, '.gitnexus', 'lbug'))) {
    throw new GraphError('no-index-store', 409, '索引缺少 .gitnexus/lbug 图存储，无法读图。');
  }
  const runner = options.runner ?? (options.shell === null ? null : shellRunner(options.shell));
  if (runner === null) {
    throw new GraphError(
      'graph-unavailable',
      503,
      '当前部署没有 shell 执行器，无法启动图投影子进程；读图需要系统 Node 加载 GitNexus 原生模块。',
    );
  }

  const budgetNodes = clampBudget(options.nodeBudget, DEFAULT_NODE_BUDGET, 1000);
  const budgetEdges = clampBudget(options.edgeBudget, DEFAULT_EDGE_BUDGET, 4000);

  // A projection is a pure function of the index, the view, the id and the budgets, and
  // producing it costs a Node cold start plus the native open. Switching communities and
  // pressing re-read are common; the index mtime is part of the key, so a refresh
  // invalidates without any cross-module wiring.
  const cacheKey = projectionCacheKey(absRepo, view, id, budgetNodes, budgetEdges);
  const cached = cacheKey === null ? undefined : projectionCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < PROJECTION_CACHE_TTL_MS) {
    return cached.value;
  }

  const sandboxPolicy = options.sandboxPolicy?.(path.join(absRepo, '.gitnexus'));

  const run = await runner.run({
    argv: [
      'node',
      options.helperPath,
      absRepo,
      view,
      id ?? '',
      options.managedPrefix ?? '',
      String(budgetNodes),
      String(budgetEdges),
    ],
    cwd: absRepo,
    timeoutMs: 25_000,
    maxBytes: 4 * 1024 * 1024,
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
  });
  if (run.kind === 'spawn-failed') {
    throw new GraphError('graph-unavailable', 503, `无法启动图投影子进程：${run.message}`);
  }
  if (run.kind === 'timed-out') {
    throw new GraphError('graph-failed', 504, '图投影子进程超时（25 秒）。');
  }
  if (run.kind === 'cancelled') {
    // The caller aborted (the tab closed, or a newer request replaced this one).
    // Nothing was learned, and the executor already stopped the process, so this is
    // not a failure to report as one.
    throw new GraphError('graph-cancelled', 499, '图投影已取消。');
  }

  const parsed = parseHelperOutput(run.stdout);
  if (parsed === null) {
    throw new GraphError(
      'graph-failed',
      500,
      `图投影子进程没有返回可解析结果${exitDetail(run.exitCode, run.stderr)}`,
    );
  }
  if (parsed.ok !== true) {
    const status = typeof parsed.status === 'number' ? parsed.status : 500;
    const message = typeof parsed.message === 'string' ? parsed.message : '读取图失败。';
    throw new GraphError(graphErrorCode(parsed.code), status, message);
  }
  const projection = asProjection(parsed.projection);
  if (projection === null) {
    throw new GraphError('graph-failed', 500, '图投影子进程返回了无法识别的结果形状。');
  }
  if (cacheKey !== null) rememberProjection(cacheKey, projection);
  return projection;
}

/** How many projections to keep; each is bounded by the budgets, so this is small. */
const PROJECTION_CACHE_MAX = 8;
const PROJECTION_CACHE_TTL_MS = 60_000;
const projectionCache = new Map<string, { at: number; value: GraphProjection }>();

function rememberProjection(key: string, value: GraphProjection): void {
  projectionCache.delete(key);
  projectionCache.set(key, { at: Date.now(), value });
  while (projectionCache.size > PROJECTION_CACHE_MAX) {
    const oldest = projectionCache.keys().next().value;
    if (oldest === undefined) break;
    projectionCache.delete(oldest);
  }
}

/**
 * Cache key for one projection, or `null` when the index cannot be statted.
 *
 * The index file's mtime is in the key: a refresh rewrites it, so a cached projection
 * from before the refresh can never be served after it.
 */
function projectionCacheKey(
  repoPath: string,
  view: GraphView,
  id: string | null,
  nodes: number,
  edges: number,
): string | null {
  try {
    const metaFile = path.join(repoPath, '.gitnexus', 'gitnexus.json');
    const mtime = statSync(metaFile).mtimeMs;
    return [repoPath, view, id ?? '', nodes, edges, mtime].join('\u0000');
  } catch {
    return null;
  }
}
