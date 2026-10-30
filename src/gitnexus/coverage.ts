/**
 * Index-coverage and large-file monitoring for one repository.
 *
 * The question this answers is not "how big is this repo" but "what did
 * `analyze` silently leave out, and does that change how much I should trust the
 * index?". GitNexus tells the operator, on stderr, once:
 *
 *     Skipped 3 large files (>512KB, likely generated/vendored)
 *       - dist/app.min.js
 *       ...and 2 more (set GITNEXUS_VERBOSE=1 to list them all)
 *
 * That is the whole surface. It is not returned, not persisted, not queryable,
 * and gone once the terminal scrolls. `scanRepository` turns it into data; this
 * module turns it into a judgement — including the case that matters most, where
 * one minified bundle dominates a language's byte share and makes the index look
 * far more complete than it is.
 */

import path from 'node:path';
import {
  readIndexMeta,
  findRegistryEntry,
  hasGitMarker,
  normalizePathKey,
  type IndexStats,
  type ProcessDetection,
} from './index-meta.js';
import { readStorageState, type StorageStateReport } from './storage-state.js';
import { scanRepository, type CapSource } from './scan.js';
import {
  aggregateLanguages,
  loadLanguageDetector,
  type ClassifiedLanguage,
  type LanguageRow,
  type LanguageAggregate,
} from './languages.js';
import { readGitState, classifyStaleness } from './git.js';
import { readGitActivity, type ActivityInfo } from './git-activity.js';
import { readToolchainStatus, type ToolchainStatus } from './toolchain.js';
import {
  compareVersionLines,
  versionLineLabel,
  SUPPORTED_PEER_RANGE,
  type VersionLine,
  type VersionRelation,
} from './version-lines.js';

/**
 * Re-exported so a consumer of the report can name these without also depending on
 * the module that produces them. They are **not** redeclared here: an earlier draft
 * of this file declared its own `ActivityInfo` and `LanguageRow`, which collided with
 * the real ones — two structurally different interfaces under one name, and the
 * compiler reported the mismatch as an assignment failure at the very end of
 * `analyzeCoverage` rather than where the wrong guess was made.
 */
export type { CapSource, ClassifiedLanguage, LanguageRow, ActivityInfo };
export type { LanguageClass } from './languages.js';
export type {
  ActivityAuthor,
  ActivityBranch,
  ActivityFile,
  ActivityHistogram,
  ActivityTotals,
  ActivityWindow,
  FileVerdict,
  HistogramBucket,
} from './git-activity.js';

import type { FileShape } from './file-shape.js';
import { formatBytes } from './file-shape.js';
import {
  activityWarnings,
  applyLargeFileShares,
  capWarnings,
  collectLargeFiles,
  indexDriftWarnings,
  largeFileDominanceWarnings,
  largeFileSkipWarnings,
  storageWarnings,
} from './coverage-rules.js';

/**
 * Re-exported so a report consumer can reach the byte-level helpers through the
 * module it already imports. The implementations live in `file-shape.ts`: they only
 * look at bytes, while everything else in this file reasons about a whole index.
 */
export { formatBytes, looksGenerated, judgeMinified } from './file-shape.js';
export type { FileShape };


/**
 * The report's shape.
 *
 * These are declared rather than left to inference because the report is the
 * plugin's contract: the same object is returned by the `gitnexus_coverage` tool,
 * served by `GET /api/gitnexus/coverage`, and printed by the CLI.
 *
 * They were JSDoc typedefs first. Renaming the file to `.ts` did not carry them
 * over — JSDoc annotations are only *used* by the compiler in `.js` files under
 * `checkJs`, and in a `.ts` file they are documentation. So the migration is where
 * these become real: `export interface` is what lets `format.ts`, the CLI and the
 * route name a field instead of seeing `object`.
 */
