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
 * `sandboxPolicy` is never set here, and must never be. Passing it would be this
 * plugin choosing its own confinement — the escalation the approval service exists to
 * gate, requested through a door that cannot ask. Leaving it undefined takes the
 * deployment's decision. A denial is then reported as a denial, not retried wider:
 * the same rule the subagent prompt states, for the same reason.
 */

import path from 'node:path';
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
  /** The command as run, so a failure can be reproduced by hand. */
  command: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** A short operator-facing explanation, or null when the state speaks for itself. */
  message: string | null;
  /** The tail of combined output, capped. */
  output: string;
}

/**
 * The slice of `ctx.shell` this module uses.
 *
 * Structural rather than an import: the plugin declares no runtime dependency on the
 * DSH packages, and a test can supply a stub without a shell on the machine.
 */
export interface ShellRequestLike {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  onExpiry?: 'kill' | 'none';
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
}

export interface ShellResultLike {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  stdout?: { text?: string } | null;
  stderr?: { text?: string } | null;
}

export interface ShellExecutionLike {
  result(): Promise<ShellResultLike>;
  kill?(): boolean | Promise<boolean>;
}

export interface ShellLike {
  /** Applies the executor's defaults and caps. `execute` only accepts a resolved spec. */
  resolve(request: ShellRequestLike): unknown;
  execute(spec: unknown): Promise<ShellExecutionLike>;
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
  now?: () => number;
}

export interface AnalyzeRunner {
  /** Begin a run, or report the one already in flight for this repository. */
  start(repoPath: string): AnalyzeStatus;
  status(repoPath: string): AnalyzeStatus | null;
  cancel(repoPath: string): boolean;
  /** Abort every in-flight run. Called on plugin teardown. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TAIL_LIMIT = 4 * 1024;

/**
 * Quote one argument for the shell the executor will spawn.
 *
 * Windows and POSIX disagree, and `commands.ts` already carries the same pair — kept
 * separate here because these two modules are allowed to have different lifetimes:
 * one produces text for a human to paste, the other produces argv for a spawn, and
 * collapsing them would make a change to the paste-able text silently alter what
 * actually runs.
 */
function quoteFor(shell: 'win32' | 'posix', value: string): string {
  return shell === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A sandbox refusal, recognised from the marker DSH writes into the output.
 *
 * Tested before the generic non-zero path because a denial is not a failure of
 * GitNexus — retrying it, or reporting it as "analyze failed", both mislead.
 */
function looksDenied(text: string): boolean {
  return /\[sandbox:[^\]]*denied/i.test(text) || /access is denied|permission denied|EPERM/i.test(text);
}

/** Keep the last `limit` characters, on a line boundary when one is available. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const firstBreak = cut.indexOf('\n');
  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
}

export function createAnalyzeRunner(options: AnalyzeRunnerOptions): AnalyzeRunner {
  const { shell } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
  const now = options.now ?? (() => Date.now());
  const shellFlavor: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix';

  const runs = new Map<string, AnalyzeStatus>();
  const inFlight = new Map<string, AbortController>();

  /** The shape a status starts from, before any run has touched it. */
  const BLANK: Omit<AnalyzeStatus, 'repoPath'> = {
    state: 'failed',
    command: '',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    message: null,
    output: '',
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
    runs.set(repoPath, next);
    inFlight.delete(repoPath);
    return next;
  };

  const start = (repoPath: string): AnalyzeStatus => {
    const key = path.resolve(repoPath);

    // One run per repository. Two concurrent `analyze` processes would contend for the
    // same store, and the second would report a failure that says nothing about the
    // repository — so a second request reports the first rather than starting one.
    const running = runs.get(key);
    if (running !== undefined && running.state === 'running') return running;

    if (shell === null) {
      return finish(key, {
        state: 'unavailable',
        command: 'gitnexus analyze --index-only',
        startedAt: now(),
        output: '',
        message:
          '当前部署没有提供 shell 执行器（ctx.shell 未挂载），无法运行命令。' +
          '请复制下面的命令在终端中执行。',
      });
    }

    const cli = findGitnexusCli(options.toolchain);
    if (!cli.present) {
      return finish(key, {
        state: 'unavailable',
        command: 'gitnexus analyze --index-only',
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
    const command = `${quoteFor(shellFlavor, cli.shimPath)} analyze --index-only ${quoteFor(shellFlavor, key)}`;

    const controller = new AbortController();
    inFlight.set(key, controller);
    const started: AnalyzeStatus = {
      repoPath: key,
      state: 'running',
      command,
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      message: null,
      output: '',
    };
    runs.set(key, started);

    const spec = shell.resolve({
      command,
      workdir: key,
      timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: outputLimit,
      signal: controller.signal,
      // `sandboxPolicy` is deliberately absent. See the module comment.
    });

    void (async () => {
      let execution: ShellExecutionLike;
      try {
        execution = await shell.execute(spec);
      } catch (cause) {
        // `execute` rejects only for infrastructure failures — an unusable workdir, no
        // shell. A cancellation rejects here too, before a handle exists.
        const aborted = controller.signal.aborted;
        finish(key, {
          state: aborted ? 'cancelled' : 'failed',
          message: aborted ? '已取消。' : `无法启动命令：${String((cause as Error)?.message ?? cause)}`,
        });
        return;
      }

      let result: ShellResultLike;
      try {
        result = await execution.result();
      } catch (cause) {
        finish(key, { state: 'failed', message: `执行失败：${String((cause as Error)?.message ?? cause)}` });
        return;
      }

      const combined = `${result.stdout?.text ?? ''}${result.stderr?.text ?? ''}`;
      const body = tail(combined, tailLimit);
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;

      // Order matters. A denial can also be a non-zero exit, and reporting it as a
      // generic failure sends the operator looking for a GitNexus bug that is not
      // there. Cancellation is checked before timeout because a kill from `cancel()`
      // and a kill from the deadline both surface as a killed process.
      if (controller.signal.aborted) {
        finish(key, { state: 'cancelled', exitCode, output: body, message: '已取消。' });
      } else if (result.timedOut === true) {
        finish(key, {
          state: 'timed-out',
          exitCode,
          output: body,
          message: `超过 ${Math.round(timeoutMs / 1000)} 秒上限已终止。大仓库的全量重建可能需要更长时间。`,
        });
      } else if (looksDenied(combined)) {
        finish(key, {
          state: 'denied',
          exitCode,
          output: body,
          message: '沙箱拒绝了这次写入。本插件不会申请扩权 —— 需要在终端里手动执行这条命令。',
        });
      } else if (exitCode === 0) {
        finish(key, { state: 'done', exitCode, output: body, message: null });
      } else {
        finish(key, {
          state: 'failed',
          exitCode,
          output: body,
          message: `gitnexus 以退出码 ${exitCode ?? '未知'} 结束。`,
        });
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
