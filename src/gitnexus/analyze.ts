/**
 * Run `gitnexus analyze --index-only` through the host's shell executor.
 *
 * WHY THIS REPLACED HANDING OVER A COMMAND
 * ----------------------------------------
 * The plugin used to print a command and let the operator paste it. That was
 * justified as "a plugin that spawns processes bypasses the permission system", and
 * the justification was wrong — not in spirit, but in what it assumed permission
 * meant here.
 *
 * DSH's approval service governs **sandbox escalation**: widening the scope a session
 * was granted. Its audit pair must be turn-enclosed, and `ApprovalService.request()`
 * throws outside an open turn. A panel route has no turn, so it cannot ask — but it
 * also does not need to, because this command does not escalate anything. It writes
 * `.gitnexus/` **inside the workspace**, which is already within the granted scope.
 *
 * The confinement is not something a caller opts into. It is what `ctx.shell` *is* in
 * a given deployment: `dsh-pwsh-local` exposes the argv seam that `dsh-pwsh-sandbox`
 * wraps through `ctx.sandbox.confine`. So routing through the executor gives this
 * plugin exactly the isolation the agent's own shell tool gets.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * This runner never **constructs** a sandbox policy and never chooses a mode. It may
 * forward a policy the host resolved (`options.sandboxPolicy`), and the host may only
 * fill in the workspace root — see `src/index.ts`. The reason is measured, not
 * theoretical: an agentless route has no session, so `sandboxPolicy.resolve()` falls
 * back to `config.workspaceRoot ?? process.cwd()` and the sandbox derives its write
 * capability SID from *that* path. The repository's own grant then never applies, and
 * every write inside `.gitnexus` is refused — the failure this plugin reported as
 * "sandbox denies .gitnexus". Supplying the workspace root is not escalation: the mode
 * still comes from the deployment, and a read-only deployment stays read-only.
 *
 * A denial is reported as a denial, not retried wider: the same rule the subagent
 * prompt states, for the same reason.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  envPrefix,
  invokeCommand,
  looksDeniedBySandbox,
  quoteArg,
  shellFlavor,
  tailToLine,
  type ShellFlavor,
  type ShellExecutionLike,
  type ShellLike,
  type ShellResultLike,
} from '../shell.js';
import { anchorIndex, type AnchorReport } from './anchor.js';
import { defaultGitnexusHome, effectiveSkipFts } from './commands.js';
import { hasGitMarker } from './index-meta.js';
import { findGitnexusCli, type ToolchainOptions } from './toolchain.js';

/** Where a run got to. `unavailable` is decided before anything is spawned. */
export type AnalyzeState =
  /** No `gitnexus` executable was found — there is nothing to run. */
  | 'unavailable'
  | 'running'
  | 'done'
  /** The command ran and exited non-zero. */
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  /** The sandbox refused a write. Reported, never retried wider. */
  | 'denied';

export interface AnalyzeStatus {
  repoPath: string;
  state: AnalyzeState;
  /** Whether this run was a full rebuild (`--force`). */
  force: boolean;
  /**
   * Whether this run repaired the search indexes (`--repair-fts`) instead of
   * re-analysing. Mutually exclusive with `force`: they ask for opposite things, and
   * the route never sets both.
   */
  repairFts: boolean;
  /** The command as run, so a failure can be reproduced by hand. */
  command: string;
  /** How many times the command was spawned. 2 means the transient-lock retry ran. */
  attempts: number;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** A short operator-facing explanation, or null when the state speaks for itself. */
  message: string | null;
  /** The tail of combined output, capped. */
  output: string;
  /**
   * The commit baseline this run managed to record, filled in after {@link AnalyzeState}
   * reached `done`.
   *
   * A confined shell cannot start `git`, so the analyzer writes `lastCommit: ""` and the
   * refresh gate can only answer "无法确认". The runner writes the commit itself once the
   * run is over — see `anchor.ts` — and this field carries both the outcome and what the
   * operator should read instead of the old "go run it in a terminal" advice.
   *
   * `null` means "not attempted yet": the run is still going, or it ended in a state that
   * cannot have a baseline. The panel polls, so a run reports `done` first and `done` with
   * an anchor a second later; that ordering is deliberate — anchoring must not delay the
   * status the route already returned.
   */
  anchor?: AnchorReport | null;
  /**
   * Whether the baseline write is still in flight.
   *
   * The panel stops polling as soon as a run leaves `running`, so a run that is `done` but
   * still asking git about the baseline has to say so — otherwise the anchored status is
   * written after the last poll and never shown. Absent on older hosts, where the panel
   * must not wait for a field that will never arrive.
   */
  anchoring?: boolean;
}

