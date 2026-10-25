/**
 * dsh-gitnexus-plus — host half.
 *
 * Registers five read-only tools and ten loopback HTTP routes over the index in
 * `./gitnexus/`. The tools answer what a model would otherwise grep for — "what did
 * this index leave out?", "what breaks if I change this symbol?", "which flow
 * implements this concept?" — and the routes render the same answers for the
 * browser half, plus the handful of operations the panel performs itself.
 *
 * The read path is still never allowed to change anything: a status check must not
 * start a 30-second rebuild. The mutating capabilities (refresh, repair-fts,
 * install, the web view's lifecycle) are separate routes with their own guards,
 * and they reach the operating system through the host's process seams rather
 * than spawning from the read path.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { analyzeCoverage, type CoverageProgress, type CoverageReport } from './gitnexus/coverage.js';
import { formatReport } from './gitnexus/format.js';
import {
  commandRationale,
  defaultGitnexusHome,
  effectiveSkipFts,
  ftsAvailable,
  maintenanceCommands,
  type MaintenanceCommand,
} from './gitnexus/commands.js';
import { mountCoverageRoute } from './routes/coverage.js';
import { mountProjectsRoute } from './routes/projects.js';
import { mountAnalyzeRoute } from './routes/analyze.js';
import { mountInstallRoute } from './routes/install.js';
import { mountSearchRoute } from './routes/search.js';
import { mountFileHistoryRoute } from './routes/file-history.js';
import { mountFileDiffRoute } from './routes/file-diff.js';
import { mountDeltaRoute } from './routes/delta.js';
import { mountGraphRoute } from './routes/graph.js';
import { mountWebViewRoute } from './routes/webview.js';
import { hasGitMarker } from './gitnexus/index-meta.js';
import { readCommitDiff, readFileActivity } from './gitnexus/git-activity.js';
import { describeDelta, readDelta } from './gitnexus/delta.js';
import { provideGitSeams } from './gitnexus/git-capture.js';
import { projectViaHelper } from './gitnexus/graph.js';
import { runGraphTool, type GraphToolName } from './gitnexus/graph-query.js';
import { renderTool } from './gitnexus/graph-query-render.js';
import { searchWithFallback } from './gitnexus/search.js';
import { createAnalyzeRunner } from './gitnexus/analyze.js';
import type { ShellLike } from './shell.js';
import { createRunner, isSandboxLike, isSubprocessLike, type Runner } from './subprocess.js';
import { createInstallRunner, defaultInstallPrefix } from './gitnexus/install.js';
import { createWebViewRunner } from './gitnexus/webview.js';

/**
 * Whether a service resolved from the context has the shape the runner needs.
 *
 * `ctx.get` is untyped here —the DSH packages ship no declarations, so the service
 * arrives as `unknown`. Checking the two methods the runner actually calls is the
 * narrowest claim that can be made: asserting the full `ctx.shell` contract from this
 * side would be a guess, and a wrong guess fails at the first click rather than here.
 */
function isShellLike(value: unknown): value is ShellLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { resolve?: unknown; execute?: unknown };
  return typeof candidate.resolve === 'function' && typeof candidate.execute === 'function';
}

export const name = 'gitnexus-plus';

/**
 * Only `tools` is required. `webServer` is reached through `ctx.inject` because a
 * headless profile has no HTTP carrier at all —naming it here would leave the
 * plugin permanently pending there, and the tool would never register.
 */
export const inject = ['tools'] as const;

/** The shape `Schema.object` infers below, named for use in signatures. */
export interface PluginConfig {
  scanDefaultCapKb: number;
  minifiedSampleLimit: number;
  serveRoutes: boolean;
  /**
   * Shapes the maintenance commands the panel hands to the operator. `memoryOff`
   * defaults on because the CLI otherwise re-spawns itself over piped stdio, which
   * a confined process denies.
   *
   * `skipFts: false` (default) means **automatic**: the plugin skips FTS when the
   * index does not have it, and omits the flag when it does. Both static values were
   * measured wrong on a real machine: `true` forces a 21x full rebuild on an FTS
   * index, while an unconditional `false` makes a refresh on a non-FTS index die
   * with `spawn EPERM` when the extension tries to install out-of-process. `true`
   * here forces the flag for an operator who needs it.
   */
  skipFts: boolean;
  memoryOff: boolean;
  analyzeHeapMb: number;
  /**
   * Wall-clock ceiling for a run this plugin starts.
   *
   * Ten minutes, because the escape hatch this panel offers is a full rebuild and
   * those are measured in minutes on a large repository. Too short a ceiling turns
   * the feature into "it always times out on the repos that need it most"; the run
   * is cancellable, so the cost of it being generous is bounded by the operator.
   */
  analyzeTimeoutMs: number;
  /**
   * Where the plugin installs GitNexus when asked. Empty means the default,
   * `$DSH_HOME/gitnexus-plus/gitnexus`.
   */
  gitnexusInstallDir: string;
  /** Wall-clock ceiling for that install. Compiling native modules is slow. */
  installTimeoutMs: number;
  /**
   * First port the GitNexus web server is offered.
   *
   * 4747 is the CLI's own default, so an operator who already runs `gitnexus serve`
   * gets that server adopted instead of a second one on an unexpected port. When the
   * port is free the plugin takes it; when it is held by something that cannot see
   * this repository, the following few ports are tried.
   */
  webViewPort: number;
  /**
   * Redirect for GitNexus's global registry write. Empty means
   * `<project>/.gitnexus/plugin-home`, inside the workspace. The global
   * `~/.gitnexus` is outside a confined host's writable scope, and a refresh that
   * dies on the registry write leaves the index incomplete.
   */
  gitnexusHome: string;
  /**
   * Whether the three graph tools are registered: `gitnexus_impact`,
   * `gitnexus_context`, `gitnexus_query`.
   *
   * On by default, because the whole point of an index is that an agent can ask it
   * instead of grepping. It is a switch rather than an always-on registration so a
   * deployment where spawning a helper for every question is unwelcome can turn the
   * surface off completely and keep the coverage/delta tools, which need no child
   * process.
   */
  graphTools: boolean;
  /**
   * Wall-clock ceiling for one graph tool call.
   *
   * A cold helper start — node, the registry, the native store, then the traversal —
   * measured ~600 ms on this machine, and a query over a large repository is the slow
   * case rather than the common one. Twenty seconds is a ceiling for a graph that
   * stopped answering, not a budget the normal path spends.
   */
  graphToolTimeoutMs: number;
}

