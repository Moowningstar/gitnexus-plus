/**
 * One runner for every short-lived process this plugin starts.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin grew three different ways to start a child: `runHelper` through
 * `ctx.shell`, a bare `spawn` inside `git-capture.ts`, and the web server's own
 * long-lived spawn. Each one learned the same lessons separately — a command string is a
 * shell program, a pipe is refused by a confined host, an abort signal has to be
 * forwarded or the tool body never settles when the caller walks away.
 *
 * The host offers the seam those lessons belong to: `ctx.subprocess`. It takes `argv`
 * (never a shell string, so nothing is re-parsed), collects stdout without a pipe, and
 * accepts a signal. When a sandbox policy is present it must be honoured through
 * `ctx.sandbox.confine` — the host's rule is that a confined policy may not be passed
 * through silently unconfined. So the preconditions for the argv path are:
 *
 *   1. `subprocess.spawn` exists, and
 *   2. if a policy is present, `sandbox.confine` exists (or the policy is
 *      `danger-full-access`, which is defined as "do not confine").
 *
 * Anything else falls back to `ctx.shell`, which is the path this plugin has been
 * shipping and testing since 0.1.2. The fallback is not a courtesy: a host that exposes
 * a `subprocess` whose handle shape differs from the documented one must degrade to a
 * path that works rather than answer "spawn failed" to every graph question. That is
 * why the argv path is written defensively — no shape assumption is allowed to throw
 * past `run()`.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The long-lived web server (it needs `onExpiry: 'none'` and a handle it can keep) and
 * the maintenance CLI runs (they are user-visible one-shots with their own output
 * capture and their own cancellation story). Those keep using `ctx.shell` directly
 * until `ctx.jobs` is wired.
 */
import {
  envPrefix,
  invokeCommand,
  quoteArg,
  runHelper,
  shellFlavor,
  type HelperRun,
  type ShellLike,
} from './shell.js';

/** The modes DSH documents for `ctx.sandboxPolicy.resolve`. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The slice of `SandboxExecutionPolicy` this module reads. */
export interface SandboxPolicyLike {
  mode?: SandboxMode;
  workspaceRoot?: string;
}

/** What `ctx.sandbox.confine` returns, as far as this plugin consumes it. */
export interface ConfinedArgvLike {
  argv?: readonly string[];
  enforcement?: 'full' | 'partial';
  denialSignatures?: readonly string[];
}

/** The slice of `ctx.sandbox` this module uses. Structural: no host import. */
export interface SandboxLike {
  confine(
    argv: readonly string[],
    policy: unknown,
    signal?: AbortSignal,
  ): ConfinedArgvLike | Promise<ConfinedArgvLike>;
}

/** A collected stream: `readFrom(offset)` reads from the start, not from a cursor. */
export interface SubprocessStreamLike {
  readFrom(offset: number): unknown;
}

export interface SubprocessCollectedLike {
  stdout?: SubprocessStreamLike | null;
  stderr?: SubprocessStreamLike | null;
}

/**
 * A handle, in whichever shape the host provides it.
 *
 * The documentation guarantees `collected.stdout.readFrom(0)` and a signal; the
 * completion shape is read defensively below (`result()`, then `exited`, then `on`).
 */
export interface SubprocessHandleLike {
  collected?: SubprocessCollectedLike | null;
  result?(): Promise<unknown>;
  exited?: Promise<unknown> | null;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  kill?(): unknown;
}

export interface SubprocessSpecLike {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  stdio?: unknown;
  graceMs?: number;
  signal?: AbortSignal;
}

/** The slice of `ctx.subprocess` this module uses. Structural: no host import. */
export interface SubprocessLike {
  spawn(spec: SubprocessSpecLike): SubprocessHandleLike | Promise<SubprocessHandleLike>;
  /**
   * Resolve a bare command name to an absolute path.
   *
   * Present because `argv[0]` is not interpreted by a shell on this path: `node` has to
   * become `C:\…\node.exe` before the host can start it. Absent on a minimal seam —
   * then the bare name is passed through and the host has to resolve it itself.
   */
  resolveExecutable?(
    command: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ): string | Promise<string>;
}

/** One process, described the way the caller thinks about it. */
export interface RunRequest {
  /** `argv[0]` is the executable; nothing here is ever re-parsed by a shell. */
  argv: readonly string[];
  cwd: string;
  /** Environment additions, applied on both paths. */
  env?: ReadonlyArray<readonly [string, string]>;
  timeoutMs: number;
  /** Cap on captured stdout. The shell path forwards it as `stdoutMaxBytes`. */
  maxBytes: number;
  signal?: AbortSignal;
  /** The policy for the workspace this run touches. Forwarded or confine()d. */
  sandboxPolicy?: unknown;
}

