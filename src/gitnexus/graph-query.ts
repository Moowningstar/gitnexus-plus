/**
 * The graph tools an agent may call, run out of process.
 *
 * WHY A HELPER AND NOT AN IN-PROCESS CALL
 * --------------------------------------
 * GitNexus's own MCP backend (`dist/mcp/local/local-backend.js`) is the only thing that
 * knows how to answer `impact`, `context` and `query` — re-implementing those traversals
 * would be a second, divergent engine. It loads LadybugDB, a native addon, and this
 * host is Electron's Node: the ABI does not match. So the same boundary the graph
 * projection already uses (see `graph.ts`) applies here — the host names the helper,
 * the system Node runs it, and only JSON comes back.
 *
 * WHY ONE HELPER FOR THREE TOOLS
 * ------------------------------
 * A cold start costs ~600 ms (node + registry + adapter), and a model asked to change a
 * symbol will usually want `context` and then `impact`. One helper per *call* keeps the
 * failure modes local — a query that faults the native store takes down a short-lived
 * child, never the panel — while one helper implementation means one place to get the
 * protocol right.
 *
 * WHY THE REQUEST IS A FILE
 * -------------------------
 * A symbol name is caller-supplied text. It may contain spaces, quotes, `$`, or a
 * newline, and every shell quoting rule is one more thing to get wrong. A path in argv
 * plus a JSON body in a file has no quoting rules at all.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultGitnexusHome } from './commands.js';
import { isProjectRoot, readIndexMeta } from './index-meta.js';
import { exitDetail, parseHelperOutput, type ShellLike } from '../shell.js';
import { shellRunner, type Runner } from '../subprocess.js';
import { registryHasRepo, registryHomesFor } from './webview-probe.js';

/** The graph tools this plugin exposes. Anything else is refused, not guessed. */
export type GraphToolName = 'impact' | 'context' | 'query';

export const GRAPH_TOOLS: readonly GraphToolName[] = ['impact', 'context', 'query'];

/** Why a graph call could not answer. Every case is expected, none is a crash. */
export type GraphToolErrorCode =
  | 'not-a-project'
  | 'no-index'
  | 'no-shell'
  | 'gitnexus-missing'
  | 'tool-failed'
  | 'bad-output'
  /** The caller's signal fired; the helper was stopped and the answer discarded. */
  | 'cancelled';

export interface GraphToolFailure {
  ok: false;
  code: GraphToolErrorCode;
  message: string;
}

export interface GraphToolSuccess {
  ok: true;
  tool: GraphToolName;
  /** The upstream payload, unmodified. Rendering and budgets happen in the caller. */
  result: unknown;
}

export type GraphToolOutcome = GraphToolSuccess | GraphToolFailure;

export interface GraphToolOptions {
  /** `null` when the deployment has no shell executor: nothing can be spawned. */
  shell: ShellLike | null;
  /**
   * The plugin's process runner, when one was built from the host's seams.
   *
   * Optional so every existing caller and test keeps working: without it the runner is
   * built over `shell` alone, which is exactly the path 0.1.7 shipped. With it, the
   * helper goes out as `argv` through `ctx.subprocess` when the host has that seam.
   */
  runner?: Runner | null;
  /** Absolute path to `lib/bin/graph-query-helper.js`. */
  helperPath: string;
  /** The operator's `gitnexusHome`, when set. Empty means "resolve it". */
  gitnexusHome?: string;
  timeoutMs?: number;
  /** Same repository-rooted policy every other spawn uses; see `src/index.ts`. */
  sandboxPolicy?: (repoPath: string) => unknown;
  /** The tool body's `exec.signal`, forwarded so a cancelled call stops its helper. */
  signal?: AbortSignal;
}

/** A cold helper start measures ~600 ms; 20 s is generous and still bounded. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** One payload of this size is already 30-60 KB of JSON; the host caps it. */
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;

