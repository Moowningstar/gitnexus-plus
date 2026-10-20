/**
 * Keyword search over the graph GitNexus already indexed.
 *
 * WHY THIS DOES NOT USE FTS
 * -------------------------
 * GitNexus's keyword surface is its BM25/FTS extension. On this machine that
 * extension fails to load (`libfts.lbug_extension` is missing), and the existing
 * index was built with `--skip-fts`, so there are no FTS tables to query even if the
 * extension were present. Reporting "search unavailable" would be honest, but it
 * would also be the end of the feature for the state most users are in.
 *
 * The graph itself still contains every symbol's name and file path, and a Cypher
 * `CONTAINS` over those columns answers the question the user is actually asking
 * when they type a symbol name. This module therefore searches **names and paths**,
 * not source text or descriptions. That distinction is deliberate and surfaced to
 * the panel: an FTS repair can add content search later without this module
 * pretending it already has it.
 *
 * READ-ONLY, AND REUSING GITNEXUS'S OWN ADAPTER
 * ---------------------------------------------
 * The database is opened through GitNexus's `withLbugDb(..., { readOnly: true,
 * skipFts: true })`, so it takes no write lock, cannot mutate the index, and does not
 * attempt the FTS load that is known to fail here. The adapter is deep-imported from
 * the installed package, matching the plugin's existing "reuse, don't reimplement"
 * stance; if the package or its native engine is unavailable, search reports that
 * state rather than falling back to a filesystem scan with different semantics.
 */

import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ShellLike } from './analyze.js';
import { findGitnexusRoot } from './root.js';
import { isProjectRoot, readIndexMeta } from './index-meta.js';
import { readCapabilities } from './coverage.js';

/** One keyword hit, as the panel renders it. */
export interface SearchHit {
  /** Graph node label: Function, Class, Interface, Method, File, … */
  kind: string;
  name: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

/**
 * Where the results came from.
 *
 * `graph` is the normal LadybugDB name/path query. `text` is the bounded fallback
 * over the indexed source files, used when the native connection cannot be started
 * at all (for example, no usable host shell sandbox). The panel must say which one
 * it got: "found in source" and "found in the graph" are different promises.
 */
export type SearchMode = 'graph' | 'text';

/** The result of one keyword search. */
export interface SearchReport {
  /** The normalized query that was searched. */
  query: string;
  /** `graph` for the indexed graph; `text` for the source-file fallback. */
  mode: SearchMode;
  /** Whether the manifest says content-level FTS is available (informational). */
  ftsAvailable: boolean;
  results: SearchHit[];
  /** Number of rows returned, after the limit. */
  total: number;
  /** True when the limit may have cut the result set. */
  truncated: boolean;
  /** A user-facing caveat, or null. */
  warning: string | null;
}

export interface SearchOptions {
  /** 1–50, default 20. */
  limit?: number;
  /** The plugin-owned GitNexus prefix, when one was installed from the panel. */
  managedPrefix?: string;
  env?: NodeJS.ProcessEnv;
}

/** A failure the route can map to a status code without guessing. */
export type SearchErrorCode =
  | 'invalid-query'
  | 'not-a-project'
  | 'no-index'
  | 'no-index-store'
  | 'search-unavailable'
  | 'index-busy'
  | 'search-failed';

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly status: number;

  constructor(code: SearchErrorCode, status: number, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.status = status;
  }
}

/** The two members of GitNexus's adapter this module uses. */
interface LbugAdapter {
  withLbugDb: (
    dbPath: string,
    operation: () => Promise<unknown>,
    options?: { readOnly?: boolean; skipFts?: boolean },
  ) => Promise<unknown>;
  executePrepared: (cypher: string, params: Record<string, unknown>) => Promise<unknown[]>;
}

const adapters = new Map<string, LbugAdapter>();

/**
 * Load GitNexus's LadybugDB adapter from the installed package.
 *
 * A missing package, a missing native engine, or a reshaped adapter all become the
 * same reported state: search is unavailable here, and the reason is carried in the
 * message rather than hidden behind an empty result list.
 *
 * Exported for the graph projection (`./graph.ts`), which needs the same connection
 * and must not carry a second copy of this probe: the two would drift on exactly the
 * detail that is hardest to test — which install count as "present".
 */