export interface RepoInfo {
  /** Absolute repository root. */
  path: string;
  name: string;
  /** Where `.gitnexus` lives. */
  storagePath: string;
  /**
   * Whether a manifest was found **and** it belongs to this checkout.
   *
   * Not the same as "a `gitnexus.json` exists": a store left behind by a moved
   * checkout, or one whose manifest cannot be parsed, holds a file nobody here wrote.
   * `storage.state` says which case it is; `indexed` is only true for `owned`, because
   * that is the only state GitNexus will build on.
   */
  indexed: boolean;
  /**
   * What state `.gitnexus` is in, in GitNexus's own vocabulary plus `unknown`.
   *
   * A directory with data but no manifest is `unowned` and a manifest written for
   * another path is `foreign`; both used to read as "no index" and "healthy index"
   * respectively, which is the difference between offering 「初始化索引」 (refused) and
   * 「全量重建」 (allowed).
   */
  storage: StorageStateReport;
  /**
   * Whether the directory carries a `.git` marker.
   *
   * A folder without one can still be scanned, and GitNexus can index it with
   * `--skip-git`; the index then has no commit baseline and no incremental mode.
   * The panel uses this to say that plainly instead of promising Git activity.
   */
  hasGit: boolean;
  /** Whether GitNexus's own registry lists it. */
  registered: boolean;
  /** Which manifest was read. */
  metaFile: string | null;
  /** ISO timestamp. */
  indexedAt: string | null;
  /** Commit the index was built at. */
  lastCommit: string | null;
  branch: string | null;
  remoteUrl: string | null;
  /** Raw stats block from the manifest. */
  stats: IndexStats | null;
  graphEmbeddings: number | null;
}

export interface GraphInfo {
  files: number;
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
  embeddings: number;
  edgesPerNode: number;
  /** The detector budgets the manifest recorded; null when the manifest predates them. */
  processDetection: ProcessDetection | null;
  /** How complete the flow count is, and the sentence that says so. */
  processCoverage: ProcessCoverage;
}

/**
 * The three states the flow count must never be conflated in.
 *
 * `budget-limited` says a budget existed (so the count may be short of reality),
 * `unseen` says entry points existed but no flow was produced, and `none` says the
 * detector produced nothing and recorded no candidates. `unknown` is for manifests
 * that predate the field — a 1.6.12 index must not claim either completeness or
 * emptiness. `complete` is reserved for a manifest that explicitly recorded no caps.
 */
export type ProcessCoverageState = 'complete' | 'budget-limited' | 'unseen' | 'none' | 'unknown';

export interface ProcessCoverage {
  state: ProcessCoverageState;
  note: string;
}

/**
 * Judge the flow count against the budgets the analyzer recorded.
 *
 * The manifest says what the budgets *were*, never whether they were hit, so this
 * function reports the weakest honest claim: "at most this many flows, under these
 * budgets". It is deliberately unable to say "the graph is complete" unless the
 * analyzer recorded no budget at all.
 *
 * @param processes `stats.processes` from the manifest
 * @param detection parsed `processDetection`, or null when the manifest has no block
 * @param files `stats.files`, used to distinguish "an empty repository" from "a
 *   detector that ran and produced nothing"
 */