const MESSAGES: Record<GraphToolErrorCode, string> = {
  'not-a-project': '目录不是 GitNexus 索引，也不是 git 项目根。',
  'no-index': '该项目还没有 GitNexus 索引；初始化后才能问图。',
  'no-shell': '当前部署没有 shell 执行器，无法启动查图子进程；查图需要系统 Node 加载 GitNexus 原生模块。',
  'gitnexus-missing': '找不到 gitnexus 包；装好后才能查图。',
  'tool-failed': '查图子进程失败。',
  'bad-output': '查图子进程没有返回可解析结果。',
  cancelled: '这次查图被取消了。',
};

function failure(code: GraphToolErrorCode, detail?: string): GraphToolFailure {
  const base = MESSAGES[code];
  return { ok: false, code, message: detail === undefined || detail === '' ? base : `${base}${detail}` };
}

/**
 * The registry home that can actually resolve this repository.
 *
 * A tool call is answered through the registry the helper inherits: `LocalBackend`
 * loads `<GITNEXUS_HOME>/registry.json` and resolves `?repo=` inside it. Asking the
 * default home about an index this plugin built finds nothing, because the plugin keeps
 * its indexes under `<repo>/.gitnexus/plugin-home`. So the home is chosen by evidence —
 * the first one that holds this repository — and only then falls back to the plugin's
 * own default.
 */
export async function resolveToolHome(repoPath: string, configured?: string): Promise<string> {
  const homes = registryHomesFor(repoPath, configured);
  for (const home of homes) {
    if (await registryHasRepo(home, repoPath)) return home;
  }
  return configured !== undefined && configured !== '' ? configured : defaultGitnexusHome(repoPath);
}

/**
 * Run one graph tool.
 *
 * Resolves the repository first: a call against a directory with no index is a normal
 * answer ("index this first"), not a helper launch that fails 600 ms later.
 */
export async function runGraphTool(
  repoPath: string,
  tool: GraphToolName,
  params: Record<string, unknown>,
  options: GraphToolOptions,
): Promise<GraphToolOutcome> {
  const absRepo = path.resolve(repoPath);
  if (!(await isProjectRoot(absRepo))) return failure('not-a-project');
  const meta = await readIndexMeta(absRepo);
  if (meta === null) return failure('no-index');
  if (!existsSync(path.join(absRepo, '.gitnexus', 'lbug'))) {
    return failure('no-index', '索引缺少 .gitnexus/lbug 图存储。');
  }
  const runner = options.runner ?? (options.shell === null ? null : shellRunner(options.shell));
  if (runner === null) return failure('no-shell');

  const home = await resolveToolHome(absRepo, options.gitnexusHome);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A private directory so two concurrent calls cannot read each other's request.
  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-plus-query-'));
  } catch (error) {
    return failure('tool-failed', `无法创建临时目录：${describe(error)}`);
  }

  try {
    const requestFile = path.join(dir, 'request.json');
    await writeFile(requestFile, JSON.stringify({ repo: absRepo, tool, params }), 'utf8');

    const env: Array<readonly [string, string]> = [];
    if (home !== '') env.push(['GITNEXUS_HOME', home]);
    const sandboxPolicy = options.sandboxPolicy?.(path.join(absRepo, '.gitnexus'));

    // `argv[0]` is `node` on both paths: the shell path quotes the two paths after it,
    // the argv path resolves `node` to an absolute executable first.
    const run = await runner.run({
      argv: ['node', options.helperPath, requestFile],
      cwd: absRepo,
      env,
      timeoutMs,
      maxBytes: STDOUT_LIMIT_BYTES,
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (run.kind === 'cancelled') return failure('cancelled');
    if (run.kind === 'spawn-failed') return failure('tool-failed', `无法启动子进程：${run.message}`);
    if (run.kind === 'timed-out') return failure('tool-failed', `查图子进程超时（${Math.round(timeoutMs / 1000)} 秒）。`);

    const parsed = parseHelperOutput(run.stdout);
    if (parsed === null) return failure('bad-output', exitDetail(run.exitCode, run.stderr));
    if (parsed.ok !== true) {
      const code = parsed.code === 'gitnexus-missing' ? 'gitnexus-missing' : 'tool-failed';
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      return failure(code, `（${message}）`);
    }
    return { ok: true, tool, result: parsed.result };
  } catch (error) {
    return failure('tool-failed', `：${describe(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