export async function loadAdapter(options: SearchOptions): Promise<LbugAdapter> {
  const root = findGitnexusRoot({ env: options.env, managedPrefix: options.managedPrefix });
  if (root === null) {
    throw new SearchError(
      'search-unavailable',
      503,
      '找不到 GitNexus 包，无法打开图数据库。安装或指向 GitNexus 后重试。',
    );
  }
  const cached = adapters.get(root);
  if (cached !== undefined) {
    // The install can be removed or replaced while the host runs (uninstall, upgrade to
    // a tree with a different native build). Reusing the module bindings then points at
    // a package that no longer exists; one stat is cheaper than a stale handle.
    if (existsSync(root)) return cached;
    adapters.delete(root);
  }

  try {
    const mod = (await import(
      pathToFileURL(path.join(root, 'dist', 'core', 'lbug', 'lbug-adapter.js')).href
    )) as {
      withLbugDb?: unknown;
      executePrepared?: unknown;
    };
    if (typeof mod.withLbugDb !== 'function' || typeof mod.executePrepared !== 'function') {
      throw new Error('adapter does not export withLbugDb/executePrepared');
    }
    const adapter: LbugAdapter = {
      withLbugDb: mod.withLbugDb as LbugAdapter['withLbugDb'],
      executePrepared: mod.executePrepared as LbugAdapter['executePrepared'],
    };
    adapters.set(root, adapter);
    return adapter;
  } catch (cause) {
    throw new SearchError(
      'search-unavailable',
      503,
      `GitNexus 的图数据库适配器不可用：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Normalize a user keyword into a safe Cypher string literal body.
 *
 * The query is interpolated as a single-quoted literal because LadybugDB's prepare
 * path does not accept a bound parameter in this `CONTAINS` position (measured:
 * `lower(n.name) CONTAINS $q` fails at parse time, while the same query with a
 * literal works). Safety therefore comes from **removing** every character that
 * could terminate or escape the literal — quotes, backslashes and control
 * characters — rather than from escaping them. The allowed set is what a code
 * identifier or path search needs; everything else becomes a space.
 *
 * Case is lowered here to match `lower(n.name)` on the other side. The length cap
 * keeps a pathological paste from turning into an expensive graph scan.
 */
export function sanitizeSearchQuery(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_./:@#+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function clampLimit(value: number | undefined): number {
  const n = value === undefined || !Number.isFinite(value) ? 20 : Math.floor(value);
  return Math.max(1, Math.min(50, n));
}

function toLine(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function buildCypher(query: string, limit: number): string {
  // `query` has already been reduced to the safe literal alphabet by
  // sanitizeSearchQuery; the limit is a clamped integer. Neither is user-arbitrary
  // syntax at this point.
  return `
MATCH (n)
WHERE (lower(n.name) CONTAINS '${query}'
       OR (label(n) = 'File' AND lower(n.filePath) CONTAINS '${query}'))
RETURN label(n) AS kind, n.name AS name, n.filePath AS filePath,
       n.startLine AS startLine, n.endLine AS endLine,
       CASE WHEN lower(n.name) = '${query}' THEN 0
            WHEN lower(n.name) STARTS WITH '${query}' THEN 1
            WHEN label(n) = 'File' THEN 2
            ELSE 3 END AS rank
ORDER BY rank, name
LIMIT ${limit}
`;
}

function mapRows(rows: unknown[]): SearchHit[] {
  const results: SearchHit[] = [];
  for (const value of rows) {
    if (value === null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name : '';
    const filePath = typeof row.filePath === 'string' ? row.filePath : '';
    if (name === '' || filePath === '') continue;
    results.push({
      kind: typeof row.kind === 'string' && row.kind !== '' ? row.kind : 'Unknown',
      name,
      filePath,
      startLine: toLine(row.startLine),
      endLine: toLine(row.endLine),
    });
  }
  return results;
}

function isBusyMessage(message: string): boolean {
  return /busy|locked|lock held|another process|timeout/i.test(message);
}

/**
 * Search symbol names and file paths in one repository's index.
 *
 * @throws {SearchError} for states the route should report as status + code.
 */
export async function searchSymbols(
  repoPath: string,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchReport> {
  const query = sanitizeSearchQuery(rawQuery);
  if (query === '') {
    throw new SearchError('invalid-query', 400, '搜索词不能为空，且至少包含一个字母或数字。');
  }

  const absRepo = path.resolve(repoPath);
  if (!(await isProjectRoot(absRepo))) {
    throw new SearchError('not-a-project', 404, '目录不是 GitNexus 索引，也不是 git 项目根。');
  }

  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    throw new SearchError('no-index', 409, '该项目还没有 GitNexus 索引；初始化后才能搜索。');
  }

  const lbugPath = path.join(absRepo, '.gitnexus', 'lbug');
  if (!existsSync(lbugPath)) {
    throw new SearchError('no-index-store', 409, '索引缺少 .gitnexus/lbug 图存储，无法搜索。');
  }

  const adapter = await loadAdapter(options);
  const limit = clampLimit(options.limit);
  const cypher = buildCypher(query, limit);

  let rows: unknown[];
  try {
    // `skipFts` avoids the extension load that is known to fail on this machine;
    // `readOnly` keeps the search from taking a writer lock or creating anything.
    rows = (await adapter.withLbugDb(
      lbugPath,
      async () => adapter.executePrepared(cypher, {}),
      { readOnly: true, skipFts: true },
    )) as unknown[];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isBusyMessage(message)) {
      throw new SearchError('index-busy', 503, '索引正被另一个 GitNexus 操作占用，稍后重试。');
    }
    throw new SearchError('search-failed', 500, `图查询失败：${message}`);
  }

  const results = mapRows(rows);
  const capabilities = readCapabilities(meta.raw ?? null);
  const ftsAvailable = capabilities.fts?.status === 'available';
  return {
    query,
    mode: 'graph',
    ftsAvailable,
    results,
    total: results.length,
    truncated: results.length >= limit,
    warning: ftsAvailable
      ? null
      : 'FTS 内容检索不可用；本次按符号名与文件路径匹配，不搜索正文。',
  };
}

/** Options for the subprocess search. */
export interface HelperSearchOptions {
  /** The host's shell executor; `null` when the deployment has none. */
  shell: ShellLike | null;
  /** Absolute path to `lib/bin/search-helper.js`. */
  helperPath: string;
  /** The plugin-owned GitNexus prefix, when one was installed from the panel. */
  managedPrefix?: string;
  limit?: number;
}

function quoteFor(value: string): string {
  return process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse the helper's one-object stdout without assuming it is the very first byte.
 *
 * GitNexus or Node can write a warning to stdout before our payload. Taking the
 * first `{` to the last `}` is deliberately forgiving of that, while a missing
 * object still becomes a typed failure rather than an empty result.
 */
function parseHelperOutput(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function searchErrorCode(value: unknown): SearchErrorCode {
  switch (value) {
    case 'invalid-query':
    case 'not-a-project':
    case 'no-index':
    case 'no-index-store':
    case 'search-unavailable':
    case 'index-busy':
    case 'search-failed':
      return value;
    default:
      return 'search-failed';
  }
}

function asReport(value: unknown): SearchReport | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.results)) return null;
  const results: SearchHit[] = [];
  for (const item of raw.results) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.filePath !== 'string') continue;
    results.push({
      kind: typeof row.kind === 'string' ? row.kind : 'Unknown',
      name: row.name,
      filePath: row.filePath,
      startLine: toLine(row.startLine),
      endLine: toLine(row.endLine),
    });
  }
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    mode: raw.mode === 'text' ? 'text' : 'graph',
    ftsAvailable: raw.ftsAvailable === true,
    results,
    total: typeof raw.total === 'number' ? raw.total : results.length,
    truncated: raw.truncated === true,
    warning: typeof raw.warning === 'string' ? raw.warning : null,
  };
}

/**
 * Run the search in a child Node process.
 *
 * WHY A SUBPROCESS IS NOT OPTIONAL
 * --------------------------------
 * The DSH host runs on Electron's Node, and GitNexus's LadybugDB addon is built for
 * the system Node ABI. Loading it in the host fails with
 *
 *   A dynamic link library (DLL) initialization routine failed. …\lbugjs.node
 *
 * while the very same addon loads under the system Node 24 that the CLI uses. The
 * host therefore cannot own the native connection; it starts `node <helper>` and
 * parses one JSON object. That is the same execution boundary the analyze runner
 * already uses, and it keeps the panel process free of native state it cannot load.
 *
 * The command has no environment prefix: a short-lived helper does not need the
 * heap respawn guard, and avoiding `$env:` syntax keeps the command portable across
 * PowerShell, Git Bash and POSIX shells.
 */
export async function searchViaHelper(
  repoPath: string,
  rawQuery: string,
  options: HelperSearchOptions,
): Promise<SearchReport> {
  const query = sanitizeSearchQuery(rawQuery);
  if (query === '') {
    throw new SearchError('invalid-query', 400, '搜索词不能为空，且至少包含一个字母或数字。');
  }

  const absRepo = path.resolve(repoPath);
  if (!(await isProjectRoot(absRepo))) {
    throw new SearchError('not-a-project', 404, '目录不是 GitNexus 索引，也不是 git 项目根。');
  }
  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    throw new SearchError('no-index', 409, '该项目还没有 GitNexus 索引；初始化后才能搜索。');
  }
  if (!existsSync(path.join(absRepo, '.gitnexus', 'lbug'))) {
    throw new SearchError('no-index-store', 409, '索引缺少 .gitnexus/lbug 图存储，无法搜索。');
  }
  if (options.shell === null) {
    throw new SearchError(
      'search-unavailable',
      503,
      '当前部署没有 shell 执行器，无法启动搜索子进程；搜索需要系统 Node 24 加载 GitNexus 原生模块。',
    );
  }

  const limit = clampLimit(options.limit);
  const args = [options.helperPath, absRepo, query, String(limit), options.managedPrefix ?? '']
    .map(quoteFor)
    .join(' ');
  const command = `node ${args}`;

  let result: {
    exitCode?: number | null;
    timedOut?: boolean;
    stdout?: { text?: string } | null;
    stderr?: { text?: string } | null;
  };
  try {
    const spec = options.shell.resolve({
      command,
      workdir: absRepo,
      timeoutMs: 20_000,
      onExpiry: 'kill',
      stdoutMaxBytes: 2 * 1024 * 1024,
    });
    const execution = await options.shell.execute(spec);
    result = await execution.result();
  } catch (cause) {
    throw new SearchError(
      'search-unavailable',
      503,
      `无法启动搜索子进程：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (result.timedOut === true) {
    throw new SearchError('search-failed', 504, '搜索子进程超时（20 秒）。');
  }
  const stdout = typeof result.stdout?.text === 'string' ? result.stdout.text : '';
  const stderr = typeof result.stderr?.text === 'string' ? result.stderr.text : '';
  const parsed = parseHelperOutput(stdout);
  if (parsed === null) {
    const tail = stderr.trim().slice(-600);
    throw new SearchError(
      'search-failed',
      500,
      `搜索子进程没有返回可解析结果${
        result.exitCode === undefined ? '' : ` (exit ${String(result.exitCode)})`
      }` + (tail === '' ? '' : `：${tail}`),
    );
  }
  if (parsed.ok !== true) {
    const status = typeof parsed.status === 'number' ? parsed.status : 500;
    const message = typeof parsed.message === 'string' ? parsed.message : '搜索失败。';
    throw new SearchError(searchErrorCode(parsed.code), status, message);
  }
  const report = asReport(parsed.report);
  if (report === null) {
    throw new SearchError('search-failed', 500, '搜索子进程返回了无法识别的结果形状。');
  }
  return report;
}

/** Bounds for the source-text fallback. */
export interface TextSearchOptions {
  limit?: number;
  /** Files considered, newest order unspecified. Default 2000. */
  maxFiles?: number;
  /** Total bytes read across files. Default 16 MiB. */
  maxBytes?: number;
  /** One file larger than this is skipped. Default 1 MiB. */
  maxFileBytes?: number;
  /** The graph failure that caused this fallback, for the warning. */
  reason?: string;
}

const DEFAULT_TEXT_MAX_FILES = 2_000;
const DEFAULT_TEXT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TEXT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Bounded keyword search over the source files listed by the index.
 *
 * This exists for one concrete state: the host cannot start the native query path
 * (Electron ABI, no usable shell sandbox, busy database). In that state the index
 * manifest still names every file the index covers, and reading those files is
 * ordinary filesystem access the host already has. It is deliberately **not** a
 * hidden replacement for the graph search:
 *
 *   - it searches line text, so `mode` is `text` and the panel says so;
 *   - it only looks at files the index lists, so a brand-new untracked file is
 *     still absent until the index is refreshed;
 *   - every dimension is capped and `truncated` reports when a cap bit, because a
 *     silent partial result is the failure mode this whole project exists to avoid.
 *
 * It performs no spawn, no native load and no write.
 */
export async function searchText(
  repoPath: string,
  rawQuery: string,
  options: TextSearchOptions = {},
): Promise<SearchReport> {
  const query = rawQuery.normalize('NFC').trim().slice(0, 200);
  if (query === '') {
    throw new SearchError('invalid-query', 400, '搜索词不能为空。');
  }

  const absRepo = path.resolve(repoPath);
  if (!(await isProjectRoot(absRepo))) {
    throw new SearchError('not-a-project', 404, '目录不是 GitNexus 索引，也不是 git 项目根。');
  }
  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    throw new SearchError('no-index', 409, '该项目还没有 GitNexus 索引；初始化后才能搜索。');
  }

  const limit = clampLimit(options.limit);
  const maxFiles = Math.max(
    1,
    Math.min(5_000, Math.floor(options.maxFiles ?? DEFAULT_TEXT_MAX_FILES)),
  );
  const maxBytes = Math.max(
    64 * 1024,
    Math.min(256 * 1024 * 1024, Math.floor(options.maxBytes ?? DEFAULT_TEXT_MAX_BYTES)),
  );
  const maxFileBytes = Math.max(
    8 * 1024,
    Math.min(16 * 1024 * 1024, Math.floor(options.maxFileBytes ?? DEFAULT_TEXT_MAX_FILE_BYTES)),
  );

  const requested = Object.keys(meta.fileHashes ?? {});
  const warning = `图查询不可用${
    options.reason === undefined || options.reason.trim() === ''
      ? ''
      : `（${options.reason.trim().slice(0, 120)}）`
  }；已回退到索引文件的源码关键词搜索。结果来自文本，不是图谱。`;
  if (requested.length === 0) {
    return {
      query,
      mode: 'text',
      ftsAvailable: false,
      results: [],
      total: 0,
      truncated: false,
      warning: `图查询不可用；索引清单没有文件列表，无法回退到源码搜索。`,
    };
  }

  const lower = query.toLowerCase();
  const results: SearchHit[] = [];
  let bytesRead = 0;
  let truncated = requested.length > maxFiles;
  const prefix = absRepo.endsWith(path.sep) ? absRepo : `${absRepo}${path.sep}`;
  // A keyword in a README should not fill the result limit before the source file
  // that defines it. Code-bearing paths go first; path order breaks the tie.
  const codePath = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|c|cc|cpp|h|hpp|cs|rb|php|kt|swift|dart|vue|sh|ps1|sql)$/iu;
  const ordered = [...requested].sort((a, b) => {
    const aCode = codePath.test(a) ? 1 : 0;
    const bCode = codePath.test(b) ? 1 : 0;
    return bCode - aCode || a.localeCompare(b);
  });

  for (const relative of ordered.slice(0, maxFiles)) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (relative.includes('\0')) continue;
    const absolute = path.resolve(absRepo, relative);
    // The manifest is written by GitNexus, but it is still data at a boundary: do
    // not let a `../` entry turn the fallback into a read outside the project.
    if (!absolute.startsWith(prefix)) continue;

    let size: number;
    try {
      size = (await fs.stat(absolute)).size;
    } catch {
      continue;
    }
    if (size > maxFileBytes) {
      truncated = true;
      continue;
    }
    if (bytesRead + size > maxBytes) {
      truncated = true;
      break;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolute);
    } catch {
      continue;
    }
    bytesRead += buffer.length;
    // Binary files have no meaningful line text; git's own NUL-byte rule is enough.
    if (buffer.subarray(0, 8192).includes(0)) continue;

    const text = buffer.toString('utf8');
    if (!text.toLowerCase().includes(lower)) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      const line = lines[index];
      if (!line.toLowerCase().includes(lower)) continue;
      results.push({
        kind: 'Text',
        name: line.trim().slice(0, 160) || query,
        filePath: relative.replace(/\\/g, '/'),
        startLine: index + 1,
        endLine: index + 1,
      });
    }
  }

  return {
    query,
    mode: 'text',
    ftsAvailable: false,
    results,
    total: results.length,
    truncated,
    warning,
  };
}