export interface AnalyzeRunnerOptions {
  /**
   * The host's shell executor, or `null` when the deployment has none.
   *
   * `null` is a real composition rather than a test convenience: `ctx.shell` is mounted
   * per profile, and a headless one need not have it. A runner that reported "failed"
   * for a missing service would send the operator looking for a GitNexus problem that
   * is really a deployment shape.
   */
  shell: ShellLike | null;
  /** Wall-clock ceiling for one run. Default 10 minutes — a full rebuild is minutes. */
  timeoutMs?: number;
  /** Captured-output ceiling handed to the executor. */
  outputLimit?: number;
  /** How much output this module keeps for the panel. */
  tailLimit?: number;
  toolchain?: ToolchainOptions;
  /**
   * Pass `GITNEXUS_MEMORY=off` and the heap override, exactly as the handed-over
   * commands do. On by default: the CLI re-spawns itself over piped stdio without it,
   * which a confined process denies.
   */
  memoryOff?: boolean;
  heapMb?: number;
  /**
   * `true` forces `--skip-fts`. `false`/absent is **automatic**: the runner asks the
   * index whether FTS exists and skips it when it does not. A static `false` was
   * measured to fail with `spawn EPERM` on an index without FTS (the extension tries
   * to install out-of-process), while a static `true` forces a full rebuild on one
   * that has it.
   *
   * Ignored when `repairFts` is requested: that run exists to build the FTS indexes,
   * so skipping them would make it a no-op with a success exit code.
   */
  skipFts?: boolean;
  /** Override the redirect of the global registry write. */
  gitnexusHome?: string | null;
  /**
   * Wait before the single transient-lock retry. Short in tests, long enough in
   * production for a scanner that briefly holds `.gitnexus` to let go.
   */
  retryDelayMs?: number;
  /**
   * The sandbox policy for one repository, resolved by the host.
   *
   * Optional: a deployment without a `sandboxPolicy` service passes nothing, and the
   * shell keeps its own default. The runner does not inspect or alter the value.
   */
  sandboxPolicy?: (repoPath: string) => unknown;
  now?: () => number;
}

