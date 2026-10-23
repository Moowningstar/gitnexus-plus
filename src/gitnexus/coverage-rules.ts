/**
 * The rules that turn a scan into warnings, and the oversized files those rules talk
 * about.
 *
 * Split out of `coverage.ts` for one reason: the report assembler had become the
 * largest host file in the repository, and it interleaved three different kinds of
 * work — reading state, deciding what deserves a warning, and serialising the
 * report. Only the middle one belongs here. Every function below is a pure decision
 * over data that is already on disk except {@link collectLargeFiles}, which is the
 * single place that opens a file.
 *
 * The warning messages are part of the plugin's contract (they are shown verbatim in
 * the panel and printed by the CLI), so they were moved without rewording.
 */

import path from 'node:path';
import type { ActivityInfo } from './git-activity.js';
import type { CompatibilityInfo, CoverageProgress, LargeFile, ReportWarning } from './coverage.js';
import { aggregateLanguages, classifyFile, type LanguageDetector } from './languages.js';
import type { IndexMeta } from './index-meta.js';
import type { ScanReport, ScannedFile } from './scan.js';
import { formatBytes, judgeMinified, looksGenerated } from './file-shape.js';

/**
 * A file holding at least this share of its language's bytes is called out when it
 * also looks machine-produced. The share matters because the claim being made is
 * "this distorts the percentage", not merely "this is generated".
 */
const MINIFIED_DOMINANCE_SHARE = 0.25;

/** Progress sink shared by the phases of {@link collectLargeFiles}. */
type EmitProgress = (progress: CoverageProgress) => void;

/**
 * Probe every file the size cap excluded, up to the minification budget.
 *
 * The budget exists because judging a file costs a read of its head, and a repository
 * with 400 skipped files should not pay 400 reads before the panel can draw. Files
 * past the budget still appear in the list — with `minified: null`, which the report
 * and the panel treat as "not measured" rather than "not minified".
 */
export async function collectLargeFiles(
  absRepo: string,
  scan: ScanReport,
  detector: LanguageDetector | null,
  budget: number,
  emit: EmitProgress,
): Promise<LargeFile[]> {
  const largeFiles: LargeFile[] = [];
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
    let minified = null;
    if (minifiedProbes < budget) {
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
      // Filled in below, once every file is collected and the denominators (bytes per
      // language, total scanned bytes) are known. Declared here rather than omitted so
      // the field cannot silently stay `undefined` — which is exactly what happened
      // while these were JSDoc types: `shareOfScanned` was part of the documented
      // contract and no code path ever assigned it.
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

  return largeFiles;
}

/** Bytes the scan dropped at the size cap, and bytes it saw in total. */
export interface ScanVolume {
  /** Sum of the skipped files' sizes. */
  largeBytes: number;
  /** Sum of every scanned file's size, skipped ones included. */
  scannedBytes: number;
}

/**
 * Fill in each large file's share of its language and of the whole scan.
 *
 * Both denominators come from every scanned file, not only the selected ones: a
 * language's real weight includes the files that were too big to index, which is the
 * whole point of the warning that reads these numbers.
 */
export function applyLargeFileShares(
  scan: ScanReport,
  largeFiles: LargeFile[],
  detector: LanguageDetector | null,
): ScanVolume {
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

  return { largeBytes, scannedBytes };
}

/**
 * The headline warning about everything the size cap left out, split by kind.
 *
 * The binary split is what makes the headline honest. Without it, a repository of 3D
 * assets reads as "97.9 % of scanned bytes were skipped" and sounds like lost source;
 * with it, the reader learns that 413 of those 417 MB are models that could never
 * have contributed a symbol, and the figure to act on is the much smaller text
 * remainder.
 */
export function largeFileSkipWarnings(
  scan: ScanReport,
  largeFiles: LargeFile[],
  volume: ScanVolume,
): ReportWarning[] {
  if (scan.large.length === 0) return [];

  const { largeBytes, scannedBytes } = volume;
  const generatedLarge = largeFiles.filter((f) => f.generatedHint);
  const generatedBytes = generatedLarge.reduce((sum, f) => sum + f.size, 0);
  const binaryLarge = largeFiles.filter((f) => f.minified?.binary === true);
  const binaryBytes = binaryLarge.reduce((sum, f) => sum + f.size, 0);
  const textLargeBytes = largeBytes - binaryBytes;

  const notes = [];
  if (binaryLarge.length > 0) {
    notes.push(`其中 ${binaryLarge.length} 个为二进制资源（${formatBytes(binaryBytes)}），本就不含可索引符号`);
  }
  if (generatedLarge.length > 0) {
    notes.push(`${generatedLarge.length} 个疑似构建产物（${formatBytes(generatedBytes)}）`);
  }
  const note = notes.length > 0 ? `，${notes.join('，')}` : '';
  const actionable = binaryLarge.length > 0 ? `，仍可能含源码的为 ${formatBytes(textLargeBytes)}` : '';

  return [
    {
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
    },
  ];
}

/**
 * Per-file warnings for one generated or minified file that dominates its language.
 *
 * Binary short-circuits both claims. A model file is neither minified nor build
 * output, and calling it either is how a first revision ended up telling this
 * repository's owner that 97 % of its skipped bytes were compressed source.
 */
export function largeFileDominanceWarnings(largeFiles: LargeFile[]): ReportWarning[] {
  const warnings: ReportWarning[] = [];

  for (const entry of largeFiles) {
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

  return warnings;
}

/**
 * Warnings about the size cap itself and about what a missing git baseline implies.
 *
 * The cap note exists because an index built by an older GitNexus does not record the
 * cap it was built under, so today's default is being applied to yesterday's index —
 * a judgement that can be wrong and that the reader deserves to know about.
 */
export function capWarnings(
  scan: ScanReport,
  meta: IndexMeta | null,
  env: NodeJS.ProcessEnv,
  absRepo: string,
  hasGit: boolean,
): ReportWarning[] {
  const warnings: ReportWarning[] = [];

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

  return warnings;
}

/**
 * Warnings about the gap between what a fresh scan would select and what the index
 * actually holds — in both directions.
 */
export function indexDriftWarnings(
  uncovered: ScannedFile[],
  staleInIndex: string[],
  compatibility: CompatibilityInfo,
): ReportWarning[] {
  const warnings: ReportWarning[] = [];

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

  if (compatibility.status === 'mismatch') {
    warnings.push({
      level: 'warn',
      code: 'version-mismatch',
      message: compatibility.message,
      evidence: { indexedBy: compatibility.indexedBy, installed: compatibility.installed },
    });
  }

  return warnings;
}

/**
 * Warnings about the git activity window: files that changed recently but are missing
 * from the index, and a window that stopped collecting at its commit cap.
 */
export function activityWarnings(activity: ActivityInfo | null): ReportWarning[] {
  if (activity === null) return [];
  const warnings: ReportWarning[] = [];

  if (activity.totals.verdicts.missing > 0) {
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

  if (activity.window.truncated) {
    warnings.push({
      level: 'info',
      code: 'activity-window-truncated',
      message: `Git 活动窗口达到 ${activity.window.maxCommits} 个提交上限，更早的活动未统计`,
      evidence: { maxCommits: activity.window.maxCommits, sinceDays: activity.window.sinceDays },
    });
  }

  return warnings;
}
