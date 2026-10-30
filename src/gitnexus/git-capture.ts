/**
 * Run `git` with its output redirected to files instead of pipes.
 *
 * `execFile` and `exec` both need a named pipe to carry stdout, and a confined host
 * — the DSH sandbox, and any Windows service that starts children in a restricted
 * token — refuses to create one. The failure surfaces as `spawn EPERM` before git runs,
 * which reads as "git is missing" when git is in fact installed and working. Pointing
 * the child's stdout at a regular file avoids the pipe entirely, so this is the only
 * way this plugin can read git in the environment it ships for.
 *
 * stdout and stderr get separate files on purpose. git writes advisories to stderr —
 * `warning: in the working copy of 'a.ts', LF will be replaced by CRLF` is the common
 * one on Windows — and a caller parsing a `-z` name list must never see them as paths.
 *
 * Everything here is deliberate:
 * - no shell: `args` reaches git verbatim, and the repository path travels as `cwd`
 * - the host's own spawner is tried first, and the file-descriptor path second: a host
 *   that refuses an unconfined spawn through its seam is exactly the case the fd path
 *   exists for, so a seam failure must not be the end of the story
 * - temp files live inside the workspace (`<repo>/.gitnexus/plugin-home/tmp`) with the
 *   system temp directory as the fallback: a host process is often the one component
 *   that may not write to `os.tmpdir()`
 * - the size cap replaces `maxBuffer`: a file that large means a runaway command
 * - the last failure is kept in module state, because every caller here reduces the
 *   answer to stdout-or-null, and "git said nothing" and "git never ran" are not the
 *   same fact to a reader staring at a panel
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, isSandboxLike, isSubprocessLike, type Runner } from '../subprocess.js';
import { storageIsUsable } from './storage-state.js';

export interface GitCaptureOptions {
  /** Kill the child after this long. Defaults to `DEFAULT_GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Refuse stdout larger than this. Defaults to 32 MB: a name list needs megabytes on
   * a big repository, and anything past this is a candidate set the caller caps anyway.
   */
  maxBytes?: number;
}

/**
 * The host services that own process creation, resolved lazily.
 *
 * git is read by four modules — anchoring, the delta gate, the git state card and the
 * activity list — none of which holds a host context, and all of whose option objects
 * would have to grow a field to carry one. So the seam is installed once by the plugin
 * entry as a *provider* rather than a value: a profile may mount `ctx.subprocess` after
 * this plugin applies, and a provider read at call time sees it, while a captured value
 * would not.
 *
 * When no provider is installed — a unit test, a probe script, a helper process — the
 * file-descriptor spawn below is used, which is what every one of those contexts needs.
 */
export type GitSeamProvider = () => { subprocess?: unknown; sandbox?: unknown } | null;

let seamProvider: GitSeamProvider | null = null;

/** Install (or clear) the host seam provider. Called by the plugin entry. */
export function provideGitSeams(provider: GitSeamProvider | null): void {
  seamProvider = provider;
}

/** One failed read, kept so the panel can say *why* git was unreadable. */
export interface GitFailureNote {
  /** The argv the call tried, joined for display: `git rev-parse HEAD`. */
  command: string;
  /** Whatever {@link GitCapture.failure} carried, or a combination of both attempts. */
  failure: string;
}

let lastFailure: GitFailureNote | null = null;

/**
 * The most recent git read that failed, or `null` if the last one worked.
 *
 * This exists because every reader in this plugin (`git.ts`, `git-activity.ts`,
 * `delta.ts`, `anchor.ts`) deliberately collapses a failed capture to `null`, which is
 * right for their own logic and wrong for the operator: a panel that says "git
 * unavailable" without naming `EPERM` or `exit 128` cannot be diagnosed, and 0.1.7
 * shipped exactly that. Recording the note here costs one assignment and lets the
 * report carry the sentence.
 */
export function lastGitFailure(): GitFailureNote | null {
  return lastFailure;
}

/** Clear the recorded failure. Tests use it; nothing in the plugin needs to. */
export function forgetGitFailure(): void {
  lastFailure = null;
}

