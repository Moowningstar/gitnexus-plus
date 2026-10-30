/**
 * The three cheap stamps the tracker watches: the working tree, the commit, the index.
 *
 * None of them is the answer to "what changed". `readDelta` already owns that question and
 * answers it by hashing candidates against the index snapshot, deliberately refusing to
 * trust mtime ("trade an exact answer for a fast wrong one"). These stamps are the *hint*
 * that the exact answer may have changed: they are allowed to be noisy, they are never
 * allowed to be interpreted.
 *
 * Two of the three read bytes directly instead of spawning git: inside this sandbox a
 * `spawnSync git` fails with EPERM, and a watcher that cannot run is worse than a watcher
 * that reads `.git/HEAD`. That is also why the commit stamp is a ref read rather than
 * `git rev-parse`.
 */

import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Which directory the watcher may watch, and how loudly it reacts. */
export interface FsWatchOptions {
  /** Coalesce a burst of events for this long before reporting one change. */
  debounceMs?: number;
  /** Never report two changes closer together than this. */
  minGapMs?: number;
  /** Above this many raw events per second, back off instead of evaluating every burst. */
  stormPerSecond?: number;
  /** How long to wait after a storm before trusting events again. */
  stormBackoffMs?: number;
  /** Fallback cadence when the platform cannot watch (or the handle dies). */
  pollMs?: number;
  /** Called once per coalesced change, with the paths seen since the last one. */
  onChange: (paths: readonly string[]) => void;
  /** Diagnostics only; a watcher never fails the caller. */
  onWarning?: (message: string) => void;
  /** Test seam: the timer functions. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** A change pump for one working tree. */
export interface FsWatch {
  /** True when events are arriving; false once the watcher fell back to polling. */
  readonly live: boolean;
  /** Paths seen since the last reported change. */
  readonly seen: number;
  close(): void;
}

const IGNORED_PREFIXES = ['.git/', '.gitnexus/', '.git', '.gitnexus'];

function isIgnored(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  for (const prefix of IGNORED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Watch `repoPath` and report coalesced changes.
 *
 * Measured on this Windows host: one nested write arrives as up to six events, and a
 * `npm install` can arrive as thousands. Hence debounce, a minimum gap, and a storm
 * fallback — the tracker may be late, but it must not become the busiest thing on the box.
 */
export function createFsWatch(repoPath: string, options: FsWatchOptions): FsWatch {
  const debounceMs = options.debounceMs ?? 800;
  const minGapMs = options.minGapMs ?? 5_000;
  const stormPerSecond = options.stormPerSecond ?? 300;
  const stormBackoffMs = options.stormBackoffMs ?? 10_000;
  const pollMs = options.pollMs ?? 5_000;
  const timers = options.timers ?? { setTimeout, clearTimeout };

  const pending = new Set<string>();
  let seen = 0;
  let watcher: FSWatcher | null = null;
  let live = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stormUntil = 0;
  let lastReportAt = 0;
  let recentEvents: number[] = [];

  const report = (): void => {
    timer = null;
    if (closed) return;
    const paths = [...pending];
    pending.clear();
    if (paths.length === 0) return;
    lastReportAt = Date.now();
    options.onChange(paths);
  };

  const schedule = (): void => {
    if (closed || timer !== null) return;
    const now = Date.now();
    // Three independent reasons to wait, and the latest of them wins: coalesce a burst, keep
    // two evaluations at least `minGapMs` apart, and stay quiet through a storm backoff.
    const delay = Math.max(debounceMs, lastReportAt + minGapMs - now, stormUntil - now, 0);
    timer = timers.setTimeout(report, delay);
  };

  // `eventType` is not used: rename and change both mean "look at the tree again", and the
  // exact classification belongs to `readDelta`, which has hashes to tell them apart.
  const onEvent = (_eventType: string, filename: string | null): void => {
    if (closed) return;
    const relative = filename === null ? '' : String(filename);
    if (relative !== '' && isIgnored(relative)) return;
    const now = Date.now();
    recentEvents = recentEvents.filter((at) => now - at < 1_000);
    recentEvents.push(now);
    if (recentEvents.length > stormPerSecond) {
      stormUntil = now + stormBackoffMs;
      options.onWarning?.('文件事件过密，已退避；结论可能滞后。');
    }
    seen += 1;
    if (relative !== '') pending.add(relative);
    schedule();
  };

  const startPolling = (reason: string): void => {
    if (closed || pollTimer !== null) return;
    live = false;
    watcher?.close();
    watcher = null;
    options.onWarning?.(`无法监听文件事件（${reason}），改用每 ${Math.round(pollMs / 1000)} 秒检查一次。`);
    pollTimer = setInterval(() => {
      if (closed) return;
      // The poll cannot say *which* file moved; the exact set still comes from `readDelta`.
      pending.add('');
      schedule();
    }, pollMs);
    pollTimer.unref?.();
  };

  try {
    watcher = watch(repoPath, { recursive: true, persistent: false }, onEvent);
    live = true;
    watcher.on('error', (error: Error) => startPolling(error.message));
  } catch (error) {
    startPolling(error instanceof Error ? error.message : String(error));
  }

  return {
    get live() {
      return live;
    },
    get seen() {
      return seen;
    },
    close() {
      closed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

/** What the commit stamp found. */
export interface GitStamp {
  /** The full object id `HEAD` resolves to, or `null` when there is no commit yet. */
  readonly commit: string | null;
  /** The ref `HEAD` points at, when it is a symbolic ref. */
  readonly ref: string | null;
  /** Why the stamp is not a commit, when it is not. */
  readonly reason: string | null;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the git directory without spawning git.
 *
 * A linked worktree has `.git` as a *file* (`gitdir: …`), and a checkout can point its
 * `.git` at any path; both cases are ordinary here because GitNexus itself supports them.
 */
export async function resolveGitDir(repoPath: string): Promise<string | null> {
  const marker = path.join(repoPath, '.git');
  let stat;
  try {
    stat = await fs.stat(marker);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return marker;
  const text = await readText(marker);
  if (text === null) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(text.trim());
  if (match === null) return null;
  const target = match[1].trim();
  return path.isAbsolute(target) ? target : path.resolve(repoPath, target);
}

/** Read `HEAD` and the ref it names. No process, no lock, no write. */
export async function readGitStamp(repoPath: string): Promise<GitStamp> {
  const gitDir = await resolveGitDir(repoPath);
  if (gitDir === null) return { commit: null, ref: null, reason: 'no-git-marker' };
  const head = await readText(path.join(gitDir, 'HEAD'));
  if (head === null) return { commit: null, ref: null, reason: 'no-head' };
  const trimmed = head.trim();
  if (!trimmed.startsWith('ref:')) {
    // Detached HEAD: the file *is* the id.
    return /^[0-9a-f]{40,64}$/i.test(trimmed)
      ? { commit: trimmed, ref: null, reason: null }
      : { commit: null, ref: null, reason: 'unreadable-head' };
  }
  const ref = trimmed.slice(4).trim();
  const direct = await readText(path.join(gitDir, ref));
  if (direct !== null) {
    const oid = direct.trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? { commit: oid, ref, reason: null } : { commit: null, ref, reason: 'unreadable-ref' };
  }
  const packed = await readText(path.join(gitDir, 'packed-refs'));
  if (packed !== null) {
    for (const line of packed.split('\n')) {
      const [oid, name] = line.trim().split(/\s+/, 2);
      if (name === ref && /^[0-9a-f]{40,64}$/i.test(oid)) return { commit: oid, ref, reason: null };
    }
  }
  return { commit: null, ref, reason: 'unborn-branch' };
}

/**
 * A string that changes when the index files do.
 *
 * Stat only: the value is compared, never parsed. `-1` marks an absent file so "the manifest
 * disappeared" is a change rather than a hole.
 */
export function readIndexStamp(repoPath: string): string {
  const parts: string[] = [];
  for (const relative of [path.join('.gitnexus', 'gitnexus.json'), path.join('.gitnexus', 'meta.json'), path.join('.gitnexus', 'lbug')]) {
    const file = path.join(repoPath, relative);
    if (!existsSync(file)) {
      parts.push('-1');
      continue;
    }
    try {
      const stat = statSync(file);
      parts.push(`${Math.round(stat.mtimeMs)}:${stat.size}`);
    } catch {
      parts.push('-2');
    }
  }
  return parts.join('|');
}
