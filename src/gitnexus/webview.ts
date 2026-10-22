/**
 * Run the GitNexus web server, and hand the panel a URL it can embed.
 *
 * WHY A SERVER INSTEAD OF DRAWING THE GRAPH
 * -----------------------------------------
 * The panel used to draw the community overview itself on a 2D canvas. That worked for
 * a projection of ~60 communities and it is still what the card falls back to, but it
 * could not become the thing this plugin was actually trying to show: a rotatable,
 * filterable, searchable graph of the whole index. Reimplementing that in one `tsc`
 * artifact — the browser half has no bundler (see `scripts/build-client.mjs`) — meant
 * hand-writing a 3D projection, which is what revision 0.1.6 did, and which was judged
 * not good enough to keep.
 *
 * GitNexus already ships that UI. `gitnexus serve` serves a complete SPA (sigma/d3,
 * community clustering, symbol search, paths) from `<pkg>/web`, and it sets no
 * `X-Frame-Options` and no `Content-Security-Policy`, so the panel can embed it in an
 * iframe. The only thing missing was a lifecycle: nobody wants to remember a port, run
 * a command, and paste a URL with a repo path in it.
 *
 * THE FOUR THINGS THIS MODULE HAS TO GET RIGHT
 * --------------------------------------------
 * 1. **One long-lived process.** `shell.execute()` resolves once the process is
 *    prepared; awaiting `result()` is what makes a spawn a foreground run. So this
 *    module keeps the handle and deliberately never awaits it, with
 *    `onExpiry: 'none'` — a deadline here would kill the server on its own.
 *
 * 2. **The registry that actually holds the repository.** The server resolves
 *    `?repo=` through its own `GITNEXUS_HOME` registry (by basename), so a server
 *    started with the default home cannot see an index this plugin built, which lives
 *    under `<repo>/.gitnexus/plugin-home` (see `defaultGitnexusHome`). Picking the home
 *    from the registry that contains the path is the whole trick.
 *
 * 3. **The CLI that actually reads that index.** `findGitnexusCli` resolves the same
 *    executable the analyze runner uses. On this machine that distinction was visible:
 *    a stray 1.6.6 copy answered every request with
 *    `Trying to read a database file with a different version. Database file version:
 *    42, Current build storage version: 41`. A blank SPA is not an acceptable way to
 *    report that, so a failed start surfaces the process's own output.
 *
 * 4. **Never kill a server this plugin did not start.** A port may already hold a
 *    GitNexus server the operator launched by hand. If it can see this repository it is
 *    adopted — used, reported as external, and left running.
 */

import path from 'node:path';
import { defaultGitnexusHome } from './commands.js';
import { globalDir, normalizePathKey, readRegistry } from './index-meta.js';
import { findGitnexusCli, type ToolchainOptions } from './toolchain.js';
import {
  llmSettingsSeed,
  readAiSettings,
  type AiSettingsRead,
  type AiProvider,
} from './ai-settings.js';
import { defaultWebDistRoot, locateWebDist, prepareWebDist, removeWebDist } from './webdist.js';
import type { ShellLike } from '../shell.js';
import { envPrefix, invokeCommand, quoteArg, shellFlavor, tailChars, type ShellFlavor } from '../shell.js';

/** Where a web view got to. `unavailable` is decided before anything is spawned. */
export type WebViewState =
  /** Nothing has been started in this host's lifetime. */
  | 'stopped'
  | 'starting'
  | 'ready'
  /** A start was attempted and failed; `message`/`output` say why. */
  | 'failed'
  /** No `gitnexus` executable was found — there is nothing to serve. */
  | 'unavailable';

