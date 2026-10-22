/**
 * The shell-shaped mechanics every spawn in this plugin needs, in one place.
 *
 * Why this module exists
 * ----------------------
 * Six files each carried their own copy of the same two quoting rules
 * (`analyze.ts`, `commands.ts`, `graph.ts`, `install.ts`, `search.ts`, `webview.ts`),
 * and two carried an almost line-for-line copy of the same helper spawn and JSON
 * parse (`search.ts`, `graph.ts`). The copies agreed because they were typed from one
 * memory, not because anything kept them agreeing: a fix to one — a path with a `'`,
 * a UNC path, a Chinese directory name — would have silently left the other five
 * wrong, and the failure mode is a command that runs against the wrong path rather
 * than one that fails loudly.
 *
 * What is deliberately *not* merged: the around-it text. `commands.ts` produces a line
 * an operator pastes; `analyze.ts` produces a line the executor spawns. Those stay in
 * their own modules because they have different audiences and different failure
 * consequences. Only the quoting rule — which is a property of the shell, not of the
 * caller — lives here.
 */
/** Which shell the executor will spawn under. */
export type ShellFlavor = 'win32' | 'posix';

/**
 * The shell flavour for a platform string.
 *
 * `process.platform` is `'win32'` on Windows and something else everywhere POSIX-ish
 * (including `'darwin'`, `'linux'`, and the `'freebsd'` family).
 */
export function shellFlavor(platform: string = process.platform): ShellFlavor {
  return platform === 'win32' ? 'win32' : 'posix';
}

/**
 * Quote one argument as a single-quoted literal for the given shell.
 *
 * Both PowerShell and POSIX shells treat a single-quoted string as literal text, so the
 * only character that needs attention is the quote itself: PowerShell doubles it, POSIX
 * closes the literal, emits an escaped quote, and reopens. Nothing else — `$`, `%`,
 * backticks, backslashes — is special inside single quotes, which is exactly why every
 * spawn in this plugin uses them instead of double quotes.
 */
export function quoteArg(flavor: ShellFlavor, value: string): string {
  return flavor === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `KIND=value …` style environment assignments, in the syntax of the operator's shell.
 *
 * Windows uses `$env:NAME='value'; ` (PowerShell); everywhere else `NAME='value' `. The
 * trailing separator is part of the prefix, so callers can concatenate the command
 * directly. An empty list yields the empty string rather than a stray separator.
 */
export function envPrefix(
  flavor: ShellFlavor,
  pairs: ReadonlyArray<readonly [string, string]>,
): string {
  if (pairs.length === 0) return '';
  const assignments = pairs.map(([name, value]) =>
    flavor === 'win32' ? `$env:${name}=${quoteArg(flavor, value)}` : `${name}=${quoteArg(flavor, value)}`,
  );
  return flavor === 'win32' ? `${assignments.join('; ')}; ` : `${assignments.join(' ')} `;
}

/**
 * Put a quoted head and its argument string together the way this shell needs.
 *
 * PowerShell needs the call operator (`&`) before a quoted path: `'C:\x\gitnexus.cmd'
 * analyze` is not a command, it is a string literal followed by an unexpected token
 * (measured: "表达式或语句中包含意外的标记"). POSIX needs nothing — an absolute path in
 * command position is already a command. `node '<cli>'` is never quoted in head
 * position, so it does not need the operator on either shell.
 */
export function invokeCommand(
  flavor: ShellFlavor,
  head: string,
  args: string,
  options: { viaNode?: boolean } = {},
): string {
  const call = options.viaNode === true || flavor !== 'win32' ? '' : '& ';
  return `${call}${head} ${args}`;
}

/** Keep the last `limit` characters, on a line boundary when one is available. */
export function tailToLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const firstBreak = cut.indexOf('\n');
  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
}