export interface AnalyzeRunner {
  /**
   * Begin a run, or report the one already in flight for this repository.
   *
   * `force` selects a full rebuild and `repairFts` selects an FTS-only repair. They are
   * requests, not additional runs: two analyze processes on one store contend, so a
   * request while a run is in flight returns that run — and `repairFts` wins over
   * `force` when a caller passes both, because repairing is the smaller claim.
   */
  start(repoPath: string, options?: { force?: boolean; repairFts?: boolean }): AnalyzeStatus;
  status(repoPath: string): AnalyzeStatus | null;
  cancel(repoPath: string): boolean;
  /** Abort every in-flight run. Called on plugin teardown. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TAIL_LIMIT = 4 * 1024;

/**
 * Build the command line, as the shell will read it.
 *
 * TWO THINGS HERE WERE WRONG ON THE FIRST ATTEMPT, AND TOGETHER THEY MADE THE BUTTON
 * DO NOTHING VISIBLE — a run started, finished, and the index never changed.
 *
 * 1. PowerShell needs the call operator before a quoted path.
 *    `'C:\...\gitnexus.cmd' analyze` is not a command: the single-quoted string is a
 *    string *literal*, and the parser dies on the next token. Measured:
 *    "表达式或语句中包含意外的标记" for the whole statement. The paste-able text in
 *    `commands.ts` never hit this because it names a bare `gitnexus` and lets PATH
 *    resolve it — a difference that exists only because this path is absolute.
 *
 * 2. The environment prefix is not optional. `GITNEXUS_MEMORY=off` stops the CLI
 *    re-spawning itself over piped stdio, which a confined process denies. Dropping it
 *    because the command "looked simpler" reintroduces exactly the failure the
 *    maintenance text was written to avoid.
 *
 * Exported so the shape can be asserted without a shell.
 */
export function analyzeCommandLine(
  cliPath: string,
  repoPath: string,
  options: {
    flavor?: 'win32' | 'posix';
    memoryOff?: boolean;
    heapMb?: number;
    viaNode?: boolean;
    /** Full rebuild. This is the destructive escape hatch; the button must say so. */
    force?: boolean;
    /** Repair the search (FTS) indexes only. Never combined with `skipFts`. */
    repairFts?: boolean;
    /**
     * The directory has no `.git`. GitNexus refuses a folder without one even when it
     * is passed explicitly, unless `--skip-git` is present; the index then has no
     * commit baseline and no incremental mode.
     */
    skipGit?: boolean;
    /** Must match `maintenanceCommands`; see the note on the runner option. */
    skipFts?: boolean;
    gitnexusHome?: string | null;
  } = {},
): string {
  const flavor: ShellFlavor = options.flavor ?? shellFlavor();
  const memoryOff = options.memoryOff !== false;
  const heapMb = options.heapMb ?? 8192;
  // A CLI taken from the declared dependency is the package's `dist/cli/index.js`, so it
  // is spawned through `node`. This is the better shape when available: no shim, no
  // `.cmd`/`.ps1` selection, and therefore no reliance on the shell's call operator.
  const viaNode = options.viaNode === true;
  // Repair and skip are contradictory, and both flags are accepted by the CLI without
  // complaining: `--skip-fts --repair-fts` exits 0 having done nothing. Guard here
  // rather than trusting callers to keep them apart.
  const repairFts = options.repairFts === true;
  const skipFts = options.skipFts === true && !repairFts;
  const skipGit = options.skipGit === true;
  const force = options.force === true && !repairFts;

  const args =
    `analyze --index-only` +
    `${repairFts ? ' --repair-fts' : ''}` +
    `${skipGit ? ' --skip-git' : ''}` +
    `${skipFts ? ' --skip-fts' : ''}` +
    `${force ? ' --force' : ''} ` +
    quoteArg(flavor, repoPath);
  const head = viaNode ? `node ${quoteArg(flavor, cliPath)}` : quoteArg(flavor, cliPath);
  // The call operator (Windows-only, quoted head only) is part of the shared rule:
  // `'C:\...\gitnexus.cmd' analyze` is a string literal followed by an unexpected token,
  // not a command.
  const invocation = invokeCommand(flavor, head, args, { viaNode });
  const pairs: Array<[string, string]> = [];
  if (memoryOff) pairs.push(['GITNEXUS_MEMORY', 'off']);
  if (typeof options.gitnexusHome === 'string' && options.gitnexusHome !== '') {
    pairs.push(['GITNEXUS_HOME', options.gitnexusHome]);
  }
  // The heap has to be in place before the CLI starts, because it is the CLI's own
  // re-spawn that needs it; that re-spawn is also what `GITNEXUS_MEMORY=off` suppresses
  // under a confined executor.
  pairs.push(['NODE_OPTIONS', `--max-old-space-size=${heapMb}`]);
  return `${envPrefix(flavor, pairs)}${invocation}`;
}

/** Delay before the single transient-lock retry. Long enough for a scanner to let go. */
const RETRY_DELAY_MS = 1500;

/**
 * Whether a failure looks like a transient file lock rather than a policy refusal.
 *
 * Measured on GitNexus 1.6.12: the first write inside `.gitnexus` is
 * `lbug.init.lock`, opened with `O_CREAT | O_EXCL`, and Windows can refuse it with
 * `EPERM` while another scanner or a previous process holds the directory. The same
 * class produces `unable to acquire init lock` when a crashed run left the file behind.
 * Both are worth one retry; a sandbox marker never is, and neither is a denied
 * directory creation — see {@link isSandboxStoreDenied}.
 */
function isTransientLock(text: string): boolean {
  if (/\[sandbox:[^\]]*denied/i.test(text)) return false;
  // The parse store is a directory the analyzer must create; a retry cannot grant a
  // right the confined token does not have, so that class is handled separately.
  if (isSandboxStoreDenied(text)) return false;
  // A refused `spawn` is the sandbox blocking a child process (the FTS installer), not a
  // held file: waiting and retrying changes nothing.
  if (/spawn EPERM/i.test(text)) return false;
  if (/unable to acquire init lock/i.test(text)) return true;
  return /(EPERM|EBUSY|resource busy)/i.test(text) && /\.gitnexus|init\.lock|lbug/i.test(text);
}

/**
 * Whether GitNexus tried to start a child process and the sandbox refused.
 *
 * Measured on a `--repair-fts` run: `Analysis failed: spawn EPERM`. The FTS extension is
 * installed/loaded out of process, which a confined shell denies. This is the same class
 * as the respawn problem `GITNEXUS_MEMORY=off` was added for — but this one is a child
 * the analyzer starts deliberately, and no flag suppresses it.
 */
function looksSpawnDenied(text: string): boolean {
  return /spawn EPERM/i.test(text);
}

/**
 * Whether the FTS extension was found and still could not be loaded.
 *
 * That is an upstream runtime problem, not a sandbox refusal and not something a retry
 * can fix: on Windows it usually names a missing DLL (`找不到指定的模块`), which the
 * upstream message traces to the VC++ 2015-2022 x64 redistributable or OpenSSL 3.
 */
function looksFtsUnloadable(text: string): boolean {
  return (
    /FTS extension file was found but could not be loaded/i.test(text) ||
    (/failed to load library/i.test(text) && /fts/i.test(text))
  );
}

/**
 * Whether the parse worker was refused permission to create its cache directories.
 *
 * Measured in a confined DSH profile: the token can create **files** under `.gitnexus`
 * (`lbug.init.lock` succeeds) but not **directories**, so `persistParsedFileShardSync`
 * dies at `mkdir .gitnexus/parsedfile-store` and the pool trips its circuit breaker.
 * Pre-creating the directory does not help either — GitNexus deletes it at the start of
 * every parse, and that delete is refused for the same reason (0.1.3 shipped exactly
 * that workaround and produced `EPERM … rmdir`). This is a property of the deployment,
 * so the honest answer is one precise message pointing at the terminal, not a retry.
 */
function isSandboxStoreDenied(text: string): boolean {
  return (
    /EPERM[^\n]*mkdir[^\n]*\.gitnexus[\\/](parsedfile-store|parsedfile-cache|parse-cache)/i.test(text) ||
    /mkdir[^\n]*\.gitnexus[\\/](parsedfile-store|parsedfile-cache|parse-cache)[^\n]*EPERM/i.test(text)
  );
}

/**
 * Remove the init lock a crashed run left behind, so the retry can take it.
 *
 * Safe by construction: this runner holds one run per repository, so no other analyze
 * started by this plugin can be inside the window. A live lock from another tool is
 * left to GitNexus's own staleness detection — this only clears the file, it does not
 * decide who owns it.
 */
function clearStaleLock(repoPath: string): void {
  try {
    rmSync(path.join(repoPath, '.gitnexus', 'lbug.init.lock'), { force: true });
  } catch {
    /* the retry may still succeed once a scanner releases it */
  }
}

/**
 * The **durable** caches, created from the host before the shell starts.
 *
 * A worker running under a restricted host token can be denied `mkdir` on the project's
 * inherited `.gitnexus` ACL even though it can write files there. The failure is EPERM
 * at the first shard write and takes the whole parse phase down with it. Creating these
 * two from the host, before the shell starts, makes the worker use directories that
 * already exist. They are never cleared between runs, so a pre-created one is inert.
 */
const ANALYZE_CACHE_DIRS = ['parsedfile-cache', 'parse-cache'] as const;

/**
 * GitNexus's **run-scoped** parsed-file store. Deliberately not pre-created.
 *
 * `parse-impl` calls `clearParsedFileStore()` unconditionally at the start of parsing,
 * which is `fs.rm(dir, { recursive: true, force: true })`. `force` only forgives a
 * missing directory — not a refusal or a lock. So a directory that exists there must be
 * deleted before every parse, and 0.1.3 pre-created exactly that: it fixed a worker
 * `mkdir` and introduced a delete the restricted process has to perform on a directory
 * the **host** created. When that delete is denied or briefly locked, the parse dies
 * with `EPERM … rmdir '<repo>\\.gitnexus\\parsedfile-store'` — the failure reported
 * against 0.1.3.
 *
 * Measured against GitNexus 1.6.12: with the directory absent, a cold `--force` parse
 * succeeds and never creates it, while the durable chunk directories it does create
 * show the confined process can `mkdir`. So the store is left to GitNexus, and a
 * leftover from an older plugin version is removed before spawning instead.
 */
const RUN_SCOPED_STORE = 'parsedfile-store';

function prepareAnalyzeCacheDirs(repoPath: string): string | null {
  const indexDir = path.join(repoPath, '.gitnexus');
  if (!existsSync(indexDir)) return null;

  // Best effort. If this cannot be removed, GitNexus's own clear gets the next attempt;
  // failing the run here would only replace one EPERM with a less accurate one.
  try {
    rmSync(path.join(indexDir, RUN_SCOPED_STORE), { recursive: true, force: true });
  } catch {
    /* the analyzer's clear is the next attempt; do not pre-empt it */
  }

  for (const name of ANALYZE_CACHE_DIRS) {
    const target = path.join(indexDir, name);
    try {
      mkdirSync(target, { recursive: true });
    } catch (cause) {
      return (
        `无法创建 GitNexus 缓存目录（${path.join('.gitnexus', name)}）：` +
        `${String((cause as Error)?.message ?? cause)}。` +
        '请给项目 .gitnexus 目录写权限，或在普通终端执行下面的命令。'
      );
    }
  }
  return null;
}

export function createAnalyzeRunner(options: AnalyzeRunnerOptions): AnalyzeRunner {
  const { shell } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
  const now = options.now ?? (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const flavor: ShellFlavor = shellFlavor();

  const runs = new Map<string, AnalyzeStatus>();
  const inFlight = new Map<string, AbortController>();
  // One status per repository, and a long session can touch many. The map used to grow
  // with every repository ever visited, each entry holding a 4 KB output tail; an idle
  // panel never needs more than the repositories it can still show.
  const RUNS_MAX = 32;

  /** Store the latest status, evicting finished entries beyond the cap, oldest first. */
  const rememberRun = (key: string, status: AnalyzeStatus): void => {
    runs.delete(key);
    runs.set(key, status);
    if (runs.size <= RUNS_MAX) return;
    for (const [other, entry] of runs) {
      if (entry.state === 'running') continue;
      runs.delete(other);
      if (runs.size <= RUNS_MAX) break;
    }
  };

  /** The shape a status starts from, before any run has touched it. */
  const BLANK: Omit<AnalyzeStatus, 'repoPath'> = {
    state: 'failed',
    force: false,
    repairFts: false,
    command: '',
    attempts: 0,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    message: null,
    output: '',
    anchor: null,
  };

  const finish = (repoPath: string, patch: Partial<AnalyzeStatus>): AnalyzeStatus => {
    const next: AnalyzeStatus = {
      repoPath,
      ...BLANK,
      ...runs.get(repoPath),
      ...patch,
      // Set last and unconditionally: every path that reaches `finish` is finishing, so
      // a caller passing `finishedAt: null` is asking for "not finished", not for a
      // silent no-op. The spread above cannot express that.
      finishedAt: patch.finishedAt ?? now(),
    };
    rememberRun(repoPath, next);
    inFlight.delete(repoPath);
    return next;
  };

  const start = (
    repoPath: string,
    request: { force?: boolean; repairFts?: boolean } = {},
  ): AnalyzeStatus => {
    const key = path.resolve(repoPath);
    // Named `request`, not `options`: the runner's own configuration is the outer
    // `options`, and shadowing it silently dropped `toolchain`, `memoryOff` and
    // `heapMb` from every run built after the force argument was added.
    //
    // Repair wins over force: a caller asking for both wants the smaller, more targeted
    // operation, and running a full rebuild to fix FTS would be a much larger change
    // than the button said. `analyzeCommandLine` enforces the same precedence so the
    // displayed command cannot disagree with the one executed.
    const repairFts = request.repairFts === true;
    const force = repairFts ? false : request.force === true;
    // Both decisions are per repository, not per plugin: the skip-fts policy depends
    // on the index's own FTS capability, and the registry redirect belongs beside the
    // index so it stays inside the workspace the host was granted. A repair run never
    // skips FTS — that would be the one flag combination that does nothing at all.
    const skipFts = repairFts ? false : effectiveSkipFts(key, options.skipFts === true);
    // GitNexus checks for `.git` before it reads any option, so a plain folder is
    // refused even when its path is explicit. `--skip-git` is the CLI's own answer:
    // it indexes the folder and warns that commit tracking and incremental updates
    // are disabled. The panel reports the same consequence.
    const skipGit = !hasGitMarker(key);
    const gitnexusHome = options.gitnexusHome ?? defaultGitnexusHome(key);

    // One run per repository. Two concurrent `analyze` processes would contend for the
    // same store, and the second would report a failure that says nothing about the
    // repository — so a second request reports the first rather than starting one.
    const running = runs.get(key);
    if (running !== undefined && running.state === 'running') return running;

    // The command as a human would type it, for the states that never reach a real
    // invocation. Kept in one place so an early return cannot describe a different
    // operation than the one the request asked for.
    const previewCommand =
      `gitnexus analyze --index-only` +
      `${repairFts ? ' --repair-fts' : ''}` +
      `${skipGit ? ' --skip-git' : ''}` +
      `${force ? ' --force' : ''}`;

    if (shell === null) {
      return finish(key, {
        state: 'unavailable',
        force,
        repairFts,
        command: previewCommand,
        startedAt: now(),
        output: '',
        message:
          '当前部署没有提供 shell 执行器（ctx.shell 未挂载），无法运行命令。' +
          '请复制下面的命令在终端中执行。',
      });
    }

    // `moduleUrl` is what lets the probe find the `gitnexus` that npm installed beside
    // this plugin. Omitting it would make the dependency branch unreachable and silently
    // fall back to PATH forever — the dependency would be installed and never used.
    const cli = findGitnexusCli({ moduleUrl: import.meta.url, ...(options.toolchain ?? {}) });
    if (!cli.present) {
      return finish(key, {
        state: 'unavailable',
        force,
        repairFts,
        command: previewCommand,
        startedAt: now(),
        output: '',
        message:
          '本机没有找到 gitnexus 命令，无法执行。安装后重试：`npm i -g gitnexus`。' +
          '扫描与覆盖数据仍然可用 —— 那部分不需要 CLI。',
      });
    }

    // `--index-only` is not negotiable here: without it `analyze` rewrites AGENTS.md,
    // CLAUDE.md and the agent skill files inside the repository, which is a much larger
    // change than "refresh the index" and not what the button says it does.
    const command = analyzeCommandLine(cli.cliPath, key, {
      flavor,
      memoryOff: options.memoryOff,
      heapMb: options.heapMb,
      viaNode: cli.viaNode,
      force,
      repairFts,
      skipFts,
      skipGit,
      gitnexusHome,
    });

    const cacheError = prepareAnalyzeCacheDirs(key);
    if (cacheError !== null) {
      return finish(key, {
        state: 'failed',
        force,
        repairFts,
        command,
        startedAt: now(),
        output: '',
        message: cacheError,
      });
    }

    const controller = new AbortController();
    inFlight.set(key, controller);
    const started: AnalyzeStatus = {
      repoPath: key,
      state: 'running',
      force,
      repairFts,
      command,
      attempts: 1,
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      message: null,
      output: '',
    };
    rememberRun(key, started);

    // The host resolves the policy; this runner only carries it. Absent when the
    // deployment has no `sandboxPolicy` service, and then the executor's own default
    // applies — exactly as before.
    const sandboxPolicy = options.sandboxPolicy?.(key);
    const spec = shell.resolve({
      command,
      workdir: key,
      timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: outputLimit,
      signal: controller.signal,
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    });

    void (async () => {
      // A single retry, and only for one class of failure.
      //
      // Measured: GitNexus's first write inside `.gitnexus` is the init lock, and on
      // Windows that `open` can fail with `EPERM` while a virus scanner or the indexer
      // holds the directory — a transient refusal, not a policy one. The ACL for that
      // path was verified healthy (`WRITE_DAC`/`WRITE_OWNER` present, no foreign
      // entries), so retrying once after clearing a stale lock is the response, not an
      // escalation. Anything carrying the sandbox's own marker is never retried.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let execution: ShellExecutionLike;
        try {
          execution = await shell.execute(spec);
        } catch (cause) {
          // `execute` rejects only for infrastructure failures — an unusable workdir, no
          // shell. A cancellation rejects here too, before a handle exists.
          const aborted = controller.signal.aborted;
          finish(key, {
            state: aborted ? 'cancelled' : 'failed',
            attempts: attempt,
            message: aborted ? '已取消。' : `无法启动命令：${String((cause as Error)?.message ?? cause)}`,
          });
          return;
        }

        let result: ShellResultLike;
        try {
          result = await execution.result();
        } catch (cause) {
          finish(key, {
            state: 'failed',
            attempts: attempt,
            message: `执行失败：${String((cause as Error)?.message ?? cause)}`,
          });
          return;
        }

        const combined = `${result.stdout?.text ?? ''}${result.stderr?.text ?? ''}`;
        const body = tailToLine(combined, tailLimit);
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;

        if (
          attempt === 1 &&
          result.timedOut !== true &&
          !controller.signal.aborted &&
          isTransientLock(combined)
        ) {
          clearStaleLock(key);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          if (controller.signal.aborted) {
            finish(key, { state: 'cancelled', attempts: attempt, exitCode, output: body, message: '已取消。' });
            return;
          }
          continue;
        }

        // Order matters. A denial can also be a non-zero exit, and reporting it as a
        // generic failure sends the operator looking for a GitNexus bug that is not
        // there. Cancellation is checked before timeout because a kill from `cancel()`
        // and a kill from the deadline both surface as a killed process.
        if (controller.signal.aborted) {
          finish(key, { state: 'cancelled', attempts: attempt, exitCode, output: body, message: '已取消。' });
        } else if (result.timedOut === true) {
          finish(key, {
            state: 'timed-out',
            attempts: attempt,
            exitCode,
            output: body,
            message: `超过 ${Math.round(timeoutMs / 1000)} 秒上限已终止。大仓库的全量重建可能需要更长时间。`,
          });
        } else if (looksFtsUnloadable(combined)) {
          // The extension is present and still cannot load: an upstream runtime gap, not
          // a sandbox refusal and not a retry candidate.
          finish(key, {
            state: 'failed',
            attempts: attempt,
            exitCode,
            output: body,
            message:
              'FTS 扩展文件存在但加载失败 —— 通常是 Windows 缺少原生运行时（VC++ 2015-2022 x64 与 OpenSSL 3），' +
              '不是索引损坏，也不是本插件能修的。装好运行时后再试；在此之前搜索仍按名称/路径匹配。',
          });
        } else if (looksSpawnDenied(combined)) {
          finish(key, {
            state: 'denied',
            attempts: attempt,
            exitCode,
            output: body,
            message:
              '分析器要启动一个子进程（FTS 扩展的安装/加载），当前沙箱不允许 spawn。请在普通终端执行下面的命令；' +
              '若终端里仍报扩展无法加载，那是缺少原生运行时。',
          });
        } else if (isSandboxStoreDenied(combined)) {
          // Deterministic, not transient: the confined token may create files in
          // `.gitnexus` but not directories, and the parse worker needs a directory.
          // Retrying would only spend another parse; say what to do instead.
          finish(key, {
            state: 'denied',
            attempts: attempt,
            exitCode,
            output: body,
            message:
              '分析器的解析阶段要在 .gitnexus 下创建缓存目录，当前沙箱不允许（可以建文件、不能建目录），' +
              '预建目录也会被 GitNexus 在解析开始时删除。请在普通终端执行下面的命令，再回到面板刷新。',
          });
        } else if (looksDeniedBySandbox(combined)) {
          finish(key, {
            state: 'denied',
            attempts: attempt,
            exitCode,
            output: body,
            message: '沙箱拒绝了这次写入。本插件不会申请扩权 —— 需要在终端里手动执行这条命令。',
          });
        } else if (exitCode === 0) {
          const done = finish(key, {
            state: 'done',
            attempts: attempt,
            exitCode,
            output: body,
            // No message yet: whether the index can carry a commit baseline depends on
            // git, which is asked below. The old wording told the operator to re-run in a
            // terminal, which was true only because nothing here was writing the field.
            message: null,
            anchoring: true,
          });
          // Deliberately not awaited: `start()` is synchronous and its caller has already
          // received a status. The panel polls every second, so it picks the anchored
          // status up on the next tick instead of waiting for two git calls.
          void (async () => {
            // `finish` already cleared `inFlight`, so a second refresh can start while
            // these two git calls are in flight. If one did, its status is the truth and
            // this run's finish must not overwrite it with a stale `done`.
            const stillCurrent = (): boolean => runs.get(key)?.startedAt === done.startedAt;
            try {
              const anchor = await anchorIndex(key, { gitnexusHome, skipGit });
              if (!stillCurrent()) return;
              rememberRun(key, { ...done, anchor, anchoring: false, message: anchor.message });
            } catch (error) {
              if (!stillCurrent()) return;
              // The index is correct; only the baseline is unknown. Say that rather than
              // losing the completed run to an exception.
              rememberRun(key, {
                ...done,
                anchor: null,
                anchoring: false,
                message: `刷新完成，但记录提交基线时出错：${String((error as Error)?.message ?? error)}。索引本身可用。`,
              });
            }
          })();
        } else {
          finish(key, {
            state: 'failed',
            attempts: attempt,
            exitCode,
            output: body,
            message:
              attempt > 1 && isTransientLock(combined)
                ? '缓存或锁文件被临时占用（EPERM/EBUSY），已自动重试一次仍失败。稍后重试；若持续出现，把下面的命令放到普通终端执行。'
                : `gitnexus 以退出码 ${exitCode ?? '未知'} 结束。`,
          });
        }
        return;
      }
    })();

    return started;
  };

  return {
    start,
    status: (repoPath) => runs.get(path.resolve(repoPath)) ?? null,
    cancel: (repoPath) => {
      const key = path.resolve(repoPath);
      const controller = inFlight.get(key);
      if (controller === undefined) return false;
      controller.abort();
      return true;
    },
    dispose: () => {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}
