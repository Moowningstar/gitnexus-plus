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

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readIndexMeta,
  findRegistryEntry,
  hasGitMarker,
  normalizePathKey,
  type IndexStats,
} from './index-meta.js';
import { scanRepository, type CapSource } from './scan.js';
import {
  classifyFile,
  aggregateLanguages,
  loadLanguageDetector,
  type ClassifiedLanguage,
  type LanguageRow,
  type LanguageAggregate,
} from './languages.js';
import { readGitState, classifyStaleness } from './git.js';
import { readGitActivity, type ActivityInfo } from './git-activity.js';
import { readToolchainStatus, type ToolchainStatus } from './toolchain.js';

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

/** Bytes sampled from a file's head when judging its shape. */
const MINIFIED_SAMPLE_BYTES = 64 * 1024;

/** Average characters per line above which a file is treated as minified. */
const MINIFIED_AVG_LINE_THRESHOLD = 500;

/** Control-byte share above which a sample is treated as binary. */
const BINARY_CONTROL_RATIO = 0.3;

/**
 * What a byte-level probe concluded about one oversized file.
 *
 * `binary` is decided before `suspect`: a first revision tested only "no newlines ⇒
 * one enormous line", which flagged every binary asset as minified.
 */
export interface FileShape {
  /** Machine data, not text at all. */
  binary: boolean;
  /** Minified: text, but written as one enormous line. */
  suspect: boolean;
  /** Characters per line (meaningless when binary). */
  avgLineLength: number;
  estimatedLines: number | null;
  sampledBytes: number;
}

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
  /** Whether a manifest was found. */
  indexed: boolean;
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
}

export interface ProvenanceInfo {
  schemaFingerprint: string | null;
  contentRetention: string | null;
  ftsProfile: string | null;
  analysisFeatures: unknown;
  crossLanguageProperties: number;
  runnerCliVersion: string | null;
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

/**
 * Judge what kind of file this is from the head of its bytes.
 *
 * Reads only the head: a bundle megabytes wide on one line is identifiable from
 * any prefix, and reading it whole to decide would cost exactly what the size cap
 * exists to avoid.
 *
 * BINARY IS CHECKED FIRST, AND THAT ORDER IS THE WHOLE POINT
 * ---------------------------------------------------------
 * A first revision tested only "no newlines ⇒ one enormous line", which flagged
 * every binary asset as minified. Measured on a real repository: a 380 MB `.glb`
 * model and a 30 MB `.glb` reported "single-line ≈ 399 230 584 chars" — absurd on
 * its face, and worse than absurd in effect, because it told the reader that 97 %
 * of the repository's skipped bytes were compressed *source*. They were 3D assets
 * that could never have held a symbol.
 *
 * A binary file has few newlines for a reason that has nothing to do with
 * minification, so no line-length statistic over it means anything. The test is
 * git's own: a NUL byte in the head means binary. A control-byte ratio backs it up
 * for machine formats that happen to avoid NUL.
 *
 * The extrapolation is deliberately crude — newline density in the head is assumed
 * to hold for the rest — and only ever produces a *warning*, never an exclusion.
 *
 * @param {string} absolutePath
 * @param {number} size
 * @returns {Promise<FileShape>}
 */
export async function judgeMinified(absolutePath: string, size: number): Promise<FileShape> {
  const want = Math.max(1, Math.min(size, MINIFIED_SAMPLE_BYTES));
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buffer, 0, want, 0);
    const sample = buffer.subarray(0, bytesRead);
    const sampled = sample.length;
    if (sampled === 0) {
      return { binary: false, suspect: false, avgLineLength: 0, estimatedLines: 0, sampledBytes: 0 };
    }

    let newlines = 0;
    let control = 0;
    for (let i = 0; i < sampled; i += 1) {
      const byte = sample[i];
      if (byte === 0x0a) newlines += 1;
      // NUL is decisive on its own (git's rule); other C0 controls accumulate as
      // corroboration. Tab, LF and CR are ordinary text bytes and excluded.
      if (byte === 0x00) {
        return { binary: true, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: sampled };
      }
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control += 1;
    }
    if (control / sampled > BINARY_CONTROL_RATIO) {
      return { binary: true, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: sampled };
    }

