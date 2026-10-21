/**
 * Install GitNexus on this machine, on the operator's explicit instruction.
 *
 * WHY THE PLUGIN DOES THIS ITSELF
 * -------------------------------
 * The plugin reads `.gitnexus/gitnexus.json` — a file that only GitNexus can produce,
 * containing every function definition, symbol relationship and execution flow. Without
 * it there is nothing to display, and no amount of scanning the working tree substitutes
 * for it. So "the user has no GitNexus" is not a degraded state to design around; it is
 * a missing prerequisite, and the most useful thing the plugin can do about it is offer
 * to satisfy it.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not download anything itself, and it does not pick a registry. It runs `npm
 * install` and lets npm use whatever registry the machine is already configured for —
 * a mirror, a corporate feed, a local Verdaccio. Hardcoding one would break exactly the
 * users whose network is the reason they need this path, and the operator's `.npmrc` is
 * the only authority on where their packages come from.
 *
 * It also does not build anything itself. npm runs the dependency install scripts that
 * GitNexus needs (`@ladybugdb/core`, `tree-sitter`, its own grammar build) — which is
 * why this uses npm rather than pnpm, whose ≥10 line refuses dependency build scripts by
 * default and would fail the install in a way the operator could not act on.
 *
 * INSTALL LOCATION
 * ----------------
 * A directory the plugin owns (`$DSH_HOME/gitnexus-plus/gitnexus`), never the global
 * prefix. A global install needs elevation on Windows and would collide with a GitNexus
 * the operator already has. A plugin-owned copy is removable, self-describing, and does
 * not make the plugin responsible for someone else's global state.
 *
 * The cost is real and the confirmation must state it: roughly 500 MB to 1 GB, several
 * minutes, network access, and the package's build scripts running on this machine.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ShellLike } from './analyze.js';

export type InstallState =
  | 'running'
  | 'done'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  /** The sandbox refused a write. Reported, never retried wider. */
  | 'denied'
  /** No shell executor in this deployment, so nothing can be installed. */
  | 'unavailable';

export interface InstallStatus {
  state: InstallState;
  /** The command as run, so a failure can be reproduced by hand. */
  command: string;
  /** Where it installs to. */
  prefix: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  message: string | null;
  output: string;
}

/** The version range this plugin is known to work against. */
export const GITNEXUS_RANGE = '^1.6.12';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TAIL_LIMIT = 6 * 1024;

export interface InstallRunnerOptions {
  shell: ShellLike | null;
  /** Install target. Defaults to `$DSH_HOME/gitnexus-plus/gitnexus`. */
  prefix?: string;
  /** Version spec passed to npm. */
  spec?: string;
  timeoutMs?: number;
  outputLimit?: number;
  tailLimit?: number;
  /** How long to wait for the completion notice, for tests. */
  now?: () => number;
  /** Platform whose shell syntax applies. */
  platform?: NodeJS.Platform;
  /**
   * The deployment policy for the install target.
   *
   * A panel route has no session, so the deployment default is the DSH application
   * directory. On Windows that directory is under Program Files, and the ACL runner
   * cannot grant workspace-write there. The install writes only under `prefix`, so the
   * host supplies a policy rooted at `prefix` — the same shape it supplies to analyze
   * and the helpers. The mode is forwarded unchanged.
   */
  sandboxPolicy?: (prefix: string) => unknown;
}

export interface InstallRunner {
  start(): InstallStatus;
  status(): InstallStatus | null;
  cancel(): boolean;
  /** Where a successful install puts the CLI. */
  cliPath(): string;
  dispose(): void;
}

/**
 * The default install target.
 *
 * Under `DSH_HOME` rather than under the plugin, because a profile-installed plugin
 * lives inside `node_modules` and writing a 500 MB tree there would be lost on the next
 * install and would confuse the package manager's own bookkeeping.
 */
export function defaultInstallPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'gitnexus-plus', 'gitnexus');
}