export const Config = Schema.object({
  scanDefaultCapKb: Schema.natural().default(512),
  minifiedSampleLimit: Schema.natural().default(40),
  serveRoutes: Schema.boolean().default(true),
  skipFts: Schema.boolean().default(false),
  memoryOff: Schema.boolean().default(true),
  analyzeHeapMb: Schema.natural().default(8192),
  analyzeTimeoutMs: Schema.natural().default(600000),
  gitnexusInstallDir: Schema.string().default(''),
  installTimeoutMs: Schema.natural().default(1200000),
  webViewPort: Schema.natural().default(4747),
  gitnexusHome: Schema.string().default(''),
  graphTools: Schema.boolean().default(true),
  graphToolTimeoutMs: Schema.natural().default(20000),
});

/**
 * Compile-time proof that the schema and {@link PluginConfig} describe the same
 * object.
 *
 * These are two independent declarations of one contract —`Schema.object` infers a
 * shape, and `apply` is written against a hand-written interface —so without this
 * they can drift, and the drift is silent: a config key added to the schema but not
 * the interface is simply unreadable from `apply`, and one added to the interface
 * but not the schema is `undefined` at runtime. The check is bidirectional, because
 * either direction of drift is a real bug.
 */
type ConfigShapeMatches = ReturnType<typeof Config> extends PluginConfig
  ? PluginConfig extends ReturnType<typeof Config>
    ? true
    : never
  : never;
const configShapeMatches: ConfigShapeMatches = true;
void configShapeMatches;

/** The maintenance payload the panel renders alongside a report. */
export interface MaintenanceInfo {
  commands: MaintenanceCommand[];
  rationale: string[];
  /**
   * Whether the mounted analyze route understands `force=1`. The client uses it to
   * avoid offering a full-rebuild button against an older host, where that flag was
   * ignored and the button would silently run an incremental refresh instead.
   */
  supportsForce: true;
  /**
   * Whether this host understands `mode=repair-fts` and offers the repair command.
   * Same job as `supportsForce`: a client that hot-reloaded ahead of the host must not
   * render a control the route would silently treat as a plain refresh.
   */
  supportsRepair: true;
  /**
   * Whether the directory has no `.git`, so every command carries `--skip-git`.
   *
   * The client uses it to stop calling the normal action an "incremental refresh":
   * GitNexus disables incremental updates for an index without a commit baseline.
   */
  skipGit: boolean;
}

/** What the `gitnexus_coverage` tool returns to the model. */
interface CoverageToolResult {
  text: string;
  indexed: boolean;
  largeFileCount: number;
  largeBytes: number;
  warnings: Array<{ level: string; code: string; message: string }>;
}

/** Arguments the model supplies to `gitnexus_coverage`. */
interface CoverageToolArgs {
  repo: string;
  includeLanguages?: boolean;
}

/** Arguments the model supplies to `gitnexus_delta`. */
interface DeltaToolArgs {
  repo: string;
}

/** What the `gitnexus_delta` tool returns to the model. */
interface DeltaToolResult {
  text: string;
  comparable: boolean;
  /**
   * Whether the verdict is anchored to the index's commit. `false` means the working
   * tree is clean but the index may still predate the current commit — a `needsRefresh:
   * false` must not be read as "the index is current" in that case.
   */
  certain: boolean;
  needsRefresh: boolean;
  modified: number;
  added: number;
  deleted: number;
  excluded: number;
}

/** Arguments the model supplies to `gitnexus_impact`. */
interface ImpactToolArgs {
  repo: string;
  target: string;
  direction?: 'upstream' | 'downstream';
  maxDepth?: number;
  summaryOnly?: boolean;
  limit?: number;
  minConfidence?: number;
}