/** Failures for which the source fallback is more useful than an error card. */
const FALLBACK_CODES: ReadonlySet<SearchErrorCode> = new Set([
  'search-unavailable',
  'search-failed',
  'index-busy',
  'no-index-store',
]);

/**
 * Graph first, then the bounded source fallback when the native path cannot run.
 *
 * The fallback is not attempted for an empty query, an unidentified project, or a
 * project with no index: in all three there is either nothing to search or no honest
 * denominator. Every other failure gets the text search, and its report carries
 * `mode: "text"` plus the graph failure in `warning`.
 *
 * Results are memoized for a minute. Each search is a Node cold start plus a native
 * open, which is the most expensive single interaction in the panel, and the same query
 * is re-run on every submit/back-navigation. The index file's mtime is part of the key,
 * so a refresh invalidates the cache without any wiring.
 */
const SEARCH_CACHE_MAX = 16;
const SEARCH_CACHE_TTL_MS = 60_000;
const searchCache = new Map<string, { at: number; report: SearchReport }>();

function searchCacheKey(repoPath: string, query: string, limit: number): string | null {
  try {
    const absRepo = path.resolve(repoPath);
    const mtime = statSync(path.join(absRepo, '.gitnexus', 'gitnexus.json')).mtimeMs;
    return [absRepo, query.toLowerCase(), limit, mtime].join('\u0000');
  } catch {
    return null;
  }
}

