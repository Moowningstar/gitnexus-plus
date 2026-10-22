/**
 * dsh-gitnexus-plus —host half.
 *
 * Registers one read-only tool and one loopback HTTP route over the coverage
 * engine in `./gitnexus/`. Both answer the same question —"what did this index
 * leave out?" —for the two callers that need it: the model, and a browser half
 * that will render it.
 *
 * The read path is still never allowed to change anything: a status check must not
 * start a 30-second rebuild. The two mutating capabilities are separate routes with
 * their own guards, and both go through the host's shell executor rather than
 * spawning from the read path. Keyword search is a third read-only route over the
 * graph itself; the tool above stays read-only.
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
import { projectViaHelper } from './gitnexus/graph.js';
import { searchWithFallback } from './gitnexus/search.js';
import { createAnalyzeRunner, type ShellLike } from './gitnexus/analyze.js';
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
        title: `GitNexus coverage 路 ${String(args.repo).split(/[\\/]/).pop()}`,
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
      /**
       * The sandbox policy for one repository, with the workspace root this route knows
       * and the deployment's own mode.
       *
       * WHY THIS IS NOT ESCALATION
       * --------------------------
       * A panel route has no session, so `sandboxPolicy.resolve()` falls back to
       * `config.workspaceRoot ?? process.cwd()` — the DSH application directory. The
       * sandbox derives its write-capability SID from that path, so the repository's
       * grant never applies and every write inside `.gitnexus` is refused. Measured on
       * this machine: the ACE `S-1-4-160954772-582561662` on the repository is exactly
       * `workspaceWriteSid('D:\\Project\\gitnexus-plus')`.
       *
       * This function therefore forwards the deployment's resolved policy and replaces
       * only the root with the repository the caller named. The **mode** is never
       * touched: read-only stays read-only, and a deployment without a policy service
       * keeps the executor's own default. What it adds is the one input the agentless
       * route cannot otherwise supply. It is used by every spawn this plugin starts for
       * a repository: analyze, the search helper and the graph helper. Without it the
       * helpers inherit the application directory, and on Windows the ACL runner fails
       * before the helper starts (`SetNamedSecurityInfoW … grantWrite(<app dir>)`).
       */
      const sandboxPolicyForRoot = (repoPath: string): unknown => {
        const raw: unknown = svcCtx.get('sandboxPolicy');
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
