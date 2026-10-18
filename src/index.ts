/**
 * dsh-gitnexus-plus 鈥?host half.
 *
 * Registers one read-only tool and one loopback HTTP route over the coverage
 * engine in `./gitnexus/`. Both answer the same question 鈥?"what did this index
 * leave out?" 鈥?for the two callers that need it: the model, and a browser half
 * that will render it.
 *
 * Deliberately read-only. Nothing here triggers `analyze`, writes to `.gitnexus/`,
 * or takes the index lock; driving updates is a separate concern with its own
 * safety story, and mixing the two would mean a status check could start a
 * 30-second rebuild.
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { analyzeCoverage, type CoverageReport } from './gitnexus/coverage.js';
import { formatReport } from './gitnexus/format.js';
import { maintenanceCommands, commandRationale, type MaintenanceCommand } from './gitnexus/commands.js';
import { mountCoverageRoute } from './routes/coverage.js';
import { mountAnalyzeRoute } from './routes/analyze.js';
import { mountInstallRoute } from './routes/install.js';
import { createAnalyzeRunner, type ShellLike } from './gitnexus/analyze.js';
import { createInstallRunner } from './gitnexus/install.js';

/**
 * Whether a service resolved from the context has the shape the runner needs.
 *
 * `ctx.get` is untyped here 鈥?the DSH packages ship no declarations, so the service
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
 * headless profile has no HTTP carrier at all 鈥?naming it here would leave the
 * plugin permanently pending there, and the tool would never register.
 */
export const inject = ['tools'] as const;

/** The shape `Schema.object` infers below, named for use in signatures. */
export interface PluginConfig {
  scanDefaultCapKb: number;
  minifiedSampleLimit: number;
  serveRoutes: boolean;
  /**
   * Shapes the maintenance commands the panel hands to the operator. The defaults
   * are the values measured to work inside a confined DSH process; a deployment
   * that is not sandboxed can turn them off to get keyword search and a
   * self-managed heap.
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
  gitnexusHome: string;
}

export const Config = Schema.object({
  scanDefaultCapKb: Schema.natural().default(512),
  minifiedSampleLimit: Schema.natural().default(40),
  serveRoutes: Schema.boolean().default(true),
  skipFts: Schema.boolean().default(true),
  memoryOff: Schema.boolean().default(true),
  analyzeHeapMb: Schema.natural().default(8192),
  analyzeTimeoutMs: Schema.natural().default(600000),
  gitnexusInstallDir: Schema.string().default(''),
  installTimeoutMs: Schema.natural().default(1200000),
  gitnexusHome: Schema.string().default(''),
});

/**
 * Compile-time proof that the schema and {@link PluginConfig} describe the same
 * object.
 *
 * These are two independent declarations of one contract 鈥?`Schema.object` infers a
 * shape, and `apply` is written against a hand-written interface 鈥?so without this
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

export function apply(ctx: Context, config: PluginConfig): void {
  const cache = new Map<string, { at: number; report: CoverageReport }>();
  const CACHE_TTL_MS = 15_000;

  /**
   * Resolve a coverage report, from cache when it is recent enough.
   *
   * Scan results are pure functions of the working tree, so a short TTL removes the
   * repeated cost of a 28k-file walk without ever showing a stale verdict to a caller
   * who just changed something.
   *
   * `fresh` bypasses the TTL. A manual refresh is an explicit instruction from a
   * person who believes the numbers may have moved, and answering it with a cached
   * copy makes the control look broken 鈥?which is exactly how it was reported. A
   * background poll is the case the TTL exists for; a click is not.
   */
  const coverageFor = async (repoPath: string, options: { fresh?: boolean } = {}): Promise<CoverageReport> => {
    const key = String(repoPath);
    if (options.fresh !== true) {
      const hit = cache.get(key);
      if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
    }
    const report = await analyzeCoverage(key, {
      minifiedSampleLimit: config.minifiedSampleLimit,
    });
    cache.set(key, { at: Date.now(), report });
    return report;
  };