/**
 * Is `git` running outside this check? No.
 *
 * No sandbox policy is forwarded here, and that is deliberate rather than an omission:
 * the four readers never resolve one, and a policy invented at this layer would name the
 * wrong root. What matters for confinement is *who spawns*: through `ctx.subprocess` the
 * child belongs to the host's own process boundary, which is the point of using the seam.
 */
function hostRunner(): Runner | null {
  const seams = seamProvider?.() ?? null;
  if (seams === null || !isSubprocessLike(seams.subprocess)) return null;
  const runner = createRunner({
    subprocess: seams.subprocess,
    sandbox: isSandboxLike(seams.sandbox) ? seams.sandbox : null,
    shell: null,
  });
  // The shell path exists to hold a command string. git arrives as argv and is safer
  // that way, so a runner that would fall back to a shell is not used here.
  return runner.argvOnly ? runner : null;
}

/** What one runner outcome means in this module's vocabulary. */
function fromRun(outcome: Awaited<ReturnType<Runner['run']>>, maxBytes: number): GitCapture {
  if (outcome.kind === 'ok') {
    const text = outcome.stdout;
    if (text.length > maxBytes) return { ok: false, text: '', stderr: outcome.stderr, failure: 'oversize' };
    const code = outcome.exitCode;
    if (code === null || code === undefined || code === 0) {
      return { ok: true, text, stderr: outcome.stderr, failure: null };
    }
    return { ok: false, text, stderr: outcome.stderr, failure: `exit ${code}` };
  }
  if (outcome.kind === 'timed-out') return { ok: false, text: '', stderr: '', failure: 'timeout' };
  if (outcome.kind === 'cancelled') return { ok: false, text: '', stderr: '', failure: 'cancelled' };
  return { ok: false, text: '', stderr: '', failure: outcome.message };
}

export interface GitCapture {
  ok: boolean;
  /** Decoded stdout. `''` when the call failed or printed nothing. */
  text: string;
  /** Advisory and error output, decoded. Never part of `text`. */
  stderr: string;
  /**
   * Why the call failed: `EPERM`, `timeout`, `exit 128`, `oversize`, or a read error.
   * `null` on success.
   */
  failure: string | null;
}

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

let counter = 0;

/**
 * Where this call's two temp files go.
 *
 * Inside the workspace first: a host process is frequently the one component that is
 * refused permission to write to the system temp directory (the same confinement that
 * denies the pipe), while `<repo>/.gitnexus/` is a directory GitNexus itself owns and
 * the repository's own `.gitignore` covers. `os.tmpdir()` stays as the fallback for a
 * repo that is read-only — a capture against it will fail anyway, but the failure
 * should be git's, not the scratch directory's.
 *
 * Never create that directory in a checkout GitNexus has no manifest for, though: 1.6.13
 * inspects `.gitnexus` before every write and calls anything beside its own lock
 * artifacts, with no manifest, the "unowned" state — then refuses to analyze the repo at
 * all. A git capture is not worth breaking a later `gitnexus analyze` over, so an
 * un-owned checkout gets the system temp directory.
 */
function scratchDirFor(repoPath: string): string {
  if (!storageIsUsable(repoPath)) return os.tmpdir();
  const inside = path.join(repoPath, '.gitnexus', 'plugin-home', 'tmp');
  try {
    mkdirSync(inside, { recursive: true });
    return inside;
  } catch {
    return os.tmpdir();
  }
}

/** One temp file name, unique per call within this process. */
function scratchPath(dir: string, suffix: string): string {
  counter += 1;
  return path.join(dir, `git-${process.pid}-${counter}${suffix}`);
}

/**
 * Is this failure about *reaching* git, as opposed to git's own answer?
 *
 * `exit 128` means git ran and said "not a repository"; retrying that through another
 * spawner would cost a process and return the same sentence. `EPERM`, a refused spawn,
 * a failed open and a timeout all mean the call never got an answer — those are worth
 * the second attempt.
 */
function looksUnreachable(failure: string | null): boolean {
  if (failure === null || failure === '') return false;
  if (/^exit \d+$/.test(failure)) return false;
  if (failure === 'oversize') return false;
  return true;
}