export function judgeProcessCoverage(
  processes: number,
  detection: ProcessDetection | null,
  files: number,
): ProcessCoverage {
  if (detection === null) {
    return {
      state: 'unknown',
      note: `该索引未记录流程检测预算（旧版分析器）；${processes} 条流程的完整性无法判断。`,
    };
  }
  const branching = detection.maxProcessBranching;
  const depth = detection.maxProcessTraceDepth;
  const candidates = detection.maxEntryPointCandidates;
  if (processes === 0) {
    if (candidates !== null && candidates > 0 && files > 0) {
      return {
        state: 'unseen',
        note: `0 条流程——入口点存在（候选上限 ${candidates}），但本次没有流程进入排名；不代表仓库里没有流程。`,
      };
    }
    return { state: 'none', note: '0 条流程——检测没有产出流程，也没有记录入口点候选。' };
  }
  if (detection.maxProcesses !== null) {
    return {
      state: 'budget-limited',
      note: `流程 ${processes} 条——达到流程上限 ${detection.maxProcesses}，可能被截断，不代表流程只有这些。`,
    };
  }
  if (branching !== null || depth !== null || candidates !== null) {
    const budgets = [
      branching === null ? null : `分支 ≤${branching}`,
      depth === null ? null : `深度 ≤${depth}`,
      candidates === null ? null : `入口候选 ≤${candidates}`,
    ]
      .filter((part): part is string => part !== null)
      .join('、');
    return {
      state: 'budget-limited',
      note: `流程 ${processes} 条——在${budgets}的预算内得到；可能漏报，不代表流程只有这些。`,
    };
  }
  return { state: 'complete', note: `流程 ${processes} 条，分析器未记录任何流程预算上限。` };
}

/** Commit counts on either side of `indexed...HEAD`. */
export interface AheadBehind {
  /** Commits the index has that HEAD does not — non-zero means a split history. */
  behind: number;
  /** Commits HEAD has that the index does not — how far the index lags. */
  ahead: number;
}

export type StalenessState = 'current' | 'behind' | 'diverged' | 'unknown';

export interface StalenessInfo {
  state: StalenessState;
  indexedCommit: string | null;
  headCommit: string | null;
  branch: string | null;
  /** Null when git could not be asked — distinct from a clean tree (`0`). */
  dirtyCount: number | null;
  aheadBehind: AheadBehind | null;
  gitAvailable: boolean;
  /**
   * Why git could not be read, when `gitAvailable` is false — `git rev-parse HEAD →
   * EPERM`, `… → exit 128`. Null when git answered.
   *
   * The panel used to print one sentence for three different problems (no git, no
   * repository, a host that refuses to start processes), and the operator had no way
   * to tell which. The diagnostic belongs next to the verdict, not in a log.
   */
  reason: string | null;
}

export interface ProvenanceInfo {
  schemaFingerprint: string | null;
  contentRetention: string | null;
  ftsProfile: string | null;
  analysisFeatures: unknown;
  crossLanguageProperties: number;
  runnerCliVersion: string | null;
}

/** How the CLI that is installed relates to the CLI that wrote the index. */
export type VersionCompatibility = 'match' | 'mismatch' | 'unknown';

export interface CompatibilityInfo {
  /** `runnerIdentity.cliVersion` recorded in the index, when it has one. */
  indexedBy: string | null;
  /** The GitNexus CLI the plugin can run now. */
  installed: string | null;
  status: VersionCompatibility;
  message: string;
  /** The peer range both sides are judged against — shown verbatim in the panel. */
  supportedRange: string;
  /** `same` / `cross-line` / out-of-range / `unknown`; `status` stays the string equality. */
  relation: VersionRelation;
  indexedLine: VersionLine;
  installedLine: VersionLine;
}

/**
 * Compare the version that built the index with the version installed now.
 *
 * String equality, not semver: the useful signal is "these are not the same
 * build", and a range check would call 1.6.12 and 1.6.6 compatible while their
 * storage versions can differ. If either side is missing the answer is
 * `unknown`, never `match` — an absent record is not evidence of agreement.
 */