/**
 * Arguments the model supplies to `gitnexus_context`.
 *
 * `name` is not required because a symbol can be identified three ways: a name (the
 * usual case), a `uid` printed by an earlier `gitnexus_query`, or a file path. The
 * schema language cannot say "at least one of", so the body checks it.
 */
interface ContextToolArgs {
  repo: string;
  name?: string;
  uid?: string;
  file_path?: string;
  kind?: string;
  include_content?: boolean;
}

/** Arguments the model supplies to `gitnexus_query`. */
interface QueryToolArgs {
  repo: string;
  search_query: string;
  goal?: string;
  task_context?: string;
  limit?: number;
  max_symbols?: number;
}

/**
 * What all three graph tools return.
 *
 * `ok` is spare but load-bearing: a model that only reads `text` should still be able
 * to tell a refusal ("there is no index") from an answer that happens to be short.
 */
interface GraphToolResult {
  text: string;
  ok: boolean;
  result: unknown;
}

/**
 * The output schema shared by the three graph tools.
 *
 * `result` is passed through unmodified — it is the upstream payload, including the
 * `epistemic`/`boundaries` envelope — so a host that wants structured access does not
 * have to parse the rendered text. `render` sends only `text`, because that is what a
 * model reads and the payload can be tens of kilobytes.
 */
const graphToolOutput = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      text: { type: 'string', required: true },
      ok: { type: 'boolean', required: true },
      result: { type: 'json' },
    },
  },
  render: (_args: unknown, value: GraphToolResult) => [{ type: 'text', text: value.text }],
} as const;