/** Same union as `runHelper`: every caller already knows how to read it. */
export type RunOutcome = HelperRun;

export interface RunnerSeams {
  subprocess?: SubprocessLike | null;
  sandbox?: SandboxLike | null;
  shell?: ShellLike | null;
}

/**
 * Whether a host service is shaped like `ctx.subprocess`.
 *
 * Checked rather than asserted because the plugin declares no dependency on the DSH
 * packages: a profile that mounts something else under that name must degrade to the
 * shell path, not throw on the first graph query.
 */
export function isSubprocessLike(value: unknown): value is SubprocessLike {
  if (value === null || typeof value !== 'object') return false;
  return typeof (value as { spawn?: unknown }).spawn === 'function';
}

/** Whether a host service is shaped like `ctx.sandbox` (its `confine` is the door). */
export function isSandboxLike(value: unknown): value is SandboxLike {
  if (value === null || typeof value !== 'object') return false;
  return typeof (value as { confine?: unknown }).confine === 'function';
}

export interface Runner {
  /**
   * True when this runner intends to put argv on the child without a shell in between.
   *
   * A seam that exists but does not behave as documented falls back per call, so this
   * describes the host's capability, not the outcome of any particular call.
   */
  readonly argvOnly: boolean;
  run(request: RunRequest): Promise<RunOutcome>;
}

/** Plain text out of whatever a collector hands back. */
function decodeChunk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value !== null && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function readStream(stream: SubprocessStreamLike | null | undefined): string {
  if (stream === null || stream === undefined || typeof stream.readFrom !== 'function') return '';
  try {
    return decodeChunk(stream.readFrom(0));
  } catch {
    return '';
  }
}