export function readCompatibility(indexedBy: string | null, installed: string | null): CompatibilityInfo {
  const normalize = (value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const index = normalize(indexedBy);
  const cli = normalize(installed);
  const comparison = compareVersionLines(index, cli);
  const base = {
    indexedBy: index,
    installed: cli,
    supportedRange: SUPPORTED_PEER_RANGE,
    relation: comparison.relation,
    indexedLine: comparison.indexedLine,
    installedLine: comparison.installedLine,
  };
  if (index === null || cli === null) {
    return {
      ...base,
      status: 'unknown',
      message: `无法确认索引与当前 CLI 的版本关系（索引记录 ${index ?? '缺失'}，当前 ${cli ?? '缺失'}）。`,
    };
  }
  if (index === cli) {
    return {
      ...base,
      status: 'match',
      message: `索引与当前 CLI 均为 GitNexus ${cli}（${versionLineLabel(comparison.installedLine)}）。`,
    };
  }
  if (comparison.relation === 'cross-line') {
    return {
      ...base,
      status: 'mismatch',
      message:
        `索引由 GitNexus ${index}（${versionLineLabel(comparison.indexedLine)}）构建，` +
        `当前 CLI 是 ${cli}（${versionLineLabel(comparison.installedLine)}）；` +
        `两者都在受支持范围内（${SUPPORTED_PEER_RANGE}），属跨线，不是版本错误。`,
    };
  }
  return {
    ...base,
    status: 'mismatch',
    message:
      `索引由 GitNexus ${index} 构建，当前 CLI 是 ${cli}；查询/刷新行为可能不一致` +
      `（受支持范围 ${SUPPORTED_PEER_RANGE}，其中一方或双方不在范围内）。`,
  };
}

/** Where the effective size cap came from — re-exported from `scan.ts`. */

export interface CapInfo {
  bytes: number;
  text: string;
  source: CapSource;
  defaultBytes: number;
  defaultText: string;
  maxBytes: number;
  maxText: string;
  recordedInIndex: boolean;
}

export interface Totals {
  scanned: number;
  selected: number;
  large: number;
  suppressedDeclarations: number;
  indexedInGraph: number;
  largeBytes: number;
  scannedBytes: number;
}

/** The language identity attached to a file — the shape `classifyFile` returns. */
export type LanguageTag = ClassifiedLanguage;

export interface LargeFile {
  path: string;
  size: number;
  sizeText: string;
  shareOfScanned: number;
  /**
   * Never null: `classifyFile` always places a file, falling back to an `other`
   * class rather than declining. An earlier declaration made this nullable, which
   * was not a safer type but a wrong one — it forced five null guards onto call
   * sites for a value that cannot be null.
   */
  language: ClassifiedLanguage;
  shareOfLanguage: number;
  /**
   * Null when the probe budget was exhausted, so the reader is never told a file is
   * fine when it was simply not examined.
   */
  minified: FileShape | null;
  /** A boolean, not a label: it is consumed as `if (entry.generatedHint)`. */
  generatedHint: boolean;
}

export interface Attribution {
  oversizeCount: number;
  oversizeBytes: number;
  oversizeShareOfScanned: number;
}

export interface IndexInfo {
  uncoveredCount: number;
  uncoveredSample: Array<{ path: string; size: number }>;
  staleCount: number;
  staleSample: string[];
  dirtyPaths: string[];
}

export type WarningLevel = 'warn' | 'info';

export interface ReportWarning {
  level: WarningLevel;
  code: string;
  message: string;
  evidence: Record<string, unknown>;
}

/**
 * The language breakdown as this report shapes it: the aggregate plus the oversized
 * files held out of it, so a reader can see which files the percentages exclude.
 */
export type LanguageBreakdown = LanguageAggregate & { largeExcluded: LanguageRow[] };

export interface AnalyzerInfo {
  gitnexusVersion: string | null;
  /**
   * Whether the scan reused GitNexus's own primitives or the local fallback.
   *
   * A union, not a number: an earlier JSDoc declaration said `number` while the
   * implementation compared it against the string `'gitnexus'`. The compiler found
   * that the moment this became a real type.
   */
  primitives: 'gitnexus' | 'fallback';
}

/**
 * Receiver members the resolver could not type, as GitNexus records them.
 *
 * While any of these exist, `impact`/`context` answer with a lower bound rather
 * than an exact set — which is why the report surfaces the count next to every
 * other number rather than burying it.
 */
export interface GraphQuality {
  totalSites: number;
  counts: Record<string, number>;
}

/**
 * One entry of the manifest's `capabilities` block: whether a query surface is live,
 * which implementation backs it, and why it is not live when it is not.
 */
export interface CapabilityEntry {
  status?: string;
  skipReason?: string;
  /** The implementation behind the surface, e.g. `ladybugdb`, `ladybugdb-fts`. */
  provider?: string;
  /** Anything else the manifest records, preserved rather than dropped. */
  [key: string]: unknown;
}

/**
 * Narrow the manifest's `capabilities` block.
 *
 * The manifest is JSON written by another tool, so at the boundary it is
 * `Record<string, unknown>` and has to be **checked** rather than asserted. A cast
 * here would move the failure from "a missing field renders as undefined" to "a
 * malformed manifest crashes the panel", which is the wrong trade for data this
 * plugin does not control.
 *
 * WHAT THE NARROWING IS AND IS NOT FOR
 * ------------------------------------
 * Its job is to make the JSON safe to *read*, not to decide which fields exist. A
 * first version listed the two fields it expected and rebuilt each entry from just
 * those, which silently dropped `provider` — a field the panel renders, and the
 * reason it showed `unknown` for two surfaces that were available. So the original
 * entry is spread first and only the validated fields are overwritten: something
 * this plugin has not heard of yet survives, instead of being deleted by a checklist.
 */
export function readCapabilities(raw: Record<string, unknown> | null | undefined): Record<string, CapabilityEntry> {
  const out: Record<string, CapabilityEntry> = {};
  if (raw === null || raw === undefined) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    out[key] = {
      ...entry,
      status: typeof entry.status === 'string' ? entry.status : undefined,
      skipReason: typeof entry.skipReason === 'string' ? entry.skipReason : undefined,
      provider: typeof entry.provider === 'string' ? entry.provider : undefined,
    };
  }
  return out;
}