export function apply(ctx: Context, config: PluginConfig): void {
  const cache = new Map<string, { at: number; report: CoverageReport }>();
  const CACHE_TTL_MS = 15_000;
  // A long session touches many repositories, and each entry holds a full report —
  // file lists, samples, activity. Entries used to live forever; eight recent
  // repositories is more than the panel can show at once, and stale ones are dropped
  // on write.
  const CACHE_MAX = 8;

  /** Store a report, pruning expired entries first and the oldest beyond the cap after. */
  const rememberCoverage = (key: string, report: CoverageReport, at: number): void => {
    const now = Date.now();
    for (const [other, entry] of cache) {
      if (now - entry.at >= CACHE_TTL_MS) cache.delete(other);
    }
    cache.delete(key);
    cache.set(key, { at, report });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /**
   * The one install location, resolved once and shared by every path that needs to
   * know it. This was the broken link in "install, then initialize": the installer
   * wrote a plugin-owned tree under DSH_HOME, while the coverage engine and the
   * analyze runner probed only PATH and the declared dependency. On a machine with
   * no global GitNexus the install succeeded and then *nothing used it* — the panel
   * still reported "absent" and the refresh still said "no CLI". Passing the same
   * prefix to all three (reader, language detector, runner) is what makes the
   * install a prerequisite rather than an isolated side effect.
   */
  const installPrefix =
    config.gitnexusInstallDir === '' ? defaultInstallPrefix() : config.gitnexusInstallDir;
  const managedToolchain = { managedPrefix: installPrefix };
  // Resolved at boot so a search never depends on the host's working directory. The
  // file is run by the system Node (see `searchViaHelper`); this process only names it.
  const searchHelperPath = fileURLToPath(new URL('./bin/search-helper.js', import.meta.url));
  // Same execution boundary for the graph projection: the native store cannot load in
  // this process, so the query runs in the helper and only JSON comes back.
  const graphHelperPath = fileURLToPath(new URL('./bin/graph-helper.js', import.meta.url));

  // The query helper shares that boundary but answers the three model-facing
  // questions (`impact`, `context`, `query`) through GitNexus's own MCP backend
  // instead of a projection. See `./gitnexus/graph-query.ts` for why.
  const graphQueryHelperPath = fileURLToPath(new URL('./bin/graph-query-helper.js', import.meta.url));

  /**
   * The shell executor, resolved per call rather than at boot.
   *
   * `shell` is mounted per profile and is not part of `inject`: a headless deployment
   * without one must still get the two read-only tools that never spawn anything. The
   * graph tools therefore resolve it at call time and answer `no-shell` instead of
   * failing to register.
   */
  const shellFor = (): ShellLike | null => {
    const raw: unknown = ctx.get('shell');
    return isShellLike(raw) ? raw : null;
  };

  /**
   * The process runner for one call, built from whichever seams this profile mounts.
   *
   * Resolved per call for the same reason `shellFor` is: `subprocess` and `sandbox` are
   * optional services, and a deployment without them must keep working unchanged. The
   * runner decides which path a spawn takes — `argv` through `ctx.subprocess` when the
   * host exposes it (confined through `ctx.sandbox` when a policy is present), otherwise
   * the `ctx.shell` command this plugin has shipped since 0.1.2. See
   * `src/subprocess.ts` for why "degrade, never fail" is the rule there.
   */
  const runnerFor = (shell: ShellLike | null): Runner => {
    const subprocessRaw: unknown = ctx.get('subprocess');
    const sandboxRaw: unknown = ctx.get('sandbox');
    return createRunner({
      subprocess: isSubprocessLike(subprocessRaw) ? subprocessRaw : null,
      sandbox: isSandboxLike(sandboxRaw) ? sandboxRaw : null,
      shell,
    });
  };

  // `git` is read by four modules that hold no host context of their own (anchoring, the
  // delta gate, the git state card, the activity list), so the seams reach them as a
  // provider read at call time rather than a value captured here: a profile may mount
  // `subprocess` after this plugin applies. Clearing it on dispose keeps a reloaded
  // plugin from keeping a stale host object alive. See `gitnexus/git-capture.ts`.
  provideGitSeams(() => ({ subprocess: ctx.get('subprocess'), sandbox: ctx.get('sandbox') }));
  ctx.effect(
    () => () => {
      provideGitSeams(null);
    },
    'gitnexus-plus: git process seams',
  );

  /**
   * The sandbox policy for one repository, with the workspace root this route knows
   * and the deployment's own mode.
   *
   * WHY THIS IS NOT ESCALATION
   * --------------------------
   * A panel route has no session, so `sandboxPolicy.resolve()` falls back to
   * `config.workspaceRoot ?? process.cwd()` — the DSH application directory. The
   * sandbox derives its write-capability SID from that path, so the repository's
   * grant never applies and every write inside `.gitnexus` is refused. Measured on a
   * Windows deployment: the ACE on the repository is exactly the one the sandbox
   * derives from that path (`workspaceWriteSid(<repository path>)`).
   *
   * This function therefore forwards the deployment's resolved policy and replaces
   * only the root with the repository the caller named. The **mode** is never
   * touched: read-only stays read-only, and a deployment without a policy service
   * keeps the executor's own default. What it adds is the one input the agentless
   * route cannot otherwise supply. It is used by every spawn this plugin starts for
   * a repository: analyze, the search helper, the graph helper and the query helper.
   * Without it the helpers inherit the application directory, and on Windows the ACL
   * runner fails before the helper starts (`SetNamedSecurityInfoW … grantWrite(<app
   * dir>)`).
   */
  const sandboxPolicyForRoot = (repoPath: string): unknown => {
    const raw: unknown = ctx.get('sandboxPolicy');
    if (raw === null || typeof raw !== 'object') return undefined;
    const service = raw as { resolve?: () => unknown };
    if (typeof service.resolve !== 'function') return undefined;
    let base: unknown;
    try {
      base = service.resolve();
    } catch {
      return undefined;
    }
    if (base === null || typeof base !== 'object') return undefined;
    const policy = base as { mode?: unknown; workspaceRoot?: unknown };
    if (typeof policy.mode !== 'string') return undefined;
    // The capability SID is derived from this exact string, so it has to be the
    // canonical path — the same one a session call would carry.
    let root = path.resolve(repoPath);
    try {
      root = realpathSync.native(root);
    } catch {
      /* the resolved path is the best available canonical form */
    }
    return { ...(base as Record<string, unknown>), workspaceRoot: root };
  };

  /**
   * Resolve a coverage report, from cache when it is recent enough.
   *
   * Scan results are pure functions of the working tree, so a short TTL removes the
   * repeated cost of a 28k-file walk without ever showing a stale verdict to a caller
   * who just changed something.
   *
   * `fresh` bypasses the TTL. A manual refresh is an explicit instruction from a
   * person who believes the numbers may have moved, and answering it with a cached
   * copy makes the control look broken —which is exactly how it was reported. A
   * background poll is the case the TTL exists for; a click is not.
   */
  const coverageFor = async (
    repoPath: string,
    options: { fresh?: boolean; onProgress?: (progress: CoverageProgress) => void } = {},
  ): Promise<CoverageReport> => {
    const key = String(repoPath);
    if (options.fresh !== true) {
      const hit = cache.get(key);
      if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
    }
    const report = await analyzeCoverage(key, {
      minifiedSampleLimit: config.minifiedSampleLimit,
      toolchain: managedToolchain,
      onProgress: options.onProgress,
    });
    rememberCoverage(key, report, Date.now());
    return report;
  };

  /**
   * The maintenance commands, resolved at the boundary rather than inside
   * `analyzeCoverage`: they depend on this plugin's config, and the report is a
   * pure function of the repository.
   */
  const maintenanceFor = (repoPath: string): MaintenanceInfo => {
    // Read once: the repair command is offered only when the index itself says FTS is
    // missing, so an operator never sees "repair" as a permanent third button that
    // does nothing. `ftsAvailable` reads the manifest synchronously; the coverage
    // engine has already read the same file for this request.
    const hasFts = ftsAvailable(repoPath);
    const options = {
      // `skipFts: false` means automatic, not "attempt FTS": if the index has no FTS,
      // attempting the install dies with `spawn EPERM` in a confined host.
      skipFts: effectiveSkipFts(repoPath, config.skipFts),
      // A plain folder is indexable, but only through `--skip-git`; without it
      // GitNexus refuses the explicit path before it reads anything else.
      skipGit: !hasGitMarker(repoPath),
      memoryOff: config.memoryOff,
      // Default to a plugin-owned home inside the project so the global registry
      // write stays within the workspace. The explicit config still wins.
      gitnexusHome: config.gitnexusHome === '' ? defaultGitnexusHome(repoPath) : config.gitnexusHome,
      includeRepair: !hasFts,
    };
    return {
      commands: maintenanceCommands(repoPath, options),
      rationale: commandRationale(options),
      supportsForce: true,
      supportsRepair: true,
      skipGit: options.skipGit,
    };
  };

  ctx.tools.register(
    defineTool<CoverageToolArgs, CoverageToolResult>({
      name: 'gitnexus_coverage',
      description:
        'Report what a GitNexus index omitted for a repository: files skipped for exceeding the ' +
        'size cap, oversized generated/minified output that inflates a language share, and files ' +
        'a fresh scan would select but the index does not cover. A directory without git or an ' +
        'index is described from a scan-only report. Read-only; never triggers a re-index. Use it ' +
        'to judge how much of a repository the index actually represents before trusting graph ' +
        'queries.',
      parameters: {
        repo: {
          type: 'string',
          required: true,
          description:
            'Absolute path to the repository root or working directory to describe ' +
            '(the directory containing .gitnexus, .git, or neither).',
        },
        includeLanguages: {
          type: 'boolean',
          description: 'Include the per-language byte breakdown in the result. Defaults to true.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            // `required: true` per property, never `required: [...]`. The DSL's
            // compiler rejects the array form outright —it collects these marks
            // into the JSON Schema `required` list itself.
            text: { type: 'string', required: true },
            indexed: { type: 'boolean', required: true },
            largeFileCount: { type: 'integer', required: true },
            largeBytes: { type: 'integer', required: true },
            warnings: { type: 'array' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const report = await coverageFor(args.repo);
        return {
          text: formatReport(report, args.includeLanguages !== false),
          indexed: report.repo.indexed,
          largeFileCount: report.totals.large,
          largeBytes: report.totals.largeBytes,
          warnings: report.warnings.map((w) => ({ level: w.level, code: w.code, message: w.message })),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `GitNexus coverage · ${String(args.repo).split(/[\\/]/).pop()}`,
        kind: 'read',
      }),
    }),
  );

  /**
   * The "should I refresh?" tool.
   *
   * Separate from `gitnexus_coverage` rather than a flag on it: coverage is a scan of
   * the working tree and costs a walk over every file, while this one hashes only the
   * files git says differ from the indexed commit — usually none. They answer
   * different questions at different costs, and the model should be able to ask the
   * cheap one first.
   */
  ctx.tools.register(
    defineTool<DeltaToolArgs, DeltaToolResult>({
      name: 'gitnexus_delta',
      description:
        'Compare a repository working tree with what its GitNexus index recorded (sha256 per file, ' +
        'read from .gitnexus/gitnexus.json) and report whether a refresh would change anything. ' +
        'Returns modified/added/deleted file lists without running the analyzer; a clean tree ' +
        'returns needsRefresh=false in milliseconds. Check `certain` before concluding the index ' +
        'is current: when the manifest records no commit baseline the comparison degrades to ' +
        'working-tree-vs-HEAD, and needsRefresh=false then only means "nothing uncommitted". ' +
        'Read-only. Ask this before scheduling a re-index, or to explain why an index is stale.',
      parameters: {
        repo: {
          type: 'string',
          required: true,
          description: 'Absolute path to the repository root (the directory containing .gitnexus).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            text: { type: 'string', required: true },
            comparable: { type: 'boolean', required: true },
            certain: { type: 'boolean', required: true },
            needsRefresh: { type: 'boolean', required: true },
            modified: { type: 'integer', required: true },
            added: { type: 'integer', required: true },
            deleted: { type: 'integer', required: true },
            excluded: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const report = await readDelta(args.repo);
        return {
          text: `${describeDelta(report)}\n${report.notes.join('\n')}`.trim(),
          comparable: report.comparable,
          certain: report.certain,
          needsRefresh: report.needsRefresh,
          modified: report.counts.modified,
          added: report.counts.added,
          deleted: report.counts.deleted,
          excluded: report.counts.excluded,
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `GitNexus delta · ${String(args.repo).split(/[\\/]/).pop()}`,
        kind: 'read',
      }),
    }),
  );

  /**
   * The three graph tools, over one helper.
   *
   * They are the reason this plugin exists for an agent: `gitnexus_coverage` and
   * `gitnexus_delta` describe the *index*, these answer about the *code*. GitNexus is
   * also an MCP server with seventeen tools; these three are the ones whose answers a
   * coding session actually acts on, and the rest are deliberately left out (see
   * `.docs/plan-0.1.8.md` §2 for the per-tool reasoning).
   *
   * Two behaviours are load-bearing and must survive any edit here:
   *
   * - A failed call is a normal answer, not an exception. `no-index` is the common
   *   case on a fresh repository, and the sentence has to tell the model what to do
   *   next rather than presenting a stack trace.
   * - `renderTool` prints `risk`, `epistemic` and `boundaries` outside the truncated
   *   lists, so a small answer never reads as a complete one.
   */
  if (config.graphTools) {
    const answer = async (
      tool: GraphToolName,
      repo: string,
      params: Record<string, unknown>,
      subject: string,
      signal: AbortSignal | undefined,
      timeoutMs: number = config.graphToolTimeoutMs,
    ): Promise<GraphToolResult> => {
      const shell = shellFor();
      const outcome = await runGraphTool(repo, tool, params, {
        shell,
        runner: runnerFor(shell),
        helperPath: graphQueryHelperPath,
        gitnexusHome: config.gitnexusHome,
        timeoutMs,
        sandboxPolicy: sandboxPolicyForRoot,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!outcome.ok) {
        return {
          text: `GitNexus ${tool} 未能回答（${outcome.code}）· ${subject}\n${outcome.message}`,
          ok: false,
          result: null,
        };
      }
      const rendered = renderTool(
        tool,
        outcome.result,
        tool === 'query' ? String(params.search_query ?? '') : '',
      );
      return { text: rendered.text, ok: true, result: rendered.result };
    };

    ctx.tools.register(
      defineTool<ImpactToolArgs, GraphToolResult>({
        name: 'gitnexus_impact',
        description:
          'What breaks if this symbol changes: the transitive callers of a symbol, grouped by depth, ' +
          'with the execution processes that cross it. Run this BEFORE editing a function, class or ' +
          'method — a HIGH or CRITICAL risk means the change reaches many callers. Read `risk` ' +
          'literally: LOW means few upstream dependencies, UNKNOWN means the upstream walk resolved ' +
          'no callers at all, which is NOT the same as safe — confirm with a text search when you see ' +
          'UNKNOWN. When `epistemic` is lower-bound the list is a lower bound, not the whole truth. ' +
          'After the change, ask gitnexus_delta whether the index needs a refresh.',
        parameters: {
          repo: {
            type: 'string',
            required: true,
            description: 'Absolute path to the repository root (the directory containing .gitnexus).',
          },
          target: {
            type: 'string',
            required: true,
            description:
              'Symbol name to analyse. A bare name is fine; ambiguity is resolved by the index.',
          },
          direction: {
            type: 'string',
            enum: ['upstream', 'downstream'],
            description: '`upstream` (default) = who calls this. `downstream` = what this calls.',
          },
          maxDepth: {
            type: 'integer',
            description:
              'How many call-graph hops to walk. Default and ceiling are the index’s own (32).',
          },
          summaryOnly: {
            type: 'boolean',
            description:
              'Skip the per-depth caller list and return counts, processes and modules only. ' +
              'Cheaper; use it when you only need the verdict.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum entries per depth level (not a total cap).',
          },
          minConfidence: {
            type: 'number',
            description:
              'Drop edges whose resolution confidence is below this (0–1). Raise it to cut the noise from ' +
              'dynamic dispatch; lower it to widen a walk that looks suspiciously short.',
          },
        },
        output: graphToolOutput,
        // The helper owns the real 20 s deadline and says so in words; this budget is
        // the host-side backstop that only fires if the helper never settles. Declaring
        // it asserts what the body does: it forwards `exec.signal` to the process.
        // Read-only, and each call owns its own temp directory and helper process, so
        // two questions may be in flight at once — the host only parallelizes on `true`.
        isConcurrencySafe: () => true,
        timeoutMs: config.graphToolTimeoutMs + 5_000,
        async execute(args, exec) {
          const params: Record<string, unknown> = { target: args.target };
          if (args.direction !== undefined) params.direction = args.direction;
          if (args.maxDepth !== undefined) params.maxDepth = args.maxDepth;
          if (args.summaryOnly !== undefined) params.summaryOnly = args.summaryOnly;
          if (args.limit !== undefined) params.limit = args.limit;
          if (args.minConfidence !== undefined) params.minConfidence = args.minConfidence;
          return answer('impact', args.repo, params, args.target, exec?.signal);
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `GitNexus impact · ${args.target}`,
          kind: 'read',
        }),
      }),
    );

    ctx.tools.register(
      defineTool<ContextToolArgs, GraphToolResult>({
        name: 'gitnexus_context',
        description:
          'The named symbol and its immediate neighbourhood: where it is defined, what calls it, what ' +
          'it calls, and the execution processes it takes part in. Cheaper and more focused than ' +
          'gitnexus_impact — start here to understand a symbol, then ask for impact before changing ' +
          'it. `include_content` adds the source of the symbol and its immediate neighbours; leave it ' +
          'off unless you need to read the body, because it spends context.',
        parameters: {
          repo: {
            type: 'string',
            required: true,
            description: 'Absolute path to the repository root (the directory containing .gitnexus).',
          },
          name: {
            type: 'string',
            description:
              'Symbol name (function, class, method, property, type). Most calls use this; give `uid` or ' +
              '`file_path` instead (or as well) when the name is ambiguous.',
          },
          uid: {
            type: 'string',
            description:
              'A symbol id from an earlier answer — `gitnexus_query` prints them as `uid <id>` ' +
            'on each definition line. ' +
              'The unambiguous way to name a symbol.',
          },
          file_path: {
            type: 'string',
            description:
              'Repository-relative file path, to resolve a name inside one file or to look up a file’s ' +
              'symbols.',
          },
          kind: {
            type: 'string',
            description: 'Symbol kind, e.g. Function, Class, Method, Property, Interface.',
          },
          include_content: {
            type: 'boolean',
            description:
              'Include source text for the symbol and immediate neighbours. Defaults to false.',
          },
        },
        output: graphToolOutput,
        // Read-only, and each call owns its own temp directory and helper process, so
        // two questions may be in flight at once — the host only parallelizes on `true`.
        isConcurrencySafe: () => true,
        timeoutMs: config.graphToolTimeoutMs + 5_000,
        async execute(args, exec) {
          const params: Record<string, unknown> = {};
          if (args.name !== undefined) params.name = args.name;
          if (args.uid !== undefined) params.uid = args.uid;
          if (args.file_path !== undefined) params.file_path = args.file_path;
          if (args.kind !== undefined) params.kind = args.kind;
          if (args.include_content !== undefined) params.include_content = args.include_content;
          const subject = args.name ?? args.uid ?? args.file_path ?? '';
          if (subject === '') {
            return {
              text:
                'GitNexus context 需要 name、uid 或 file_path 之一 —— 只有 kind 或 include_content 无法定位符号。' +
                '先用 gitnexus_query 找到它，再把那里打印的 id 作为 uid 传回来。',
              ok: false,
              result: null,
            };
          }
          return answer('context', args.repo, params, subject, exec?.signal);
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `GitNexus context · ${args.name ?? args.uid ?? args.file_path ?? ''}`,
          kind: 'read',
        }),
      }),
    );

    ctx.tools.register(
      defineTool<QueryToolArgs, GraphToolResult>({
        name: 'gitnexus_query',
        description:
          'Ask the graph a question in plain language: "how is the delta verdict computed", "where ' +
          'are routes mounted", "who writes the manifest". Returns the execution processes that match, ' +
          'the symbols inside them, and the definitions whose names match — the fastest way to find ' +
          'the part of an unfamiliar codebase that implements a concept. Use it instead of grepping ' +
          'for a concept; grep is still the right tool for a literal string.',
        parameters: {
          repo: {
            type: 'string',
            required: true,
            description: 'Absolute path to the repository root (the directory containing .gitnexus).',
          },
          search_query: {
            type: 'string',
            required: true,
            description: 'The question or concept, in the language of the codebase.',
          },
          goal: {
            type: 'string',
            description:
              'What you are trying to do with the answer. Changes the ranking; worth setting when the ' +
              'question is ambiguous.',
          },
          task_context: {
            type: 'string',
            description:
              'Free-form context about the task the answer serves (the file you are editing, the error ' +
              'you are chasing). Refines the ranking further than `goal` alone.',
          },
          limit: {
            type: 'integer',
            description: 'How many processes to return. Defaults to 5, capped at 100.',
          },
          max_symbols: {
            type: 'integer',
            description: 'How many symbols per process to return. Defaults to 10, capped at 200.',
          },
        },
        output: graphToolOutput,
        // Read-only, and each call owns its own temp directory and helper process, so
        // two questions may be in flight at once — the host only parallelizes on `true`.
        isConcurrencySafe: () => true,
        // A query walks processes and definitions rather than one symbol's callers, and
        // on a large index it is the slowest of the three. Give it half again the budget
        // of the other two, so a broad question is not cut off by a per-symbol default.
        timeoutMs: Math.round(config.graphToolTimeoutMs * 1.5) + 5_000,
        async execute(args, exec) {
          const params: Record<string, unknown> = { search_query: args.search_query };
          if (args.goal !== undefined) params.goal = args.goal;
          if (args.task_context !== undefined) params.task_context = args.task_context;
          if (args.limit !== undefined) params.limit = args.limit;
          if (args.max_symbols !== undefined) params.max_symbols = args.max_symbols;
          return answer(
            'query',
            args.repo,
            params,
            args.search_query,
            exec?.signal,
            Math.round(config.graphToolTimeoutMs * 1.5),
          );
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `GitNexus query · ${args.search_query}`,
          kind: 'read',
        }),
      }),
    );
  }

  if (config.serveRoutes) {
    // Optional carrier: absent on headless profiles, so the tool above still works.
    ctx.inject(['webServer'], (svcCtx) => {
      // Read through `ctx.get` rather than injecting, because `shell` is optional here
      // and `inject` would make the whole route block wait for a service a headless
      // deployment never provides. `null` is handed to the runner, which reports
      // `unavailable` and tells the operator to run the command themselves —the
      // read-only half of the panel keeps working either way.
      const shellRaw: unknown = svcCtx.get('shell');
      const searchShell = isShellLike(shellRaw) ? shellRaw : null;
      // The two read helpers (search, graph) spawn through this runner: `argv` when the
      // profile mounts `ctx.subprocess`, the shell command otherwise. The maintenance
      // runners below keep taking `shell` directly — their output is a paste-able command
      // and their cancellation story is their own.
      const readRunner = runnerFor(searchShell);
      // `sandboxPolicyForRoot` is defined above, outside this block: the graph tools
      // spawn through the same policy and must work when `serveRoutes` is off.
      const analyze = createAnalyzeRunner({
        shell: searchShell,
        timeoutMs: config.analyzeTimeoutMs,
        toolchain: managedToolchain,
        sandboxPolicy: sandboxPolicyForRoot,
        // The runner must read the same config as the command text it confirms,
        // otherwise the dialog describes a command the run does not execute. It
        // resolves `false` per repository (automatic), and defaults to the
        // project-local `GITNEXUS_HOME` when the config leaves it empty.
        skipFts: config.skipFts,
        gitnexusHome: config.gitnexusHome === '' ? null : config.gitnexusHome,
      });
      // GitNexus is what produces the index this plugin reads, so a machine without it
      // has nothing to display and no way to change that from here. This runner is the
      // way out: it installs a plugin-owned copy so the operator does not have to work
      // out a package manager, a registry, or a global prefix themselves.
      const install = createInstallRunner({
        shell: isShellLike(shellRaw) ? shellRaw : null,
        prefix: installPrefix,
        timeoutMs: config.installTimeoutMs,
        // The install target is the plugin-owned prefix, not the application
        // directory: the runner creates it and roots the policy there.
        sandboxPolicy: sandboxPolicyForRoot,
      });
      // The web view is a long-lived child process, so it gets its own runner rather
      // than sharing the analyze runner's single-run-per-repository bookkeeping: those
      // runs are finite and awaited, this one is neither.
      const webView = createWebViewRunner({
        shell: searchShell,
        toolchain: managedToolchain,
        port: config.webViewPort,
        memoryOff: config.memoryOff,
        heapMb: config.analyzeHeapMb,
        // Empty means "find the registry that owns this repository"; a configured home
        // is tried first, exactly as the analyze runner does it.
        gitnexusHome: config.gitnexusHome,
        sandboxPolicy: sandboxPolicyForRoot,
      });

      const disposers = [
        mountProjectsRoute(svcCtx.webServer),
        mountCoverageRoute(svcCtx.webServer, {
          get: (repoPath, options) => coverageFor(repoPath, options),
          maintenance: (repoPath) => maintenanceFor(repoPath),
        }),
        mountFileHistoryRoute(svcCtx.webServer, {
          read: (repoPath, filePath, options) => readFileActivity(repoPath, filePath, options),
        }),
        mountFileDiffRoute(svcCtx.webServer, {
          read: (repoPath, filePath, sha) => readCommitDiff(repoPath, filePath, sha),
        }),
        mountDeltaRoute(svcCtx.webServer, {
          read: (repoPath) => readDelta(repoPath),
        }),
        mountAnalyzeRoute(svcCtx.webServer, {
          start: (repoPath, options) => analyze.start(repoPath, options),
          status: (repoPath) => analyze.status(repoPath),
          cancel: (repoPath) => analyze.cancel(repoPath),
        }),
        mountInstallRoute(svcCtx.webServer, {
          start: () => install.start(),
          status: () => install.status(),
          cancel: () => install.cancel(),
          cliPath: () => install.cliPath(),
        }),
        mountSearchRoute(svcCtx.webServer, {
          search: (repoPath, query, options) =>
            searchWithFallback(repoPath, query, {
              shell: searchShell,
              runner: readRunner,
              helperPath: searchHelperPath,
              limit: options?.limit,
              managedPrefix: installPrefix,
              // Same repository-rooted policy as analyze: the helper is a no-session
              // spawn, and the deployment default is the DSH application directory,
              // whose Windows ACL grant can fail under Program Files.
              sandboxPolicy: sandboxPolicyForRoot,
            }),
        }),
        mountGraphRoute(svcCtx.webServer, {
          project: (repoPath, view, id) =>
            projectViaHelper(repoPath, view, id, {
              shell: searchShell,
              runner: readRunner,
              helperPath: graphHelperPath,
              managedPrefix: installPrefix,
              sandboxPolicy: sandboxPolicyForRoot,
            }),
        }),
        mountWebViewRoute(svcCtx.webServer, {
          status: (repoPath) => webView.status(repoPath),
          start: (repoPath) => webView.start(repoPath),
          restart: (repoPath) => webView.restart(repoPath),
          stop: () => webView.stop(),
        }),
      ];
      ctx.effect(() => () => {
        for (const dispose of disposers) dispose();
        // Abort before clearing, so a run in flight is stopped rather than orphaned
        // holding a handle onto a server that no longer exists.
        analyze.dispose();
        install.dispose();
        // Last, and after the routes are gone: the web server is a child process that
        // outlives an idle panel by design, so it must be stopped explicitly here.
        webView.dispose();
        cache.clear();
      }, 'gitnexus-plus: HTTP routes');
    });
  }
}

/**
 * Human-readable rendering lives in `./gitnexus/format.js` —free of DSH imports
 * so it can be tested without a host. Re-exported here for callers that already
 * hold the plugin module.
 */
export { formatReport } from './gitnexus/format.js';