/** Keep the last `limit` characters, without looking for a line boundary. */
export function tailChars(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * A sandbox refusal, recognised from the marker DSH writes into the output.
 *
 * The marker is the only reliable signal. An earlier revision also matched a bare
 * `EPERM`, which is how a transient Windows file lock got reported as "the sandbox
 * refused this write" — and the operator was told to stop trying, when retrying was
 * the answer. Callers that genuinely want the broader reading use
 * {@link looksPermissionDenied}.
 */
export function looksDeniedBySandbox(text: string): boolean {
  return /\[sandbox:[^\]]*denied/i.test(text) || /access is denied/i.test(text);
}

/**
 * Sandbox refusal *or* an ordinary permission error.
 *
 * Right for an install, where `EACCES`/`EPERM` from npm really is "this location is not
 * writable"; wrong for an analyze, where the same codes also mean a lock someone will
 * release. The two predicates used to be two identically-named copies in two modules,
 * which made the difference look like an accident.
 */
export function looksPermissionDenied(text: string): boolean {
  return looksDeniedBySandbox(text) || /\bEPERM\b|\bEACCES\b/i.test(text);
}

/** A graph row's line number, whether the driver hands back a number or a bigint. */
export function readLineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return null;
}

/**
 * Parse a helper's one-object stdout without assuming it is the very first byte.
 *
 * Node or GitNexus can write a warning to stdout before our payload. Taking the first
 * `{` to the last `}` is deliberately forgiving of that, while a missing object still
 * becomes a typed failure rather than an empty result.
 */
export function parseHelperOutput(text: string): Record<string, unknown> | null {
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

/**
 * ` (exit 1)：<stderr tail>` — the part of a helper failure message that names why.
 *
 * An absent exit code (the executor may report none) contributes nothing, so the
 * caller's sentence stays grammatical either way.
 */
export function exitDetail(
  exitCode: number | null | undefined,
  stderr: string,
  stderrLimit = 600,
): string {
  const text = stderr.trim().slice(-stderrLimit);
  const exit = exitCode === undefined || exitCode === null ? '' : ` (exit ${String(exitCode)})`;
  return text === '' ? exit : `${exit}：${text}`;
}

/**
 * The slice of `ctx.shell` this plugin uses.
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
  /**
   * A policy the host resolved for this call. Runners forward it unchanged and never
   * build one; see the analyze module comment for why the workspace root has to travel
   * with the call at all.
   */
  sandboxPolicy?: unknown;
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

/** What one helper process did, as far as the caller can tell. */
export type HelperRun =
  | { kind: 'ok'; stdout: string; stderr: string; exitCode: number | null | undefined }
  | { kind: 'timed-out' }
  /** The executor refused or could not start the process at all. */
  | { kind: 'spawn-failed'; message: string };

export interface HelperRunOptions {
  shell: ShellLike;
  command: string;
  workdir: string;
  timeoutMs: number;
  stdoutMaxBytes: number;
  sandboxPolicy?: unknown;
}

/**
 * Run one short-lived helper to completion.
 *
 * Returns a union instead of throwing so each caller can attach its own error type and
 * its own sentence: a graph failure and a search failure mean different things to the
 * operator even when the process behaved identically. `onExpiry: 'kill'` is right here
 * and wrong for the web server, which needs `'none'` and keeps its handle — subprocess
 * lifetimes are per-caller, not per-helper.
 */
export async function runHelper(options: HelperRunOptions): Promise<HelperRun> {
  let execution: ShellExecutionLike;
  try {
    const spec = options.shell.resolve({
      command: options.command,
      workdir: options.workdir,
      timeoutMs: options.timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: options.stdoutMaxBytes,
      ...(options.sandboxPolicy === undefined ? {} : { sandboxPolicy: options.sandboxPolicy }),
    });
    execution = await options.shell.execute(spec);
  } catch (cause) {
    return { kind: 'spawn-failed', message: cause instanceof Error ? cause.message : String(cause) };
  }

  let result: ShellResultLike;
  try {
    result = await execution.result();
  } catch (cause) {
    return { kind: 'spawn-failed', message: cause instanceof Error ? cause.message : String(cause) };
  }

  if (result.timedOut === true) return { kind: 'timed-out' };
  return {
    kind: 'ok',
    stdout: typeof result.stdout?.text === 'string' ? result.stdout.text : '',
    stderr: typeof result.stderr?.text === 'string' ? result.stderr.text : '',
    exitCode: result.exitCode,
  };
}
