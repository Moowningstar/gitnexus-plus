/**
 * The resident part: one tracker per repository, holding the stamps, the change set and the
 * dependency alarm for as long as somebody is looking at that repository.
 *
 * It is a *resident*, not a daemon. Nothing is spawned at plugin start, nothing survives the
 * plugin's `ctx.effect` teardown, and a repository nobody has asked about for a few minutes
 * stops being watched. That is deliberate: a background process that outlives the window it
 * belongs to is how editors end up with six of them and a fan running.
 *
 * The evaluation loop is push-then-pull, and the two halves must not be confused:
 *
 *   push  fs/git/index stamps advance on the cheap signal (an event, a ref, an mtime) and only
 *         mark the tracker dirty. They are hints and are never interpreted.
 *   pull  `readDelta` re-hashes the candidate set and answers exactly what changed; the risk
 *         query runs once per *new* change set.
 *
 * So a save that changed nothing (touch, reformat to identical bytes, editor temp file that
 * the index skips) costs one delta pass and produces no alarm. Equality is the filter, not
 * debouncing: this is the same rule Angular's signals use for writes.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readDelta, type DeltaReport } from '../delta.js';
import { evaluateRisk, riskLine, unknownRisk, type RiskReport } from '../risk.js';
import type { Runner } from '../../subprocess.js';
import { readStorageState } from '../storage-state.js';
import { derived, signal, type Derived, type Signal } from './signals.js';
import { createFsWatch, readGitStamp, readIndexStamp, type FsWatch } from './stamps.js';

/** How many repositories may be watched at once; each one holds a handle and a timer. */
const MAX_WATCHED = 3;
/** Nothing is watched, and no evaluation runs, for a repository nobody read for this long. */
const IDLE_STOP_MS = 5 * 60_000;
/** The child process budget for one risk evaluation. */
const RISK_TIMEOUT_MS = 20_000;

export interface TrackerOptions {
  repoPath: string;
  /** Present when the host exposes a process runner; without it risk is "无法评估". */
  runner: Runner | null;
  /** Absolute path to `lib/bin/risk-helper.js`. */
  helperPath: string;
  managedPrefix?: string;
  /**
   * The sandbox policy for this repository, resolved at call time like every other spawn
   * this plugin starts: the policy service is a host seam, not a value known at construction.
   */
  sandboxPolicy?: (repoPath: string) => unknown;
  /** How many per-bucket symbol lines the tool and the panel show. */
  limit?: number;
  /** Test seam: time. */
  now?: () => number;
  /** Called when the tracker learns something worth logging. */
  onWarning?: (message: string) => void;
}

/** What a route or a tool answer may read at any instant. */
export interface TrackerSnapshot {
  repoPath: string;
  /** True while a watcher is attached and evaluations are allowed. */
  watching: boolean;
  /** False when the watcher fell back to polling. */
  live: boolean;
  /** Set when watching or evaluating degraded; the tracker keeps working, worse. */
  degraded: string | null;
  delta: DeltaReport | null;
  deltaAt: string | null;
  risk: RiskReport | null;
  /** ISO time of the last completed evaluation attempt. */
  evaluatedAt: string | null;
  /** True while an evaluation is running. */
  busy: boolean;
  /** Bumped on every observable change, so a poller can skip identical responses. */
  version: number;
}