/**
 * Narrow the manifest's `unresolvedReceiverMembers` block.
 *
 * Returns null rather than a zero-filled object when the field is absent: an index
 * written before this was recorded must render as "not recorded", not as "no untyped
 * receivers", because those are opposite claims about how much to trust the graph.
 */
export function readGraphQuality(raw: unknown): GraphQuality | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (value.counts !== null && typeof value.counts === 'object') {
    for (const [key, count] of Object.entries(value.counts as Record<string, unknown>)) {
      if (typeof count === 'number') counts[key] = count;
    }
  }
  const totalSites = typeof value.totalSites === 'number' ? value.totalSites : 0;
  return { totalSites, counts };
}

export interface CoverageReport {
  repo: RepoInfo;
  analyzer: AnalyzerInfo;
  cap: CapInfo;
  totals: Totals;
  largeFiles: LargeFile[];
  attribution: Attribution;
  index: IndexInfo;
  graph: GraphInfo | null;
  capabilities: Record<string, CapabilityEntry>;
  staleness: StalenessInfo;
  provenance: ProvenanceInfo | null;
  compatibility: CompatibilityInfo;
  graphQuality: GraphQuality | null;
  warnings: ReportWarning[];
  languages: LanguageBreakdown | null;
  activity: ActivityInfo | null;
  /**
   * Whether GitNexus itself is present on this machine.
   *
   * Reported rather than thrown, because "no GitNexus" is a state the panel has to act
   * on: it is the difference between showing an index and offering to produce one, and
   * only the report can carry that distinction. The probe only stats the filesystem, so
   * filling this costs nothing on the hot path.
   */
  toolchain: ToolchainStatus | null;
}

// The byte-level probe (binary/minified judgement, generated-path heuristic and the
// byte formatter) now lives in ile-shape.ts. It is re-exported above, so every
// existing import of these names keeps working.

/** A real phase of the coverage read, reported while the work is still running. */
export type CoveragePhase = 'manifest' | 'git' | 'scan' | 'large-files' | 'assemble';

/** One numeric progress event. `current`/`total` are real counts where they exist. */
export interface CoverageProgress {
  phase: CoveragePhase;
  /** 0–100, based on completed phases and the real scan/probe counters. */
  percent: number;
  label: string;
  current?: number;
  total?: number;
}