  /**
   * The maintenance commands, resolved at the boundary rather than inside
   * `analyzeCoverage`: they depend on this plugin's config, and the report is a
   * pure function of the repository.
   */
  const maintenanceFor = (repoPath: string): MaintenanceInfo => {
    const options = {
      skipFts: config.skipFts,
      memoryOff: config.memoryOff,
      gitnexusHome: config.gitnexusHome === '' ? null : config.gitnexusHome,
    };
    return {
      commands: maintenanceCommands(repoPath, options),
      rationale: commandRationale(options),
    };
  };

  ctx.tools.register(
    defineTool<CoverageToolArgs, CoverageToolResult>({
      name: 'gitnexus_coverage',
      description:
        'Report what a GitNexus index omitted for a repository: files skipped for exceeding the ' +
        'size cap, oversized generated/minified output that inflates a language share, and files ' +
        'a fresh scan would select but the index does not cover. Read-only; never triggers a ' +
        're-index. Use it to judge how much of a repository the index actually represents before ' +
        'trusting graph queries.',
      parameters: {
        repo: {
          type: 'string',
          required: true,
          description: 'Absolute path to the repository root (the directory containing .gitnexus).',
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
            // compiler rejects the array form outright 鈥?it collects these marks
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

  if (config.serveRoutes) {
    // Optional carrier: absent on headless profiles, so the tool above still works.
    ctx.inject(['webServer'], (svcCtx) => {
      // Read through `ctx.get` rather than injecting, because `shell` is optional here
      // and `inject` would make the whole route block wait for a service a headless
      // deployment never provides. `null` is handed to the runner, which reports
      // `unavailable` and tells the operator to run the command themselves 鈥?the
      // read-only half of the panel keeps working either way.
      const shellRaw: unknown = svcCtx.get('shell');
      const analyze = createAnalyzeRunner({
        shell: isShellLike(shellRaw) ? shellRaw : null,
        timeoutMs: config.analyzeTimeoutMs,
      });
      // GitNexus is what produces the index this plugin reads, so a machine without it
      // has nothing to display and no way to change that from here. This runner is the
      // way out: it installs a plugin-owned copy so the operator does not have to work
      // out a package manager, a registry, or a global prefix themselves.
      const install = createInstallRunner({
        shell: isShellLike(shellRaw) ? shellRaw : null,
        prefix: config.gitnexusInstallDir === '' ? undefined : config.gitnexusInstallDir,
        timeoutMs: config.installTimeoutMs,
      });

      const disposers = [
        mountCoverageRoute(svcCtx.webServer, {
          get: (repoPath, options) => coverageFor(repoPath, options),
          maintenance: (repoPath) => maintenanceFor(repoPath),
        }),
        mountAnalyzeRoute(svcCtx.webServer, {
          start: (repoPath) => analyze.start(repoPath),
          status: (repoPath) => analyze.status(repoPath),
          cancel: (repoPath) => analyze.cancel(repoPath),
        }),
        mountInstallRoute(svcCtx.webServer, {
          start: () => install.start(),
          status: () => install.status(),
          cancel: () => install.cancel(),
          cliPath: () => install.cliPath(),
        }),
      ];
      ctx.effect(() => () => {
        for (const dispose of disposers) dispose();
        // Abort before clearing, so a run in flight is stopped rather than orphaned
        // holding a handle onto a server that no longer exists.
        analyze.dispose();
        install.dispose();
        cache.clear();
      }, 'gitnexus-plus: HTTP routes');
    });
  }
}

/**
 * Human-readable rendering lives in `./gitnexus/format.js` 鈥?free of DSH imports
 * so it can be tested without a host. Re-exported here for callers that already
 * hold the plugin module.
 */
export { formatReport } from './gitnexus/format.js';