function pickNumber(value: unknown, keys: readonly string[]): number | null {
  if (value === null || typeof value !== 'object') return null;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

/** Raised when a seam is present but does not behave as documented. Never escapes. */
class UnsupportedSeam extends Error {}

/**
 * Wait for one spawned handle to finish.
 *
 * Order matters: `result()` is the shell-execution shape, `exited` is the documented
 * collection shape, and `on('close')` is the last resort. An unrecognised handle is an
 * unsupported seam, not a failed command.
 */
async function waitForExit(handle: SubprocessHandleLike): Promise<unknown> {
  if (typeof handle.result === 'function') return await handle.result();
  if (handle.exited !== null && handle.exited !== undefined) return await handle.exited;
  if (typeof handle.on === 'function') {
    const on = handle.on.bind(handle);
    return await new Promise<unknown>((resolve, reject) => {
      on('error', (cause: unknown) => {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
      on('close', (code: unknown) => {
        resolve({ exitCode: code });
      });
    });
  }
  throw new UnsupportedSeam('子进程句柄既没有 result()，也没有 exited 或事件');
}

/** The policy mode, when the policy says one. */
function policyMode(policy: unknown): SandboxMode | null {
  if (policy === null || typeof policy !== 'object') return null;
  const mode = (policy as { mode?: unknown }).mode;
  return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access' ? mode : null;
}

/**
 * Build the runner for one host.
 *
 * Each call resolves the seams it was given; the plugin passes `shell` on every call so
 * a test can substitute one, and the subprocess path is used only when the host
 * supplied it.
 */
export function createRunner(seams: RunnerSeams): Runner {
  const subprocess = seams.subprocess ?? null;
  const sandbox = seams.sandbox ?? null;
  const shell = seams.shell ?? null;
  const argvOnly = subprocess !== null && typeof subprocess.spawn === 'function';

  async function viaSubprocess(request: RunRequest): Promise<RunOutcome> {
    if (subprocess === null || typeof subprocess.spawn !== 'function') throw new UnsupportedSeam('没有 subprocess');

    const env = request.env === undefined ? undefined : Object.fromEntries(request.env);
    let argv: readonly string[] = request.argv;

    // `node` in command position means nothing to a shell-less spawn: resolve it first.
    const head = argv[0];
    if (head !== undefined && !/[\\/]/.test(head) && typeof subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await subprocess.resolveExecutable(head, env, request.signal);
        if (typeof resolved === 'string' && resolved !== '') argv = [resolved, ...argv.slice(1)];
      } catch {
        // Keeping the bare name is the right degradation: the host may still resolve it.
      }
    }

    let denialSignatures: readonly string[] = [];
    if (request.sandboxPolicy !== undefined && policyMode(request.sandboxPolicy) !== 'danger-full-access') {
      if (sandbox === null || typeof sandbox.confine !== 'function') {
        // The host's rule: a confined policy may not be passed through unconfined.
        throw new UnsupportedSeam('有沙箱策略但没有 ctx.sandbox.confine，不能静默不隔离');
      }
      const confined = await sandbox.confine(argv, request.sandboxPolicy, request.signal);
      if (confined !== null && typeof confined === 'object' && Array.isArray(confined.argv)) {
        argv = confined.argv;
      }
      if (Array.isArray(confined?.denialSignatures)) denialSignatures = confined.denialSignatures;
    }

    let handle: SubprocessHandleLike | null = null;
    try {
      handle = await subprocess.spawn({
        argv,
        cwd: request.cwd,
        ...(env === undefined ? {} : { env }),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: request.maxBytes, spill: true },
          stderr: { maxBytes: request.maxBytes },
        },
        graceMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (cause) {
      // A refusal to start is the command's answer, not this module's exception — the
      // same rule `runHelper` follows. A TypeError/ReferenceError is different: it means
      // the seam lacks the shape it documents, which is the fallback's decision.
      if (cause instanceof Error && (cause.name === 'TypeError' || cause.name === 'ReferenceError')) {
        throw new UnsupportedSeam(cause.message);
      }
      return { kind: 'spawn-failed', message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (handle === null || typeof handle !== 'object') throw new UnsupportedSeam('spawn 没有返回句柄');

    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        try {
          void handle.kill?.();
        } catch {
          // The handle may already be gone; the timeout verdict stands either way.
        }
        resolve();
      }, request.timeoutMs);
    });

    let settled: unknown;
    try {
      settled = await Promise.race([waitForExit(handle), deadline.then(() => undefined)]);
    } catch (cause) {
      if (cause instanceof UnsupportedSeam) throw cause;
      // A TypeError/ReferenceError here is a shape mismatch (wrong property, missing
      // method), which is the seam's problem rather than the command's. An ordinary
      // error is the child's, and belongs to the caller.
      if (cause instanceof Error && (cause.name === 'TypeError' || cause.name === 'ReferenceError')) {
        throw new UnsupportedSeam(cause.message);
      }
      return { kind: 'spawn-failed', message: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (expired) return { kind: 'timed-out' };
    if (request.signal?.aborted === true) return { kind: 'cancelled' };

    const stdout = readStream(handle.collected?.stdout);
    const stderr = readStream(handle.collected?.stderr);
    const exitCode = pickNumber(settled, ['exitCode', 'code', 'status']);
    const denial = denialSignatures.find((signature) => signature !== '' && stderr.includes(signature));
    if (denial !== undefined) return { kind: 'spawn-failed', message: `沙箱拒绝执行（${denial}）` };
    return { kind: 'ok', stdout, stderr, exitCode };
  }

  /** `node 'a' 'b'` / `& 'C:\x.exe' 'a'` — the command string the shell path needs. */
  function shellCommand(argv: readonly string[], env: ReadonlyArray<readonly [string, string]>): string {
    const [head, ...rest] = argv;
    if (head === undefined) return '';
    const flavor = shellFlavor();
    const headIsPath = /[\\/]/.test(head);
    const headText = headIsPath ? quoteArg(flavor, head) : head;
    const args = rest.map((value) => quoteArg(flavor, value)).join(' ');
    // `invokeCommand` adds the PowerShell call operator only for a quoted head, which is
    // exactly the `headIsPath` case; a bare `node`/`git` must not get one.
    const command = invokeCommand(flavor, headText, args, { viaNode: !headIsPath });
    return `${envPrefix(flavor, env)}${command}`;
  }

  async function viaShell(request: RunRequest): Promise<RunOutcome> {
    if (shell === null) {
      return { kind: 'spawn-failed', message: '当前部署既没有 subprocess 也没有 shell 执行器，无法启动子进程。' };
    }
    return await runHelper({
      shell,
      command: shellCommand(request.argv, request.env ?? []),
      workdir: request.cwd,
      timeoutMs: request.timeoutMs,
      stdoutMaxBytes: request.maxBytes,
      ...(request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    argvOnly,
    async run(request: RunRequest): Promise<RunOutcome> {
      if (request.signal?.aborted === true) return { kind: 'cancelled' };
      if (argvOnly) {
        try {
          return await viaSubprocess(request);
        } catch (cause) {
          if (!(cause instanceof UnsupportedSeam)) throw cause;
          // Fall through: a seam that does not match the documentation is not a reason
          // to fail a read, only a reason to use the path that works.
        }
      }
      return await viaShell(request);
    },
  };
}

/** A runner over `ctx.shell` only — what every test stub and helper process gets. */
export function shellRunner(shell: ShellLike | null): Runner {
  return createRunner({ shell });
}