/** Options for {@link analyzeCoverage}. */
export interface AnalyzeOptions {
  /** Environment to read GitNexus settings from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Set false to skip the per-language breakdown (it costs a full re-walk). */
  includeLanguages?: boolean;
  /** Set false to skip reading git history. */
  includeActivity?: boolean;
  /** How far back the activity window reaches. */
  activitySinceDays?: number;
  /** Cap on commits read for the activity window. */
  activityMaxCommits?: number;
  /** How many oversized files may be probed for minification before giving up. */
  minifiedSampleLimit?: number;
  /** Where the plugin installs GitNexus, so the probe finds that copy too. */
  toolchain?: { managedPrefix?: string };
  /**
   * Receives real phase/count updates while the report is being built. A thrown
   * callback is ignored: progress is observability, not a reason to fail the read.
   */
  onProgress?: (progress: CoverageProgress) => void;
}

/**
 * Build the full coverage report for a repository.
 *
 * @param repoPath absolute repository root
 */
export async function analyzeCoverage(
  repoPath: string,
  options: AnalyzeOptions = {},
): Promise<CoverageReport> {
  const env = options.env ?? process.env;
  const absRepo = path.resolve(repoPath);
  // A marker check, not a `git` call: the maintenance commands need this even when
  // the git executable is absent, and the commit state is read separately below.
  const hasGit = hasGitMarker(absRepo);
  const emit = (progress: CoverageProgress): void => {
    try {
      options.onProgress?.(progress);
    } catch {
      // Observability must never be able to fail the report it observes.
    }
  };

  const managedPrefix = options.toolchain?.managedPrefix;
  emit({ phase: 'manifest', percent: 2, label: '读取索引清单…' });
  const [meta, registryEntry, detector] = await Promise.all([
    readIndexMeta(absRepo),
    findRegistryEntry(absRepo, { env }),
    loadLanguageDetector({ env, managedPrefix }),
  ]);
  emit({ phase: 'manifest', percent: 10, label: '索引清单已读取' });
  // Synchronous and cheap: one directory listing plus the manifest parse. It is read
  // separately from `readIndexMeta` because the two answer different questions — that
  // one returns null for an unparseable manifest, which is exactly the state we must be
  // able to name.
  const storage = readStorageState(absRepo);

  // Read after the manifest, because classifying staleness needs the indexed commit.
  emit({ phase: 'git', percent: 12, label: '读取 Git 状态…' });
  const git = await readGitState(absRepo, meta?.lastCommit ?? null);
  const staleness = classifyStaleness({ lastCommit: meta?.lastCommit ?? null, git });
  emit({ phase: 'git', percent: 16, label: 'Git 状态已读取' });

  // When the index recorded the cap it was built under, judge it by that cap —
  // not by today's default, which would report files as "skipped" that the index
  // in fact covers.
  emit({ phase: 'scan', percent: 18, label: '扫描工作区…' });
  let lastScanPercent = -1;
  let lastScanAt = 0;
  const scan = await scanRepository(absRepo, {
    env,
    capBytes: meta?.coverageMaxFileSizeBytes ?? undefined,
    managedPrefix,
    onProgress: (done, total) => {
      const percent = 18 + Math.round((done / Math.max(total, 1)) * 42);
      const at = Date.now();
      if (done < total && percent === lastScanPercent && at - lastScanAt < 120) return;
      lastScanPercent = percent;
      lastScanAt = at;
      emit({
        phase: 'scan',
        percent,
        label: `扫描文件 ${done}/${total}`,
        current: done,
        total,
      });
    },
  });
  emit({
    phase: 'scan',
    percent: 60,
    label: `扫描完成：${scan.scannedCount} 个文件`,
    current: scan.scannedCount,
    total: scan.scannedCount,
  });

  const largeFiles = await collectLargeFiles(
    absRepo,
    scan,
    detector,
    options.minifiedSampleLimit ?? 40,
    emit,
  );
  const volume = applyLargeFileShares(scan, largeFiles, detector);
  const { largeBytes, scannedBytes } = volume;

  // Coverage: what a fresh scan would select vs what the index actually holds.
  const indexed = new Set(Object.keys(meta?.fileHashes ?? {}).map((p) => normalizePathKey(p)));
  const selected = new Set(scan.selected.map((f) => normalizePathKey(f.path)));

  const uncovered = scan.selected.filter((f) => !indexed.has(normalizePathKey(f.path)));
  const staleInIndex = meta
    ? Object.keys(meta.fileHashes).filter((p) => !selected.has(normalizePathKey(p)))
    : [];

  const compatibility = readCompatibility(meta?.runnerIdentity?.cliVersion ?? null, scan.gitnexusVersion);

  const languagesReport =
    options.includeLanguages === false
      ? null
      : {
          ...aggregateLanguages(scan.selected, detector),
          largeExcluded: aggregateLanguages(scan.large, detector).rows,
        };

  // Git activity, crossed with both sets so each touched file gets a three-way
  // verdict rather than a bare "in the index / not in the index". Both sets are
  // already computed above, so this costs one git call and no extra filesystem work.
  emit({ phase: 'assemble', percent: 90, label: '汇总 Git 活动与报告…' });
  const activity =
    options.includeActivity === false
      ? null
      : await readGitActivity(absRepo, {
          sinceDays: options.activitySinceDays ?? undefined,
          indexedPaths: Object.keys(meta?.fileHashes ?? {}),
          scannablePaths: scan.selected.map((f) => f.path),
          // The manifest's commit is the only honest baseline: it says what the
          // graph was built from, not what HEAD happened to be when the panel opened.
          baselineRef: meta?.lastCommit ?? null,
        });

  // Every rule lives in `coverage-rules.ts`; this function only decides the order,
  // because that is the order the panel shows: what was skipped, what that distortion
  // means, how the cap was chosen, and whether the index is behind.
  const warnings: ReportWarning[] = [
    ...storageWarnings(storage),
    ...largeFileSkipWarnings(scan, largeFiles, volume),
    ...largeFileDominanceWarnings(largeFiles),
    ...capWarnings(scan, meta, env, absRepo, hasGit),
    ...indexDriftWarnings(uncovered, staleInIndex, compatibility),
    ...activityWarnings(activity),
  ];

  emit({ phase: 'assemble', percent: 99, label: '报告已汇总' });
  return {
    repo: {
      path: absRepo,
      name: registryEntry?.name ?? path.basename(absRepo),
      storagePath: meta?.storagePath ?? path.join(absRepo, '.gitnexus'),
      indexed: storage.usable,
      storage,
      hasGit,
      registered: registryEntry !== null,
      // Which manifest the index was read from — `gitnexus.json` (current) or
      // `meta.json` (legacy). Surfaced so a report can be explained without
      // re-reading the disk.
      metaFile: meta?.metaFile ?? null,
      indexedAt: meta?.indexedAt ?? null,
      lastCommit: meta?.lastCommit ?? null,
      branch: meta?.branch ?? registryEntry?.branch ?? null,
      remoteUrl: meta?.raw?.remoteUrl ?? registryEntry?.remoteUrl ?? null,
      stats: meta?.stats ?? null,
      graphEmbeddings: meta?.stats?.embeddings ?? null,
    },
    // What the graph actually holds. Every one of these was already in the
    // manifest and was being discarded — the panel showed the file count and
    // nothing else about the index's contents.
    graph: meta === null ? null : {
      files: meta.stats?.files ?? 0,
      nodes: meta.stats?.nodes ?? 0,
      edges: meta.stats?.edges ?? 0,
      communities: meta.stats?.communities ?? 0,
      processes: meta.stats?.processes ?? 0,
      embeddings: meta.stats?.embeddings ?? 0,
      edgesPerNode: meta.stats?.nodes > 0 ? (meta.stats.edges ?? 0) / meta.stats.nodes : 0,
      // The count alone reads as "this is all there is". The budgets it was produced
      // under are the difference between "315 flows" and "315 flows found within
      // branching ≤4, entry candidates ≤200".
      processDetection: meta.processDetection,
      processCoverage: judgeProcessCoverage(
        meta.stats?.processes ?? 0,
        meta.processDetection,
        meta.stats?.files ?? 0,
      ),
    },
    // Which query surfaces are actually available. A disabled FTS or vector index
    // changes what the graph can answer, so it belongs next to the counts rather
    // than in a log line.
    capabilities: readCapabilities(meta?.capabilities),
    staleness: {
      state: staleness,
      indexedCommit: meta?.lastCommit ?? null,
      headCommit: git.headCommit,
      branch: git.branch,
      dirtyCount: git.dirtyCount,
      aheadBehind: git.aheadBehind,
      gitAvailable: git.available,
      reason: git.reason,
    },
    // Provenance and analysis configuration. Each of these, if changed, forces a
    // full rebuild — so showing them is showing why an index might be about to be
    // rebuilt rather than updated.
    provenance: meta === null ? null : {
      schemaFingerprint: meta.schemaFingerprint ?? null,
      contentRetention: meta.raw?.contentRetention ?? null,
      ftsProfile: meta.raw?.ftsProfile ?? null,
      analysisFeatures: meta.raw?.analysisFeatures ?? null,
      crossLanguageProperties: Array.isArray(meta.raw?.crossLanguageProperties)
        ? meta.raw.crossLanguageProperties.length
        : 0,
      runnerCliVersion: meta.runnerIdentity?.cliVersion ?? null,
    },
    compatibility,
    // Graph quality: receiver members the resolver could not type. GitNexus's own
    // `impact`/`context` read this to publish an `exact` vs `lower-bound` verdict,
    // so it is the honest caveat to put in front of a reader.
    graphQuality: readGraphQuality(meta?.raw?.unresolvedReceiverMembers),
    analyzer: {
      gitnexusVersion: scan.gitnexusVersion,
      primitives: scan.primitives,
    },
    cap: {
      bytes: scan.capBytes,
      text: formatBytes(scan.capBytes),
      source: scan.capSource,
      defaultBytes: scan.defaultCapBytes,
      defaultText: formatBytes(scan.defaultCapBytes),
      maxBytes: scan.maxCapBytes,
      maxText: formatBytes(scan.maxCapBytes),
      recordedInIndex: scan.capSource === 'index',
    },
    totals: {
      scanned: scan.scannedCount,
      selected: scan.selected.length,
      large: scan.large.length,
      suppressedDeclarations: scan.suppressedDeclarations.length,
      indexedInGraph: meta ? Object.keys(meta.fileHashes).length : 0,
      largeBytes,
      scannedBytes,
    },
    largeFiles,
    attribution: {
      oversizeCount: scan.large.length,
      oversizeBytes: largeBytes,
      oversizeShareOfScanned: scannedBytes > 0 ? largeBytes / scannedBytes : 0,
    },
    index: {
      uncoveredCount: uncovered.length,
      uncoveredSample: uncovered.slice(0, 20).map((f) => ({ path: f.path, size: f.size })),
      staleCount: staleInIndex.length,
      staleSample: staleInIndex.slice(0, 20),
      dirtyPaths: meta?.dirtyPaths ?? [],
    },
    warnings,
    languages: languagesReport,
    activity,
    // Filesystem-only probe, so it costs a few `existsSync` calls. Reported on every
    // read rather than once at startup: a GitNexus installed while the panel is open
    // should start working without the operator restarting anything.
    toolchain: readToolchainStatus({
      env: options.env,
      ...(options.toolchain?.managedPrefix === undefined ? {} : { managedPrefix: options.toolchain.managedPrefix }),
    }),
  };
}
