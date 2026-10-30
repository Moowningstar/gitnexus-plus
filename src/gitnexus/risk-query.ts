/**
 * The dependency-risk query, which runs inside the child process, not in the host.
 *
 * Why a process boundary rather than a `GraphView`: a `GraphView` answers one whitelisted
 * question with a fixed argv, and the change set is neither fixed nor small. A six-hundred
 * file change would not survive argv, and uploading it through the projection shape would
 * quietly turn "changed files" into "nodes". So the request is a file, the answer is one
 * object, and the query stays a bounded literal with a hard file cap.
 *
 * Why three queries instead of one: each answers a different question and can be capped
 * separately — which symbols live in the changed files, who points at them from outside, and
 * which community they sit in. Joining them in one Cypher would make the caps meaningless.
 *
 * What this cannot say, and must not be worded to say: whether the project still compiles.
 * A caller edge in the index is a structural fact about the last analysis; a build verdict
 * needs the project's own toolchain, which this plugin never spawns.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadAdapter } from './search.js';
import { describeBlockedStorage, readStorageState } from './storage-state.js';
import { readIndexMeta } from './index-meta.js';
import { isOrphanShadowError, quarantineOrphanShadow } from './lbug-heal.js';

/** Same vocabulary as `DeltaKind`, so a request is a filtered delta. */
export type RiskFileKind = 'modified' | 'added' | 'deleted';

export interface RiskRequestFile {
  /** Repository-relative, forward slashes. */
  path: string;
  kind: RiskFileKind;
}

export interface RiskRequest {
  files: readonly RiskRequestFile[];
  /** Cap for each bucket in the answer; the query caps are independent of this. */
  limit?: number;
}

/** One symbol that lives in a changed file. */
export interface RiskSymbolRef {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  startLine: number | null;
  community: string | null;
}

/** One edge arriving from outside the changed set. */
export interface RiskCaller {
  type: string;
  fromFile: string | null;
  fromName: string | null;
}

export interface RiskSymbolHit {
  symbol: RiskSymbolRef;
  /** How many distinct incoming relations the query found (capped by the query itself). */
  incoming: number;
  callers: RiskCaller[];
  /** True when at least one caller sits in a different community than the symbol. */
  crossCommunity: boolean;
}

export interface RiskBlindSpot {
  path: string;
  kind: RiskFileKind;
  reason: 'no-symbols' | 'not-in-index';
}

export interface RiskQueryResult {
  requested: number;
  matched: number;
  /** True when the file cap dropped entries; the counts below are then lower bounds. */
  filesTruncated: boolean;
  truncated: boolean;
  symbols: number;
  edges: number;
  broken: RiskSymbolHit[];
  exposed: RiskSymbolHit[];
  blind: RiskBlindSpot[];
  counts: { broken: number; exposed: number; blind: number; crossCommunity: number };
  notes: string[];
}

/** Sort order for the file cap: a deleted file matters more than a new one. */
const KIND_PRIORITY: Record<RiskFileKind, number> = { deleted: 0, modified: 1, added: 2 };

/** Hard cap on files sent to one query; `readDelta` can report thousands. */
export const RISK_FILE_CAP = 300;
const SYMBOL_CAP = 6000;
const EDGE_CAP = 12_000;
const COMMUNITY_CAP = 4000;
const RELATION_TYPES = ['CALLS', 'USES', 'ACCESSES', 'IMPORTS', 'IMPLEMENTS', 'EXTENDS'] as const;

/**
 * The files the index claims to have recorded, or `null` when it cannot say.
 *
 * A file with no symbols is not the same fact as a file the index never saw: the first is
 * "nothing to break here", the second is "nothing was compared". The manifest's file list is
 * what separates them, and it is capped on large trees — an empty or missing list means the
 * distinction is unavailable, not that every file is unindexed.
 */
async function indexedFileSet(repoPath: string): Promise<Set<string> | null> {
  const meta = await readIndexMeta(repoPath);
  const keys = meta === null ? [] : Object.keys(meta.fileHashes ?? {});
  if (keys.length === 0) return null;
  return new Set(keys.map((key) => key.replace(/\\/g, '/')));
}

/** A Cypher string literal. Doubling the quote is the only escape this dialect needs. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(', ');
}

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function lineOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Order the request before the cap so a truncated run still says the important half. */
export function orderRiskFiles(files: readonly RiskRequestFile[]): RiskRequestFile[] {
  return [...files].sort((a, b) => {
    const byKind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    return byKind !== 0 ? byKind : a.path.localeCompare(b.path);
  });
}

/**
 * The request a change set produces, capped and ordered.
 *
 * Pure: it takes the delta entries and returns the file list plus how many were dropped, so
 * the cap and the ordering are testable without a graph or a child process.
 */