export interface WebViewStatus {
  state: WebViewState;
  /** The repository this status is about, as passed in. */
  repoPath: string;
  /** The SPA URL for the repository, or null when there is nothing to open. */
  url: string | null;
  port: number | null;
  /**
   * `managed` — spawned by this plugin, and therefore stoppable by it.
   * `adopted` — already running when this plugin looked, and left alone.
   */
  owner: 'managed' | 'adopted' | null;
  /**
   * Whether the running server's registry contains this repository. `false` means the
   * server is up but `?repo=` would fall back to its first repository, so no URL is
   * offered — the operator has to index this repository (or stop an external server
   * started with another home).
   */
  repoResolvable: boolean;
  /** The registry directory the server was started with, so a mismatch is visible. */
  registryHome: string | null;
  /** The command as run, so a failure can be reproduced by hand. */
  command: string | null;
  startedAt: number | null;
  /** A short operator-facing explanation, or null when the state speaks for itself. */
  message: string | null;
  /** The tail of the server's output, once it has exited. */
  output: string;
  /** What happened to the AI settings the SPA reads on load. */
  ai: WebViewAiStatus;
}

/**
 * The outcome of seeding the SPA's AI settings.
 *
 * `injected` is about the page this plugin served, not about the operator's intent: an
 * adopted server keeps its own `index.html`, so there is nothing to seed even when the
 * variables are set. `reason` is always safe to show — it never contains the key.
 */
export interface WebViewAiStatus {
  injected: boolean;
  provider: AiProvider | null;
  model: string | null;
  baseUrl: string | null;
  reason: string | null;
}

/** The slice of the executor's process handle this module uses. */
interface ProcessHandleLike {
  result(): Promise<{
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    aborted?: boolean;
    stdout?: { text?: string } | null;
    stderr?: { text?: string } | null;
  }>;
  kill?(): boolean | Promise<boolean>;
}