function rememberSearch(key: string, report: SearchReport): void {
  searchCache.delete(key);
  searchCache.set(key, { at: Date.now(), report });
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

/**
 * Searches already running, so a double submit joins the first one instead of paying
 * for a second helper process. The cache catches the same query after it completes;
 * this catches it while it is still in flight.
 *
 * A resident helper (one process, a line protocol over stdin/stdout) would remove the
 * cold start entirely, but the platform's shell executor is one-shot — `execute` gives
 * a handle with `result()` and no stdin channel — and spawning a long-lived child
 * directly would step outside the sandbox this plugin deliberately lives in.
 */
const inFlightSearches = new Map<string, Promise<SearchReport>>();

export async function searchWithFallback(
  repoPath: string,
  rawQuery: string,
  options: HelperSearchOptions,
): Promise<SearchReport> {
  const sanitized = sanitizeSearchQuery(rawQuery);
  const limit = clampLimit(options.limit);
  const cacheKey = sanitized === '' ? null : searchCacheKey(repoPath, sanitized, limit);
  if (cacheKey !== null) {
    const hit = searchCache.get(cacheKey);
    if (hit !== undefined && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.report;
    const running = inFlightSearches.get(cacheKey);
    if (running !== undefined) return running;
  }

  const remember = (report: SearchReport): SearchReport => {
    if (cacheKey !== null) rememberSearch(cacheKey, report);
    return report;
  };
  const run = (async (): Promise<SearchReport> => {
    try {
      return remember(await searchViaHelper(repoPath, rawQuery, options));
    } catch (error) {
      if (error instanceof SearchError && FALLBACK_CODES.has(error.code)) {
        return remember(
          await searchText(repoPath, rawQuery, {
            limit: options.limit,
            reason: error.message,
          }),
        );
      }
      throw error;
    }
  })();

  if (cacheKey !== null) {
    inFlightSearches.set(cacheKey, run);
    void run.finally(() => inFlightSearches.delete(cacheKey)).catch(() => {
      /* the caller owns the rejection; this chain only cleans the map */
    });
  }
  return run;
}