export function riskRequestFromPaths(
  entries: readonly { path: string; kind: string }[],
  limit = 10,
): { request: RiskRequest; dropped: number } {
  const eligible = entries
    .filter((entry): entry is RiskRequestFile => entry.kind === 'modified' || entry.kind === 'added' || entry.kind === 'deleted')
    .map((entry) => ({ path: entry.path.replace(/\\/g, '/'), kind: entry.kind }));
  const ordered = orderRiskFiles(eligible);
  return {
    request: { files: ordered.slice(0, RISK_FILE_CAP), limit },
    dropped: Math.max(0, ordered.length - RISK_FILE_CAP),
  };
}

/**
 * Run the three bounded queries and assemble one answer.
 *
 * Exported for the helper process only. The host reaches it through `risk-helper.js`; a
 * host-side import would try to load the native adapter in Electron and fail the way
 * `projectGraph` explains.
 */
export async function projectRisk(
  repoPath: string,
  request: RiskRequest,
  options: { managedPrefix?: string } = {},
): Promise<RiskQueryResult> {
  const absRepo = path.resolve(repoPath);
  const storage = readStorageState(absRepo);
  if (!storage.usable) throw new Error(describeBlockedStorage(storage));
  const lbugPath = path.join(absRepo, '.gitnexus', 'lbug');
  if (!existsSync(lbugPath)) throw new Error('索引缺少 .gitnexus/lbug 图存储，无法查询依赖。');

  const ordered = orderRiskFiles(request.files);
  const capped = ordered.slice(0, RISK_FILE_CAP);
  const limit = Math.max(1, Math.min(request.limit ?? 10, 50));
  const notes: string[] = [];
  if (ordered.length > capped.length) {
    notes.push(`改动文件 ${ordered.length} 个，超过单次查询上限 ${RISK_FILE_CAP}，只评估了前 ${capped.length} 个。`);
  }

  const adapter = await loadAdapter({ managedPrefix: options.managedPrefix });
  /**
   * One read-only query, with the same self-heal the graph helper performs.
   *
   * A checkpoint killed mid-write leaves a `.shadow` sidecar the engine refuses to open over,
   * and that failure is not about the question being asked — a risk query would report "cannot
   * evaluate" on a store that the graph tools open fine after healing. The retry is bounded to
   * one attempt because `quarantineOrphanShadow` either parks the sidecar or returns `null`.
   */
  const runQuery = async (cypher: string, healed = false): Promise<unknown> => {
    try {
      return await adapter.withLbugDb(lbugPath, async () => adapter.executePrepared(cypher, {}), {
        readOnly: true,
        skipFts: true,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!healed && isOrphanShadowError(message) && quarantineOrphanShadow(lbugPath) !== null) {
        return await runQuery(cypher, true);
      }
      if (/busy|locked|lock held|another process|timeout/i.test(message)) {
        throw new Error('索引正被另一个 GitNexus 操作占用，稍后重试。');
      }
      throw new Error(`图查询失败：${message}`);
    }
  };

  const files = capped.map((file) => file.path);
  const kindByPath = new Map(capped.map((file) => [file.path, file.kind]));

  if (capped.length === 0) {
    return {
      requested: ordered.length,
      matched: 0,
      filesTruncated: false,
      truncated: false,
      symbols: 0,
      edges: 0,
      broken: [],
      exposed: [],
      blind: [],
      counts: { broken: 0, exposed: 0, blind: 0, crossCommunity: 0 },
      notes,
    };
  }

  const fileList = quoteList(files);

  // Q1: which symbols does the index place in those files?
  const symbolRows = rowsOf(
    await runQuery(
      `MATCH (s)
       WHERE s.filePath IN [${fileList}]
       RETURN s.id AS id, label(s) AS kind, s.name AS name,
              s.filePath AS filePath, s.startLine AS startLine
       LIMIT ${SYMBOL_CAP}`,
    ),
  );
  const symbols = new Map<string, RiskSymbolRef>();
  for (const row of symbolRows) {
    const id = text(row.id);
    const filePath = text(row.filePath);
    if (id === '' || filePath === '') continue;
    symbols.set(id, {
      id,
      kind: text(row.kind),
      name: text(row.name) === '' ? id : text(row.name),
      filePath,
      startLine: lineOf(row.startLine),
      community: null,
    });
  }

  // Q3: which community does each symbol belong to? One extra bounded read, because the
  // module signal has to come from somewhere and `MEMBER_OF` is the only honest source.
  const communityRows = rowsOf(
    await runQuery(
      `MATCH (s)-[:CodeRelation {type:'MEMBER_OF'}]->(c:Community)
       WHERE s.filePath IN [${fileList}]
       RETURN s.id AS id, c.id AS communityId, c.label AS communityLabel
       LIMIT ${COMMUNITY_CAP}`,
    ),
  );
  for (const row of communityRows) {
    const id = text(row.id);
    const communityId = text(row.communityId);
    if (id === '' || communityId === '') continue;
    const symbol = symbols.get(id);
    if (symbol === undefined) continue;
    const label = text(row.communityLabel) === '' ? communityId : text(row.communityLabel);
    symbol.community ??= label;
  }

  // Q2: who points at those symbols from a file outside the changed set? Only incoming edges
  // from elsewhere count: a call inside the changed set cannot be broken by the change itself.
  const edgeRows = rowsOf(
    await runQuery(
      `MATCH (a)-[r:CodeRelation]->(b)
       WHERE b.filePath IN [${fileList}]
         AND r.type IN [${RELATION_TYPES.map(quote).join(', ')}]
         AND (a.filePath IS NULL OR NOT a.filePath IN [${fileList}])
       RETURN b.id AS target, a.name AS sourceName,
              a.filePath AS sourceFile, r.type AS type
       LIMIT ${EDGE_CAP}`,
    ),
  );

  // Which community labels a file's symbols carry. A file can hold several; comparing sets
  // is enough to answer "does the caller sit somewhere else", which is all the alarm needs.
  const communitiesByFile = new Map<string, Set<string>>();
  for (const symbol of symbols.values()) {
    const label = symbol.community;
    if (label === null) continue;
    const set = communitiesByFile.get(symbol.filePath) ?? new Set<string>();
    set.add(label);
    communitiesByFile.set(symbol.filePath, set);
  }

  interface Accumulated {
    incoming: number;
    callers: RiskCaller[];
    crossCommunity: boolean;
  }
  const incoming = new Map<string, Accumulated>();
  for (const row of edgeRows) {
    const target = text(row.target);
    const symbol = symbols.get(target);
    if (symbol === undefined) continue;
    const caller: RiskCaller = {
      type: text(row.type),
      fromFile: text(row.sourceFile) === '' ? null : text(row.sourceFile),
      fromName: text(row.sourceName) === '' ? null : text(row.sourceName),
    };
    const current = incoming.get(target) ?? { incoming: 0, callers: [], crossCommunity: false };
    current.incoming += 1;
    if (current.callers.length < 5) current.callers.push(caller);
    if (!current.crossCommunity && symbol.community !== null && caller.fromFile !== null) {
      const callerCommunities = communitiesByFile.get(caller.fromFile);
      current.crossCommunity = callerCommunities !== undefined && !callerCommunities.has(symbol.community);
    }
    incoming.set(target, current);
  }

  const hits: Array<RiskSymbolHit & { kind: RiskFileKind }> = [];
  for (const [id, accumulated] of incoming) {
    const symbol = symbols.get(id);
    if (symbol === undefined) continue;
    hits.push({
      symbol,
      incoming: accumulated.incoming,
      callers: accumulated.callers,
      crossCommunity: accumulated.crossCommunity,
      kind: kindByPath.get(symbol.filePath) ?? 'modified',
    });
  }

  const compare = (a: RiskSymbolHit & { kind: RiskFileKind }, b: RiskSymbolHit & { kind: RiskFileKind }): number =>
    b.incoming - a.incoming ||
    Number(b.crossCommunity) - Number(a.crossCommunity) ||
    a.symbol.name.localeCompare(b.symbol.name);

  // A deleted (or renamed-away) file whose symbols still have callers is the only case this
  // query calls broken: the index still points at code that is no longer in the tree.
  const brokenHits = hits.filter((hit) => hit.kind === 'deleted').sort(compare);
  const exposedHits = hits.filter((hit) => hit.kind !== 'deleted').sort(compare);
  const matchedPaths = new Set([...symbols.values()].map((symbol) => symbol.filePath));
  const indexedFiles = await indexedFileSet(absRepo);
  const blind: RiskBlindSpot[] = capped
    .filter((file) => !matchedPaths.has(file.path))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      // `not-in-index` is a stronger statement than `no-symbols`, so it is only made when
      // the manifest actually lists files and this one is absent from that list.
      reason: indexedFiles !== null && !indexedFiles.has(file.path) ? ('not-in-index' as const) : ('no-symbols' as const),
    }));

  const trim = ({ symbol, incoming: count, callers, crossCommunity }: RiskSymbolHit & { kind: RiskFileKind }): RiskSymbolHit => ({
    symbol,
    incoming: count,
    callers,
    crossCommunity,
  });

  return {
    requested: ordered.length,
    matched: matchedPaths.size,
    filesTruncated: ordered.length > capped.length,
    truncated: brokenHits.length + exposedHits.length > brokenHits.slice(0, limit).length + exposedHits.slice(0, limit).length ||
      edgeRows.length >= EDGE_CAP ||
      symbolRows.length >= SYMBOL_CAP,
    symbols: symbolRows.length,
    edges: edgeRows.length,
    broken: brokenHits.slice(0, limit).map(trim),
    exposed: exposedHits.slice(0, limit).map(trim),
    blind,
    counts: {
      broken: brokenHits.length,
      exposed: exposedHits.length,
      blind: blind.length,
      crossCommunity: hits.filter((hit) => hit.crossCommunity).length,
    },
    notes,
  };
}