    // Whole file sampled: the line count is exact.
    if (size <= sampled) {
      const lines = newlines + 1;
      const avg = size / lines;
      return {
        binary: false,
        suspect: avg > MINIFIED_AVG_LINE_THRESHOLD,
        avgLineLength: avg,
        estimatedLines: lines,
        sampledBytes: sampled,
      };
    }
    // Extrapolated: newlines/byte in the head is assumed to hold throughout, so
    // average line length is simply sample length over newlines in the sample.
    if (newlines === 0) {
      return { binary: false, suspect: true, avgLineLength: size, estimatedLines: 1, sampledBytes: sampled };
    }
    const avg = sampled / newlines;
    return {
      binary: false,
      suspect: avg > MINIFIED_AVG_LINE_THRESHOLD,
      avgLineLength: avg,
      estimatedLines: Math.round(size / avg),
      sampledBytes: sampled,
    };
  } catch {
    return { binary: false, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Path shapes that conventionally hold build output. Applied only to files that
 * already exceeded the size cap, where the combination is high-signal.
 *
 * This exists because the minified heuristic alone is not enough: measured on
 * material-ui, the three skipped files are generated but **multi-line** (75 263 /
 * 10 757 / 32 317 lines, 31/70/44 chars per line) so `judgeMinified` correctly
 * declines to call them minified — yet they are still compiled output sitting in
 * the byte totals. Verified by counting newlines over the whole file after a
 * PowerShell line count wrongly reported "1 line" for a 2.3 MB file.
 */
const GENERATED_PATH_PATTERNS = Object.freeze([
  /(^|\/)(dist|build|out|vendor|generated|__generated__|coverage)\//i,
  /(^|\/)lib\//i,
  /\.min\./i,
  /\.generated\./i,
  /\.g\.(cs|ts|js)$/i,
  /\.bundle\.(js|mjs|cjs)$/i,
]);

/**
 * @param {string} filePath repo-relative
 * @returns {boolean} whether the path conventionally denotes build output
 */
export function looksGenerated(filePath: string): boolean {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(filePath));
}

/**
 * A file holding at least this share of its language's bytes is called out when it
 * also looks machine-produced. The share matters because the claim being made is
 * "this distorts the percentage", not merely "this is generated".
 */
const MINIFIED_DOMINANCE_SHARE = 0.25;

/** @param {number} bytes */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

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

  const largeFiles: LargeFile[] = [];
  const minifiedBudget = options.minifiedSampleLimit ?? 40;
  let minifiedProbes = 0;

  emit({
    phase: 'large-files',
    percent: 62,
    label: scan.large.length === 0 ? '没有超大文件' : `检查超大文件 0/${scan.large.length}`,
    current: 0,
    total: scan.large.length,
  });
  for (let index = 0; index < scan.large.length; index += 1) {
    const file = scan.large[index];
    const lang = classifyFile(file.path, detector);
    /** @type {FileShape | null} */
    let minified = null;
    if (minifiedProbes < minifiedBudget) {
      minifiedProbes += 1;
      minified = await judgeMinified(path.join(absRepo, file.path), file.size);
    }
    largeFiles.push({
      path: file.path,
      size: file.size,
      sizeText: formatBytes(file.size),
      language: lang,
      minified,
      generatedHint: looksGenerated(file.path),
      // Filled in below, once every file is collected and the denominators (bytes
      // per language, total scanned bytes) are known. Declared here rather than
      // omitted so the field cannot silently stay `undefined` — which is exactly
      // what happened while these were JSDoc types: `shareOfScanned` was part of the
      // documented contract and no code path ever assigned it.
      shareOfScanned: 0,
      shareOfLanguage: 0,
    });
    emit({
      phase: 'large-files',
      percent: 62 + Math.round(((index + 1) / Math.max(scan.large.length, 1)) * 28),
      label: `检查超大文件 ${index + 1}/${scan.large.length}`,
      current: index + 1,
      total: scan.large.length,
    });
  }

  // Share of a language's bytes held by each large file, computed over every
  // scanned file of that language so the denominator is the honest one.
  const allFiles = [...scan.selected, ...scan.large];
  const langsAll = aggregateLanguages(allFiles, detector);
  const bytesByLanguage = new Map(langsAll.rows.map((r) => [r.key, r.bytes]));

  const largeBytes = scan.large.reduce((sum, f) => sum + f.size, 0);
  const scannedBytes = allFiles.reduce((sum, f) => sum + f.size, 0);

  for (const entry of largeFiles) {
    const total = bytesByLanguage.get(entry.language.key) ?? entry.size;
    entry.shareOfLanguage = total > 0 ? entry.size / total : 0;
    entry.shareOfScanned = scannedBytes > 0 ? entry.size / scannedBytes : 0;
  }

  // Coverage: what a fresh scan would select vs what the index actually holds.
  const indexed = new Set(Object.keys(meta?.fileHashes ?? {}).map((p) => normalizePathKey(p)));
  const selected = new Set(scan.selected.map((f) => normalizePathKey(f.path)));

  const uncovered = scan.selected.filter((f) => !indexed.has(normalizePathKey(f.path)));
  const staleInIndex = meta
    ? Object.keys(meta.fileHashes).filter((p) => !selected.has(normalizePathKey(p)))
    : [];

  /** @type {Array<{level:'warn'|'info',code:string,message:string,evidence:object}>} */
  const warnings: ReportWarning[] = [];

  const generatedLarge = largeFiles.filter((f) => f.generatedHint);
  const generatedBytes = generatedLarge.reduce((sum, f) => sum + f.size, 0);
  const binaryLarge = largeFiles.filter((f) => f.minified?.binary === true);
  const binaryBytes = binaryLarge.reduce((sum, f) => sum + f.size, 0);
  const textLargeBytes = largeBytes - binaryBytes;

  if (scan.large.length > 0) {
    // The binary split is what makes the headline honest. Without it, a repository
    // of 3D assets reads as "97.9 % of scanned bytes were skipped" and sounds like
    // lost source; with it, the reader learns that 413 of those 417 MB are models
    // that could never have contributed a symbol, and the figure to act on is the
    // much smaller text remainder.
    const notes = [];
    if (binaryLarge.length > 0) {
      notes.push(`其中 ${binaryLarge.length} 个为二进制资源（${formatBytes(binaryBytes)}），本就不含可索引符号`);
    }
    if (generatedLarge.length > 0) {
      notes.push(`${generatedLarge.length} 个疑似构建产物（${formatBytes(generatedBytes)}）`);
    }
    const note = notes.length > 0 ? `，${notes.join('，')}` : '';
    const actionable = binaryLarge.length > 0 ? `，仍可能含源码的为 ${formatBytes(textLargeBytes)}` : '';
    warnings.push({
      level: 'warn',
      code: 'large-files-skipped',
      message:
        `${scan.large.length} 个文件超过 ${formatBytes(scan.capBytes)} 上限被跳过，` +
        `合计 ${formatBytes(largeBytes)}（占已扫描体积 ${scannedBytes > 0 ? ((largeBytes / scannedBytes) * 100).toFixed(1) : '0'}%）` +
        `——这些文件里的符号完全不在索引中${note}${actionable}`,
      evidence: {
        count: scan.large.length,
        bytes: largeBytes,
        capBytes: scan.capBytes,
        capSource: scan.capSource,
        generatedCount: generatedLarge.length,
        generatedBytes,
        binaryCount: binaryLarge.length,
        binaryBytes,
        textBytes: textLargeBytes,
      },
    });
  }

  for (const entry of largeFiles) {
    // Binary short-circuits both claims below. A model file is neither minified nor
    // build output, and calling it either is how a first revision ended up telling
    // this repository's owner that 97 % of its skipped bytes were compressed source.
    if (entry.minified?.binary === true) continue;
    if (entry.shareOfLanguage < MINIFIED_DOMINANCE_SHARE) continue;
    if (entry.minified?.suspect) {
      warnings.push({
        level: 'warn',
        code: 'minified-dominates-language',
        message:
          `${entry.path}（${entry.sizeText}，平均行长 ${Math.round(entry.minified.avgLineLength)} 字符）` +
          `占 ${entry.language.label} 的 ${(entry.shareOfLanguage * 100).toFixed(0)}%，` +
          `疑似压缩产物而非源码——该语言占比被显著放大`,
        evidence: {
          path: entry.path,
          size: entry.size,
          avgLineLength: entry.minified.avgLineLength,
          shareOfLanguage: entry.shareOfLanguage,
          language: entry.language.key,
        },
      });
    } else if (entry.generatedHint) {
      warnings.push({
        level: 'warn',
        code: 'generated-dominates-language',
        message:
          `${entry.path}（${entry.sizeText}）占 ${entry.language.label} 的 ` +
          `${(entry.shareOfLanguage * 100).toFixed(0)}%，路径形似构建产物——` +
          `该语言占比可能包含编译输出`,
        evidence: {
          path: entry.path,
          size: entry.size,
          shareOfLanguage: entry.shareOfLanguage,
          language: entry.language.key,
        },
      });
    }
  }

  const capsNote = meta?.coverageMaxFileSizeBytes ?? null;
  if (capsNote === null && meta !== null) {
    warnings.push({
      level: 'info',
      code: 'cap-not-recorded',
      message: '该索引未记录构建时的大小上限（旧版本写入），本次按当前生效上限判断，可能与建索引时不同',
      evidence: { effectiveCapBytes: scan.capBytes, capSource: scan.capSource },
    });
  }

  if (scan.capSource === 'env') {
    warnings.push({
      level: 'info',
      code: 'cap-from-env',
      message: `大小上限来自 GITNEXUS_MAX_FILE_SIZE=${env.GITNEXUS_MAX_FILE_SIZE}（${formatBytes(scan.capBytes)}），非默认值`,
      evidence: { capBytes: scan.capBytes, maxCapBytes: scan.maxCapBytes },
    });
  }

  if (meta !== null && !hasGit) {
    warnings.push({
      level: 'info',
      code: 'no-commit-baseline',
      message:
        '该索引不是从 git 仓库建立的（--skip-git）：没有提交基线，无法判断索引是否落后，' +
        '刷新每次都会重新分析，也不会产生 Git 活动',
      evidence: { path: absRepo },
    });
  }

  if (uncovered.length > 0) {
    warnings.push({
      level: 'info',
      code: 'uncovered-files',
      message: `${uncovered.length} 个文件会被扫描选中但不在索引中——索引可能已过期，或建索引时的排除规则不同`,
      evidence: { count: uncovered.length, sample: uncovered.slice(0, 10).map((f) => f.path) },
    });
  }

  if (staleInIndex.length > 0) {
    warnings.push({
      level: 'info',
      code: 'index-holds-retired-paths',
      message: `${staleInIndex.length} 个索引中的文件在本次扫描中不存在（已删除或已被排除）`,
      evidence: { count: staleInIndex.length, sample: staleInIndex.slice(0, 10) },
    });
  }

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

  if (activity !== null && activity.totals.verdicts.missing > 0) {
    warnings.push({
      level: 'warn',
      code: 'active-files-missing-from-index',
      message:
        `近 ${activity.window.sinceDays} 天内被改动过的文件里，有 ${activity.totals.verdicts.missing} 个` +
        `本应被索引却不在索引中——索引落后于当前工作区`,
      evidence: {
        missing: activity.totals.verdicts.missing,
        indexed: activity.totals.verdicts.indexed,
        excluded: activity.totals.verdicts.excluded,
        sample: activity.byChanges
          .filter((f) => f.verdict === 'missing')
          .slice(0, 10)
          .map((f) => f.path),
      },
    });
  }

  if (activity !== null && activity.window.truncated) {
    warnings.push({
      level: 'info',
      code: 'activity-window-truncated',
      message: `Git 活动窗口达到 ${activity.window.maxCommits} 个提交上限，更早的活动未统计`,
      evidence: { maxCommits: activity.window.maxCommits, sinceDays: activity.window.sinceDays },
    });
  }

  emit({ phase: 'assemble', percent: 99, label: '报告已汇总' });
  return {
    repo: {
      path: absRepo,
      name: registryEntry?.name ?? path.basename(absRepo),
      storagePath: meta?.storagePath ?? path.join(absRepo, '.gitnexus'),
      indexed: meta !== null,
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