/** Remember the failure for {@link lastGitFailure}, and return the same result. */
function note(failure: GitCapture, command: string): GitCapture {
  lastFailure = failure.ok || failure.failure === null ? null : { command, failure: failure.failure };
  return failure;
}

/**
 * Run one git command and capture everything it printed.
 *
 * Never throws: a repository without git, a missing binary, a timeout and a
 * non-zero exit are all ordinary answers here, and the caller decides what they mean.
 */
export async function captureGit(
  repoPath: string,
  args: readonly string[],
  options: GitCaptureOptions = {},
): Promise<GitCapture> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const command = ['git', ...args].join(' ');

  // The host's own spawner first: same argv, no shell, and the child belongs to the
  // host's process boundary instead of this module's.
  const runner = hostRunner();
  if (runner !== null) {
    let viaSeam: GitCapture;
    try {
      viaSeam = fromRun(await runner.run({ argv: ['git', ...args], cwd: repoPath, timeoutMs, maxBytes }), maxBytes);
    } catch (error) {
      viaSeam = { ok: false, text: '', stderr: '', failure: describe(error) };
    }
    if (viaSeam.ok || !looksUnreachable(viaSeam.failure)) return note(viaSeam, command);
    // The seam could not reach git. The fd path is the whole reason this module
    // exists, so try it before reporting the refusal — and report both if it fails too.
    const viaFile = await captureViaFiles(repoPath, args, timeoutMs, maxBytes);
    if (viaFile.ok) return note(viaFile, command);
    return note({ ...viaFile, failure: `seam: ${viaSeam.failure}; file: ${viaFile.failure}` }, command);
  }

  return note(await captureViaFiles(repoPath, args, timeoutMs, maxBytes), command);
}

/** The file-descriptor path: the child's stdout/stderr land in two regular files. */
async function captureViaFiles(
  repoPath: string,
  args: readonly string[],
  timeoutMs: number,
  maxBytes: number,
): Promise<GitCapture> {
  const dir = scratchDirFor(repoPath);
  const outFile = scratchPath(dir, '.out');
  const errFile = scratchPath(dir, '.err');

  let outFd: number | undefined;
  let errFd: number | undefined;
  try {
    outFd = openSync(outFile, 'w');
    errFd = openSync(errFile, 'w');
  } catch (error) {
    closeQuietly(outFd);
    closeQuietly(errFd);
    rmQuietly(outFile);
    rmQuietly(errFile);
    return { ok: false, text: '', stderr: '', failure: `open: ${describe(error)}` };
  }

  try {
    return await new Promise<GitCapture>((resolve) => {
      let settled = false;
      const settle = (result: GitCapture) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn('git', args as string[], {
          cwd: repoPath,
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
        });
      } catch (error) {
        settle({ ok: false, text: '', stderr: '', failure: describe(error) });
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        settle({ ok: false, text: '', stderr: '', failure: 'timeout' });
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        // The platform refusal lands here on most Node versions and as a throw on
        // others; both mean the same thing to the caller.
        settle({ ok: false, text: '', stderr: '', failure: describe(error) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        let text: string;
        let stderr: string;
        try {
          text = readFileSync(outFile, 'utf8');
          stderr = readFileSync(errFile, 'utf8');
        } catch (error) {
          settle({ ok: false, text: '', stderr: '', failure: `read: ${describe(error)}` });
          return;
        }
        if (text.length > maxBytes) {
          settle({ ok: false, text: '', stderr, failure: 'oversize' });
          return;
        }
        if (code !== 0) {
          settle({ ok: false, text, stderr, failure: `exit ${code ?? 'unknown'}` });
          return;
        }
        settle({ ok: true, text, stderr, failure: null });
      });
    });
  } finally {
    closeQuietly(outFd);
    closeQuietly(errFd);
    rmQuietly(outFile);
    rmQuietly(errFile);
  }
}

/**
 * `captureGit`, reduced to the one thing every caller here wants: stdout, or `null`
 * when git could not answer.
 */
export async function gitText(
  repoPath: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<string | null> {
  const result = await captureGit(repoPath, args, { timeoutMs });
  return result.ok ? result.text : null;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Already closed by the child's exit; nothing to do.
  }
}

function rmQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // A leftover temp file is not worth failing a read over.
  }
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