function changeKey(delta: DeltaReport): string {
  const entries = [...delta.entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.kind}:${entry.path}`)
    .join('|');
  return `${delta.certain ? 'certain' : 'uncertain'}:${delta.comparable ? 'comparable' : 'guess'}:${entries}`;
}

/**
 * One repository's tracker.
 *
 * Construction is cheap and side-effect free; `ensureStarted()` attaches the watcher when
 * somebody first asks. Everything else is lazy, which is what keeps the cost of the feature
 * proportional to the repositories actually being looked at.
 */
export class RepoTracker {
  readonly repoPath: string;
  private readonly options: TrackerOptions;
  private started = false;
  private disposed = false;
  private lastAccess: number;
  private watch: FsWatch | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cheap hints. Their values are compared, never interpreted. */
  private readonly fsSeq: Signal<number> = signal(0);
  private readonly gitSig: Signal<string> = signal('');
  private readonly indexSig: Signal<string> = signal('');
  private deltaSource: Derived<DeltaReport> | null = null;

  private delta: DeltaReport | null = null;
  private risk: RiskReport | null = null;
  private evaluatedAt: string | null = null;
  private degraded: string | null = null;
  private busy = false;
  private version = 0;
  private inFlight: Promise<void> | null = null;
  private lastRiskKey: string | null = null;

  constructor(options: TrackerOptions) {
    this.options = options;
    this.repoPath = path.resolve(options.repoPath);
    this.lastAccess = this.now();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Attach the watcher once; subsequent calls are no-ops. */
  ensureStarted(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.lastAccess = this.now();
    const storage = readStorageState(this.repoPath);
    if (!storage.usable) {
      // A blocked store cannot change meaningfully by watching it: no evaluation is possible
      // until it is rebuilt, and the panel already explains why.
      this.degraded = '索引当前不可用，未监听改动。';
      return;
    }
    this.watch = createFsWatch(this.repoPath, {
      onChange: (paths) => {
        this.lastAccess = this.now();
        if (paths.some((entry) => entry.endsWith('analyze.lock'))) return;
        this.fsSeq.update((value) => value + 1);
      },
      onWarning: (message) => {
        this.degraded = message;
        this.options.onWarning?.(message);
      },
    });
    if (!this.watch.live) this.degraded = '文件事件不可用，已改为轮询。';

    // Commit and index stamps are read on demand: one event on the tree can arrive six times,
    // and each of those must not be a stat call over `.git`.
    this.gitSig.set(this.gitStampValue());
    this.indexSig.set(readIndexStamp(this.repoPath));

    this.deltaSource = derived(() => readDelta(this.repoPath), [this.fsSeq, this.gitSig, this.indexSig]);

    this.idleTimer = setInterval(() => this.checkIdle(), 60_000);
    this.idleTimer.unref?.();

    // First look is immediate: a repository the user just opened should not wait for a save.
    void this.settle();
  }

  private gitStampValue(): string {
    // A synchronous HEAD mtime is enough to notice that the commit moved; the full ref
    // resolution happens in `settle()`, where an await is allowed.
    try {
      const head = path.join(this.repoPath, '.git', 'HEAD');
      return existsSync(head) ? String(statSync(head).mtimeMs) : 'no-head';
    } catch {
      return 'unreadable';
    }
  }

  private checkIdle(): void {
    if (this.disposed) return;
    if (this.now() - this.lastAccess < IDLE_STOP_MS) return;
    this.stopWatching('长时间无人查看，已停止监听。');
  }

  /** Drop the watcher but keep what was learned; the next access restarts it. */
  private stopWatching(reason: string): void {
    this.watch?.close();
    this.watch = null;
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.started = false;
    this.degraded = reason;
  }

  /**
   * Recompute the change set, and the risk report when the change set is new.
   *
   * Single-flight: a burst of events during a running evaluation schedules one follow-up
   * rather than a queue of them.
   */
  async settle(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight !== null) return this.inFlight;
    this.ensureStarted();
    const run = (async () => {
      this.busy = true;
      try {
        // The delta node dedupes on the stamp versions, so two evaluations of an unchanged
        // tree cost one hash pass — and the risk query is then skipped by the change key.
        const delta = this.deltaSource === null ? await readDelta(this.repoPath) : await this.deltaSource.get();
        const key = changeKey(delta);
        this.delta = delta;
        this.gitSig.set(await this.fullGitStamp());
        this.indexSig.set(readIndexStamp(this.repoPath));
        if (!delta.comparable) {
          this.risk = unknownRisk('改动集不完整，未能评估依赖。', key);
          this.lastRiskKey = key;
        } else if (this.risk === null || this.lastRiskKey !== key) {
          this.risk = await this.computeRisk();
          this.lastRiskKey = key;
        }
        this.evaluatedAt = new Date().toISOString();
        this.version += 1;
      } catch (error) {
        this.degraded = `评估失败：${error instanceof Error ? error.message : String(error)}`;
        this.risk = unknownRisk(this.degraded, this.delta === null ? null : changeKey(this.delta));
        this.version += 1;
      } finally {
        this.busy = false;
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }

  private async fullGitStamp(): Promise<string> {
    const stamp = await readGitStamp(this.repoPath);
    return stamp.commit ?? `${stamp.ref ?? 'none'}:${stamp.reason ?? 'unknown'}`;
  }

  /** One risk child call for the current change set. */
  private async computeRisk(): Promise<RiskReport> {
    const delta = this.delta ?? (await readDelta(this.repoPath));
    const files = delta.entries.filter((entry) => entry.kind !== 'excluded').map((entry) => ({ path: entry.path, kind: entry.kind }));
    const key = changeKey(delta);
    if (!delta.comparable) return unknownRisk('改动集不完整，未能评估依赖。', key);
    if (files.length === 0) return riskReportResultEmpty(key);
    if (this.options.runner === null) return unknownRisk('当前部署没有子进程执行器，无法查询依赖。', key);
    const sandboxPolicy = this.options.sandboxPolicy?.(this.repoPath);
    return evaluateRisk({
      repoPath: this.repoPath,
      files,
      runner: this.options.runner,
      helperPath: this.options.helperPath,
      ...(this.options.managedPrefix === undefined ? {} : { managedPrefix: this.options.managedPrefix }),
      ...(this.options.limit === undefined ? {} : { limit: this.options.limit }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      timeoutMs: RISK_TIMEOUT_MS,
      deltaKey: key,
    });
  }

  /** Force the child query even when the change set is unchanged (the `refresh` argument). */
  async refreshRisk(): Promise<RiskReport> {
    this.lastRiskKey = null;
    await this.settle();
    return this.risk ?? unknownRisk('尚未评估。', null);
  }

  snapshot(): TrackerSnapshot {
    this.lastAccess = this.now();
    return {
      repoPath: this.repoPath,
      watching: this.started && this.watch !== null,
      live: this.watch?.live ?? false,
      degraded: this.degraded,
      delta: this.delta,
      deltaAt: this.delta?.readAt ?? null,
      risk: this.risk,
      evaluatedAt: this.evaluatedAt,
      busy: this.busy,
      version: this.version,
    };
  }

  /** The one line a graph tool answer may append; reads only what is already known. */
  line(): string | null {
    this.lastAccess = this.now();
    if (this.risk === null) {
      return this.delta === null ? null : '依赖风险：改动后尚未评估。';
    }
    const currentKey = this.delta === null ? null : changeKey(this.delta);
    if (currentKey !== null && this.risk.deltaKey !== null && currentKey !== this.risk.deltaKey) {
      return '依赖风险：改动后尚未评估。';
    }
    return riskLine(this.risk);
  }

  dispose(): void {
    this.disposed = true;
    this.watch?.close();
    this.watch = null;
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

function riskReportResultEmpty(deltaKey: string): RiskReport {
  return {
    evaluated: true,
    verdict: 'clear',
    reason: null,
    at: new Date().toISOString(),
    counts: { broken: 0, exposed: 0, blind: 0, crossCommunity: 0 },
    broken: [],
    exposed: [],
    blind: [],
    truncated: false,
    filesTruncated: false,
    deltaKey,
    notes: [],
  };
}

/**
 * The set of trackers, capped.
 *
 * Least-recently-used is disposed rather than parked: a tracker holds an fs watcher handle
 * and a timer, and the point of the cap is that the number of handles stays small.
 */
export class TrackerRegistry {
  private readonly trackers = new Map<string, RepoTracker>();
  private readonly options: Omit<TrackerOptions, 'repoPath'>;

  constructor(options: Omit<TrackerOptions, 'repoPath'>) {
    this.options = options;
  }

  get(repoPath: string, overrides: Partial<Omit<TrackerOptions, 'repoPath'>> = {}): RepoTracker {
    const key = path.resolve(repoPath);
    const existing = this.trackers.get(key);
    if (existing !== undefined) {
      // Refresh LRU position.
      this.trackers.delete(key);
      this.trackers.set(key, existing);
      return existing;
    }
    const tracker = new RepoTracker({ ...this.options, ...overrides, repoPath: key });
    this.trackers.set(key, tracker);
    while (this.trackers.size > MAX_WATCHED) {
      const oldestKey = this.trackers.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.trackers.get(oldestKey);
      this.trackers.delete(oldestKey);
      oldest?.dispose();
    }
    return tracker;
  }

  /** Every tracker that is currently attached; used by teardown and by the panel. */
  list(): RepoTracker[] {
    return [...this.trackers.values()];
  }

  dispose(): void {
    for (const tracker of this.trackers.values()) tracker.dispose();
    this.trackers.clear();
  }
}