/** Quote one argument for the shell the executor spawns. */
function quote(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The `npm install` line, as the shell will read it.
 *
 * `--prefix` rather than `cd`: the working directory stays wherever the executor put it,
 * so a failed install cannot leave a half-written tree in the operator's project. No
 * `--registry` on purpose — see the module comment.
 */
export function installCommandLine(
  prefix: string,
  spec: string,
  options: { platform?: NodeJS.Platform; cacheDir?: string } = {},
): string {
  const platform = options.platform ?? process.platform;
  // npm's ambient cache is under the user profile, outside the install target. A
  // workspace-write sandbox rooted at the prefix would deny those writes, so keep the
  // cache inside the granted tree; it is also easier to remove with the install.
  const cacheDir = options.cacheDir ?? path.join(prefix, '.npm-cache');
  const args = ['install', '--prefix', quote(prefix, platform), spec, '--no-audit', '--no-fund'];
  const cache = quote(cacheDir, platform);
  return platform === 'win32'
    ? `$env:npm_config_cache=${cache}; npm ${args.join(' ')}`
    : `npm_config_cache=${cache} npm ${args.join(' ')}`;
}

/** Keep the last `limit` characters, on a line boundary when one is available. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const firstBreak = cut.indexOf('\n');
  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
}

function looksDenied(text: string): boolean {
  return /\[sandbox:[^\]]*denied/i.test(text) || /access is denied|EPERM|EACCES/i.test(text);
}

export function createInstallRunner(options: InstallRunnerOptions): InstallRunner {
  const { shell } = options;
  const platform = options.platform ?? process.platform;
  const prefix = options.prefix ?? defaultInstallPrefix();
  const spec = options.spec ?? `gitnexus@${GITNEXUS_RANGE}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
  const now = options.now ?? (() => Date.now());

  let status: InstallStatus | null = null;
  let controller: AbortController | null = null;

  const cliPath = (): string => path.join(prefix, 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js');

  /** The shape a status starts from, before any attempt has touched it. */
  const BLANK: Omit<InstallStatus, never> = {
    state: 'failed',
    command: '',
    prefix,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    message: null,
    output: '',
  };

  const finish = (patch: Partial<InstallStatus>): InstallStatus => {
    status = {
      ...BLANK,
      ...status,
      ...patch,
      // Set last and unconditionally: every path here is finishing, so a caller passing
      // `finishedAt: null` means "not finished", not a silent no-op.
      finishedAt: patch.finishedAt ?? now(),
    };
    controller = null;
    return status;
  };

  const start = (): InstallStatus => {
    if (status !== null && status.state === 'running') return status;

    if (shell === null) {
      return finish({
        state: 'unavailable',
        command: installCommandLine(prefix, spec, { platform }),
        startedAt: now(),
        message: '当前部署没有提供 shell 执行器，无法安装。请手动执行下面列出的命令。',
      });
    }

    const command = installCommandLine(prefix, spec, { platform });

    let sandboxPolicy: unknown;
    try {
      sandboxPolicy = options.sandboxPolicy?.(prefix);
    } catch {
      sandboxPolicy = undefined;
    }
    const policyMode =
      sandboxPolicy !== null && typeof sandboxPolicy === 'object'
        ? (sandboxPolicy as { mode?: unknown }).mode
        : undefined;
    if (policyMode === 'read-only') {
      return finish({
        state: 'unavailable',
        command,
        startedAt: now(),
        message:
          '当前部署是只读沙箱，安装需要写入安装目录。请复制下面的命令，在普通终端执行。',
      });
    }

    // The sandbox grant is applied to the prefix itself, so it must exist before the
    // grant materializes. The plugin owns this directory; creating it is the one step
    // an install would do anyway. The policy above does not need it to exist.
    try {
      mkdirSync(prefix, { recursive: true });
    } catch (cause) {
      return finish({
        state: 'failed',
        command,
        startedAt: now(),
        message:
          `无法创建安装目录 ${prefix}：${String((cause as Error)?.message ?? cause)}。` +
          '请复制下面的命令，在普通终端执行。',
      });
    }

    const abort = new AbortController();
    controller = abort;
    status = {
      state: 'running',
      command,
      prefix,
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      message: null,
      output: '',
    };

    let spec0;
    try {
      spec0 = shell.resolve({
        command,
        timeoutMs,
        onExpiry: 'kill',
        stdoutMaxBytes: outputLimit,
        signal: abort.signal,
        // Rooted at the install target, not the DSH application directory: a no-session
        // route otherwise inherits a root under Program Files, where the Windows ACL
        // runner fails before the install starts.
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      });
    } catch (cause) {
      return finish({
        state: 'failed',
        command,
        startedAt: now(),
        message:
          `无法在沙箱中启动安装：${String((cause as Error)?.message ?? cause)}。` +
          '请复制下面的命令，在普通终端执行。',
      });
    }

    void (async () => {
      let execution;
      try {
        execution = await shell.execute(spec0);
      } catch (cause) {
        const aborted = abort.signal.aborted;
        finish({
          state: aborted ? 'cancelled' : 'failed',
          message: aborted ? '已取消。' : `无法启动安装：${String((cause as Error)?.message ?? cause)}`,
        });
        return;
      }

      let result;
      try {
        result = await execution.result();
      } catch (cause) {
        finish({ state: 'failed', message: `安装失败：${String((cause as Error)?.message ?? cause)}` });
        return;
      }

      const combined = `${result.stdout?.text ?? ''}${result.stderr?.text ?? ''}`;
      const body = tail(combined, tailLimit);
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;

      if (abort.signal.aborted) {
        finish({ state: 'cancelled', exitCode, output: body, message: '已取消。' });
      } else if (result.timedOut === true) {
        finish({
          state: 'timed-out',
          exitCode,
          output: body,
          message: `超过 ${Math.round(timeoutMs / 60000)} 分钟上限已终止。网络慢或需要本地编译时，可以延长 analyzeTimeoutMs 后重试。`,
        });
      } else if (looksDenied(combined)) {
        finish({
          state: 'denied',
          exitCode,
          output: body,
          message: '沙箱拒绝了写入。本插件不会申请扩权 —— 请在终端里手动执行这条命令。',
        });
      } else if (exitCode === 0) {
        finish({
          state: 'done',
          exitCode,
          output: body,
          message: `已安装到 ${prefix}。`,
        });
      } else {
        finish({
          state: 'failed',
          exitCode,
          output: body,
          message:
            `npm 以退出码 ${exitCode ?? '未知'} 结束。常见原因：` +
            '访问不到你的 npm registry、或者缺少 C++ 编译工具链（这些包需要本地编译）。',
        });
      }
    })();

    return status;
  };

  return {
    start,
    status: () => status,
    cancel: () => {
      if (controller === null) return false;
      controller.abort();
      return true;
    },
    cliPath,
    dispose: () => {
      if (controller !== null) controller.abort();
      controller = null;
    },
  };
}