export interface WebViewRunnerOptions {
  /**
   * The host's shell executor, or null when the profile has none. With null the runner
   * reports `unavailable` and the panel tells the operator to run the command.
   */
  shell: ShellLike | null;
  toolchain?: ToolchainOptions;
  /** First port to try. Later candidates are `port + 1 …`. */
  port?: number;
  /** Interface the server binds. Loopback by default: this is a local preview. */
  host?: string;
  memoryOff?: boolean;
  heapMb?: number;
  /**
   * The plugin's configured `GITNEXUS_HOME`, when the operator set one. Empty means
   * "resolve it" — see `registryHomes`.
   */
  gitnexusHome?: string;
  /** Same repository-rooted policy every other spawn uses; see `src/index.ts`. */
  sandboxPolicy?: (repoPath: string) => unknown;
  outputLimit?: number;
  /** How long to wait for `/api/health` after a spawn. */
  startTimeoutMs?: number;
  /** Probe interval while waiting for health. */
  pollIntervalMs?: number;
  /** Injectable for tests: the global fetch, narrowed to what is used here. */
  fetchLike?: (url: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Registry directories to try, in order, for one repository.
   *
   * Defaults to the configured home (when any), the plugin-owned home next to the
   * index, and the machine-wide `~/.gitnexus` — the three places an index of this
   * repository can plausibly have been registered.
   */
  registryHomes?: (repoPath: string) => string[];
  /**
   * Where the AI settings come from. Defaults to `readAiSettings(process.env)`, and is a
   * function so a restart picks up a changed environment without rebuilding the runner.
   */
  aiSettings?: () => AiSettingsRead;
  /**
   * Directory the seeded `index.html` is generated in. Defaults to
   * `$DSH_HOME/gitnexus-plus/webview`, with one subdirectory per port.
   */
  webDistRoot?: string;
  /**
   * The packaged `web/` directory to copy, when the caller (or a test) already knows it.
   * `null` explicitly disables the search and therefore the injection.
   */
  webDistSource?: string | null;
}

export interface WebViewRunner {
  status(repoPath: string): Promise<WebViewStatus>;
  /** Reuse a running server that can see this repository, or start one. */
  start(repoPath: string): Promise<WebViewStatus>;
  /**
   * Stop the managed server and start a fresh one.
   *
   * Distinct from `start` because the most common reason to click again is that the
   * running server is wedged or was started against another registry — and `start`
   * would correctly answer "it is already running" and change nothing.
   */
  restart(repoPath: string): Promise<WebViewStatus>;
  stop(): Promise<WebViewStatus>;
  dispose(): void;
}

const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HEAP_MB = 8192;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_START_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 300;
/** How many consecutive ports to consider before giving up on finding a free one. */
const PORT_ATTEMPTS = 10;
/** Characters of server output kept for the panel. */
const OUTPUT_TAIL = 4000;
const HEALTH_TIMEOUT_MS = 700;

/**
 * Build the `gitnexus serve` command line, as the shell will read it.
 *
 * The shape is deliberately the same one `analyzeCommandLine` builds, and for the same
 * two measured reasons: PowerShell needs the call operator before a quoted absolute
 * path, and `GITNEXUS_MEMORY=off` stops the CLI re-spawning itself over piped stdio
 * (which a confined process denies). `NODE_OPTIONS` supplies the heap that respawn was
 * trying to obtain; a large index does not fit in the default one.
 *
 * Exported so the shape can be asserted without a shell.
 */
export function serveCommandLine(
  cliPath: string,
  options: {
    flavor?: 'win32' | 'posix';
    port?: number;
    host?: string;
    memoryOff?: boolean;
    heapMb?: number;
    viaNode?: boolean;
    gitnexusHome?: string | null;
    /** Overrides the served SPA directory (`GITNEXUS_WEB_DIST`); see `src/gitnexus/webdist.ts`. */
    webDist?: string | null;
  } = {},
): string {
  const flavor: ShellFlavor = options.flavor ?? shellFlavor();
  const memoryOff = options.memoryOff !== false;
  const heapMb = options.heapMb ?? DEFAULT_HEAP_MB;
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const viaNode = options.viaNode === true;

  const args = `serve --port ${port} --host ${quoteArg(flavor, host)}`;
  const head = viaNode ? `node ${quoteArg(flavor, cliPath)}` : quoteArg(flavor, cliPath);
  const invocation = invokeCommand(flavor, head, args, { viaNode });

  const pairs: Array<[string, string]> = [];
  if (memoryOff) pairs.push(['GITNEXUS_MEMORY', 'off']);
  if (typeof options.gitnexusHome === 'string' && options.gitnexusHome !== '') {
    pairs.push(['GITNEXUS_HOME', options.gitnexusHome]);
  }
  if (typeof options.webDist === 'string' && options.webDist !== '') {
    pairs.push(['GITNEXUS_WEB_DIST', options.webDist]);
  }
  pairs.push(['NODE_OPTIONS', `--max-old-space-size=${heapMb}`]);
  return `${envPrefix(flavor, pairs)}${invocation}`;
}

/**
 * The SPA address for one repository.
 *
 * `?repo=` is a path, not a name: `gitnexus-web` reads it out of the URL, sends it to
 * `/api/repo`, and the server matches it by basename against its registry. The path
 * form survives a registry whose entry carries a different display name, which is why
 * it is preferred over `?project=`.
 */
export function webViewUrl(port: number, repoPath: string, host = DEFAULT_HOST): string {
  return `http://${host}:${port}/?repo=${encodeURIComponent(path.resolve(repoPath))}`;
}

/** Keep the last `limit` characters of the server's combined output. */
function tailOf(
  result: { stdout?: { text?: string } | null; stderr?: { text?: string } | null },
  limit = OUTPUT_TAIL,
): string {
  const combined = `${result.stdout?.text ?? ''}${result.stdout?.text === undefined ? '' : '\n'}${result.stderr?.text ?? ''}`.trim();
  return tailChars(combined, limit);
}

interface ServerRecord {
  owner: 'managed' | 'adopted';
  port: number;
  /** The repository the panel asked for; the URL is rebuilt per request. */
  repoPath: string;
  /** The registry the server was started with; null for an adopted server (unknown). */
  registryHome: string | null;
  command: string | null;
  startedAt: number;
  handle: ProcessHandleLike | null;
  exited: boolean;
  exitCode: number | null;
  output: string;
  /** What the AI settings injection did when this server was started. */
  ai: WebViewAiStatus;
  /** The generated SPA directory, when one was served; removed with the server. */
  webDist: string | null;
}

interface FailureRecord {
  repoPath: string;
  message: string;
  command: string | null;
  output: string;
  state: 'failed' | 'unavailable';
  /** The injection outcome, when the failure happened after it was known. */
  ai?: WebViewAiStatus;
}

/**
 * One web view for the whole plugin host.
 *
 * Not one per repository: the SPA is a repository *browser*, `?repo=` only chooses what
 * it opens first, and one server per project would leak a process for every repository
 * the operator happened to look at. The registry home is the only per-repository part,
 * and switching it restarts the one server.
 */
export function createWebViewRunner(options: WebViewRunnerOptions): WebViewRunner {
  const shell = options.shell;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const doFetch = options.fetchLike ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const basePort = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const shellFlavor: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix';
  const readAi = options.aiSettings ?? ((): AiSettingsRead => readAiSettings(process.env));

  /**
   * The injection state implied by the environment alone.
   *
   * Used for statuses that have no server behind them (stopped, failed before a spawn),
   * where the honest answer is "this is what a start would inject".
   */
  const configuredAi = (read: AiSettingsRead = readAi()): WebViewAiStatus => {
    if (read.kind === 'absent') {
      return {
        injected: false,
        provider: null,
        model: null,
        baseUrl: null,
        reason: '没有设置 GITNEXUS_PLUS_AI_* 环境变量，AI 设置保持原样。',
      };
    }
    if (read.kind === 'invalid') {
      return { injected: false, provider: null, model: null, baseUrl: null, reason: read.reason };
    }
    return {
      injected: false,
      provider: read.settings.provider,
      model: read.settings.model,
      baseUrl: read.settings.baseUrl,
      reason: '服务启动时会自动注入这组 AI 设置。',
    };
  };

  let current: ServerRecord | null = null;
  let failure: FailureRecord | null = null;
  /** Set while a start is in flight, so a concurrent GET reports `starting`. */
  let pending: string | null = null;
  let pendingStart: Promise<WebViewStatus> | null = null;

  const registryHomes = options.registryHomes ?? ((repoPath: string): string[] => {
    const homes: string[] = [];
    const configured = options.gitnexusHome;
    if (typeof configured === 'string' && configured.trim() !== '') homes.push(path.resolve(configured));
    homes.push(defaultGitnexusHome(repoPath));
    homes.push(globalDir());
    // De-duplicate while keeping the order: the first hit is the one that counts.
    const seen = new Set<string>();
    return homes.filter((home) => {
      const key = normalizePathKey(home);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  /** Whether a registry directory holds an entry for this repository. */
  const registryHasRepo = async (home: string, repoPath: string): Promise<boolean> => {
    const entries = await readRegistry({ env: { ...process.env, GITNEXUS_HOME: home } });
    const wanted = normalizePathKey(repoPath);
    return entries.some((entry) => {
      try {
        return normalizePathKey(entry.path) === wanted;
      } catch {
        return false;
      }
    });
  };

  const probeHealth = async (port: number): Promise<boolean> => {
    try {
      const response = await doFetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: unknown } | null;
      return body !== null && body.status === 'ok';
    } catch {
      return false;
    }
  };

  /** The repository paths a server on this port reports, or null when it will not say. */
  const listRepos = async (port: number): Promise<string[] | null> => {
    try {
      const response = await doFetch(`http://${host}:${port}/api/repos`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) return null;
      return body
        .map((entry) => (entry as { path?: unknown }).path)
        .filter((value): value is string => typeof value === 'string');
    } catch {
      return null;
    }
  };

  const serverHasRepo = async (port: number, repoPath: string): Promise<boolean> => {
    const paths = await listRepos(port);
    if (paths === null) return false;
    const wanted = normalizePathKey(repoPath);
    return paths.some((value) => {
      try {
        return normalizePathKey(value) === wanted;
      } catch {
        return false;
      }
    });
  };

  const failedStatus = (record: FailureRecord): WebViewStatus => ({
    state: record.state,
    repoPath: record.repoPath,
    url: null,
    port: null,
    owner: null,
    repoResolvable: false,
    registryHome: null,
    command: record.command,
    startedAt: null,
    message: record.message,
    output: record.output,
    ai: record.ai ?? configuredAi(),
  });

  const stoppedStatus = (repoPath: string): WebViewStatus => ({
    state: 'stopped',
    repoPath,
    url: null,
    port: null,
    owner: null,
    repoResolvable: false,
    registryHome: null,
    command: null,
    startedAt: null,
    message: null,
    output: '',
    ai: configuredAi(),
  });

  const runningStatus = async (server: ServerRecord, repoPath: string): Promise<WebViewStatus> => {
    // An adopted server's registry is unknown from here, so ask the server itself
    // rather than guessing: `/api/repos` is exactly the list `?repo=` resolves against.
    const resolvable =
      server.owner === 'adopted'
        ? await serverHasRepo(server.port, repoPath)
        : server.registryHome === null || (await registryHasRepo(server.registryHome, repoPath));
    return {
      state: 'ready',
      repoPath,
      url: resolvable ? webViewUrl(server.port, repoPath, host) : null,
      port: server.port,
      owner: server.owner,
      repoResolvable: resolvable,
      registryHome: server.registryHome,
      command: server.command,
      startedAt: server.startedAt,
      message: resolvable
        ? null
        : `端口 ${server.port} 上的 GitNexus 服务已就绪，但它的注册表里没有当前仓库的索引，` +
          `因此 3D 视图会打开别的仓库。请先刷新本仓库的索引${server.owner === 'adopted' ? '，或停止外部启动的服务后重试' : ''}。`,
      output: server.output,
      ai: server.ai,
    };
  };

  /** Kill the managed server, if any, and wait briefly for it to go. */
  const killCurrent = async (): Promise<void> => {
    const server = current;
    current = null;
    if (server === null || server.owner === 'adopted') return;
    // The generated page carries the seeded key in a script tag. It is regenerated on the
    // next start, so removing it here is what keeps the key from outliving the server.
    if (server.webDist !== null) await removeWebDist(server.webDist);
    if (server.handle === null || server.exited) return;
    try {
      await server.handle.kill?.();
    } catch {
      /* already gone */
    }
  };

  /**
   * Spawn the server on one port and wait until it answers.
   *
   * Returns a status, never throws: every failure here is a state the panel renders,
   * including the one that matters most — the process exited and said why on its own
   * stderr.
   */
  const spawnOn = async (port: number, registryHome: string, repoPath: string): Promise<WebViewStatus> => {
    if (shell === null) {
      failure = {
        repoPath,
        state: 'unavailable',
        command: null,
        output: '',
        message:
          '当前宿主没有可用的 shell 执行器，无法启动 GitNexus Web 服务。' +
          '可以手动运行：gitnexus serve，然后在新标签页打开输出里的地址。',
      };
      return failedStatus(failure);
    }
    const cli = findGitnexusCli({ moduleUrl: import.meta.url, ...(options.toolchain ?? {}) });
    if (!cli.present) {
      failure = {
        repoPath,
        state: 'unavailable',
        command: null,
        output: '',
        message:
          '本机没有找到 gitnexus 命令，无法启动 Web 服务。安装后重试：`npm i -g gitnexus`。' +
          '扫描与覆盖数据仍然可用 —— 那部分不需要 CLI。',
      };
      return failedStatus(failure);
    }

    // Seed the SPA's AI settings, if the operator named them. This is the only way to get
    // them into the embedded page: a parent frame cannot write the child's sessionStorage.
    const aiRead = readAi();
    let ai = configuredAi(aiRead);
    let webDist: string | null = null;
    if (aiRead.kind === 'ready') {
      const outDir = path.join(options.webDistRoot ?? defaultWebDistRoot(), String(port));
      try {
        const source =
          options.webDistSource === undefined
            ? await locateWebDist({ cliPath: cli.cliPath, packageRoot: cli.packageRoot })
            : options.webDistSource;
        if (source === null) {
          ai = { ...ai, reason: '没找到 GitNexus 的 web 目录，AI 设置不会被注入（服务照常启动）。' };
        } else {
          const prepared = await prepareWebDist({
            sourceDir: source,
            outDir,
            seed: llmSettingsSeed(aiRead.settings),
          });
          if (prepared === null) {
            ai = { ...ai, reason: 'GitNexus 的 index.html 结构与预期不同，跳过 AI 设置注入。' };
          } else {
            webDist = prepared.dir;
            ai = {
              injected: true,
              provider: aiRead.settings.provider,
              model: aiRead.settings.model,
              baseUrl: aiRead.settings.baseUrl,
              reason: null,
            };
          }
        }
      } catch (error) {
        ai = {
          ...ai,
          reason: `生成注入页面失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const command = serveCommandLine(cli.cliPath, {
      flavor: shellFlavor,
      port,
      host,
      memoryOff: options.memoryOff,
      heapMb: options.heapMb,
      viaNode: cli.viaNode,
      gitnexusHome: registryHome,
      webDist,
    });
    const spec = shell.resolve({
      command,
      workdir: repoPath,
      // `none`, not `kill`: this process is the feature. A deadline would stop the
      // server as soon as it was reached, and the handle stays valid either way.
      onExpiry: 'none',
      stdoutMaxBytes: outputLimit,
      sandboxPolicy: options.sandboxPolicy?.(repoPath),
    });

    let handle: ProcessHandleLike;
    try {
      handle = (await shell.execute(spec)) as unknown as ProcessHandleLike;
    } catch (error) {
      failure = {
        repoPath,
        state: 'failed',
        command,
        output: '',
        message: `启动 GitNexus Web 服务失败：${error instanceof Error ? error.message : String(error)}`,
        ai,
      };
      return failedStatus(failure);
    }

    const record: ServerRecord = {
      owner: 'managed',
      port,
      repoPath,
      registryHome,
      command,
      startedAt: now(),
      handle,
      exited: false,
      exitCode: null,
      output: '',
      ai,
      webDist,
    };
    current = record;

    // Capture the exit rather than awaiting it: the server is expected to outlive this
    // call, so `result()` is only a signal that it stopped.
    void handle
      .result()
      .then((result) => {
        record.exited = true;
        record.exitCode = result.exitCode ?? null;
        record.output = tailOf(result);
      })
      .catch(() => {
        record.exited = true;
      });

    const deadline = now() + startTimeoutMs;
    while (now() < deadline) {
      if (record.exited) {
        await killCurrent();
        failure = {
          repoPath,
          state: 'failed',
          command,
          output: record.output,
          message:
            record.exitCode === null
              ? 'GitNexus Web 服务已退出。'
              : `GitNexus Web 服务启动后立即退出（exit ${record.exitCode}）。` +
                '端口被占用、索引版本不匹配都会这样，下面的输出里有原因。',
          ai,
        };
        return failedStatus(failure);
      }
      if (await probeHealth(port)) {
        if (await serverHasRepo(port, repoPath)) return runningStatus(record, repoPath);
        // Health is up but the server does not list this repository. Give it one more
        // round — the registry read happens lazily on the first request — and then say
        // what is actually wrong instead of opening a blank SPA.
        await sleep(pollIntervalMs);
        if (!record.exited && (await serverHasRepo(port, repoPath))) return runningStatus(record, repoPath);
        await killCurrent();
        failure = {
          repoPath,
          state: 'failed',
          command,
          output: record.output,
          message:
            `GitNexus Web 服务已启动（端口 ${port}），但它的注册表 ${registryHome} 里没有这个仓库。` +
            '先刷新索引，让 GitNexus 注册这个目录。',
          ai,
        };
        return failedStatus(failure);
      }
      await sleep(pollIntervalMs);
    }

    await killCurrent();
    failure = {
      repoPath,
      state: 'failed',
      command,
      output: record.output,
      message: `等待 GitNexus Web 服务响应超时（${Math.round(startTimeoutMs / 1000)} 秒）。`,
      ai,
    };
    return failedStatus(failure);
  };

  /**
   * Find a port that either holds a usable server or is free, then use it.
   *
   * The scan exists because a GitNexus server the operator already runs is worth
   * reusing: it has the graph loaded, and stopping it to start an identical one would
   * be both surprising and slower.
   */
  const acquire = async (registryHome: string, repoPath: string): Promise<WebViewStatus> => {
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const port = basePort + offset;
      if (await probeHealth(port)) {
        if (await serverHasRepo(port, repoPath)) {
          current = {
            owner: 'adopted',
            port,
            repoPath,
            registryHome: null,
            command: null,
            startedAt: now(),
            handle: null,
            exited: false,
            exitCode: null,
            output: '',
            ai: {
              injected: false,
              provider: null,
              model: null,
              baseUrl: null,
              reason: '这个服务是外部启动的：插件改不了它的页面，AI 设置需要在弹层里手动填写。',
            },
            webDist: null,
          };
          return runningStatus(current, repoPath);
        }
        // Someone else's GitNexus with another registry: not usable for this repo, and
        // not ours to stop. Try the next port.
        continue;
      }
      return spawnOn(port, registryHome, repoPath);
    }
    failure = {
      repoPath,
      state: 'failed',
      command: null,
      output: '',
      message: `端口 ${basePort}–${basePort + PORT_ATTEMPTS - 1} 都被其他 GitNexus 服务占用，且它们都看不到当前仓库。`,
    };
    return failedStatus(failure);
  };

  const doStart = async (repoPath: string): Promise<WebViewStatus> => {
    const resolved = path.resolve(repoPath);
    pending = normalizePathKey(resolved);
    failure = null;
    try {
      const homes = registryHomes(resolved);
      let home: string | null = null;
      for (const candidate of homes) {
        if (await registryHasRepo(candidate, resolved)) {
          home = candidate;
          break;
        }
      }
      if (home === null) {
        failure = {
          repoPath: resolved,
          state: 'failed',
          command: null,
          output: '',
          message:
            'GitNexus 的注册表里没有这个仓库的索引（已查找：' +
            `${homes.join('、')}）。先在面板里刷新索引，或在仓库目录运行 gitnexus analyze --index-only。`,
        };
        return failedStatus(failure);
      }

      if (current !== null && !current.exited) {
        const sameHome =
          current.registryHome !== null && normalizePathKey(current.registryHome) === normalizePathKey(home);
        if (sameHome && (await serverHasRepo(current.port, resolved))) return runningStatus(current, resolved);
        if (current.owner === 'adopted') {
          // Do not kill a server this plugin did not start; report why it cannot be
          // used for this repository instead.
          return runningStatus(current, resolved);
        }
        await killCurrent();
      }

      return await acquire(home, resolved);
    } finally {
      pending = null;
    }
  };

  const status = async (repoPath: string): Promise<WebViewStatus> => {
    if (pending !== null && pending === normalizePathKey(path.resolve(repoPath))) {
      return {
        ...stoppedStatus(repoPath),
        state: 'starting',
        message: '正在启动 GitNexus Web 服务…',
      };
    }
    if (current !== null) {
      if (!current.exited) return runningStatus(current, repoPath);
      // The managed server died since the last look. Report the process's own output
      // rather than a generic "not running": that text is the diagnosis.
      return failedStatus({
        repoPath,
        state: 'failed',
        command: current.command,
        output: current.output,
        message:
          current.exitCode === null
            ? 'GitNexus Web 服务已退出。'
            : `GitNexus Web 服务已退出（exit ${current.exitCode}）。`,
      });
    }
    if (failure !== null) return failedStatus(failure);
    return stoppedStatus(repoPath);
  };

  return {
    status,
    start(repoPath: string): Promise<WebViewStatus> {
      if (pendingStart !== null) return pendingStart;
      const run = doStart(repoPath);
      pendingStart = run;
      void run.finally(() => {
        if (pendingStart === run) pendingStart = null;
      });
      return run;
    },
    async restart(repoPath: string): Promise<WebViewStatus> {
      await killCurrent();
      failure = null;
      return doStart(repoPath);
    },
    async stop(): Promise<WebViewStatus> {
      const server = current;
      if (server !== null && server.owner === 'adopted') {
        // Adopted servers outlive this plugin on purpose.
        return runningStatus(server, server.repoPath);
      }
      const repoPath = server?.repoPath ?? failure?.repoPath ?? '';
      await killCurrent();
      failure = null;
      return stoppedStatus(repoPath);
    },
    dispose(): void {
      const server = current;
      current = null;
      if (server === null || server.owner === 'adopted') return;
      if (server.webDist !== null) void removeWebDist(server.webDist);
      if (server.handle === null) return;
      try {
        void server.handle.kill?.();
      } catch {
        /* the host is going away; nothing to report */
      }
    },
  };
}
