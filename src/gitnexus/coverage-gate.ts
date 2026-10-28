/**
 * When a coverage report should fail a build.
 *
 * The report itself is a description, not a verdict: a repository with a skipped
 * bundle is not broken, it is documented. A CI gate needs the opposite bias — a
 * boolean plus the reasons, so the failing job prints *why* instead of only an exit
 * code. That translation lives here rather than in the CLI entry point so it can be
 * tested without spawning a process or touching a real index.
 *
 * Two independent gates, both off by default:
 *
 *   uncovered — the scanner selected a file that the index does not contain. This is
 *               the drift that makes a query miss code that exists.
 *   missing   — the index is absent, unreadable, or lists files that no longer exist.
 *               This is the inverse drift: the graph answers about a tree that is gone.
 *
 * They are separate flags because the two failures deserve different responses: the
 * first means "refresh the index", the second means "the index and the checkout have
 * diverged".
 */
import type { CoverageReport } from './coverage.js';

/**
 * A repository that could not be analysed.
 *
 * Kept as its own shape, never a half-built report: reading `.totals` off a fake
 * report is how a previous version turned a clean error into a crash.
 */
export interface CoverageFailure {
  repo: { path: string };
  error: string;
}

/** @param {CoverageReport | CoverageFailure} entry */
export function isCoverageFailure(entry: CoverageReport | CoverageFailure): entry is CoverageFailure {
  return 'error' in entry;
}

export interface CoverageGateOptions {
  /** Fail when the index omits files the scanner selected. */
  uncovered: boolean;
  /** Fail when the index is absent or refers to files that are gone. */
  missing: boolean;
}

export interface CoverageGateVerdict {
  failed: boolean;
  /** One line per tripped condition, already in the reader's language. */
  reasons: string[];
}

/** At most this many example paths per reason: enough to act on, short enough to read. */
const SAMPLES = 2;

/** @param {string[]} paths */
function sample(paths: string[]): string {
  if (paths.length === 0) return '';
  const shown = paths.slice(0, SAMPLES).join('、');
  return paths.length > SAMPLES ? `（例如 ${shown} 等）` : `（例如 ${shown}）`;
}

/**
 * Decide whether the reports trip a gate.
 *
 * @param entries one report per target, in the order they were analysed
 * @param options which gates are armed
 */
export function coverageGateVerdict(
  entries: Array<CoverageReport | CoverageFailure>,
  options: CoverageGateOptions,
): CoverageGateVerdict {
  const reasons: string[] = [];

  for (const entry of entries) {
    if (isCoverageFailure(entry)) {
      // An unreadable target is, for gate purposes, an index that is not there.
      if (options.missing) reasons.push(`无法分析 ${entry.repo.path}：${entry.error}`);
      continue;
    }

    const name = entry.repo.name || entry.repo.path;

    if (options.missing && !entry.repo.indexed) {
      reasons.push(`索引缺失：${name} 尚未建立索引（没有 .gitnexus/gitnexus.json）`);
    }

    if (options.uncovered && entry.index.uncoveredCount > 0) {
      const paths = entry.index.uncoveredSample.map((file) => file.path);
      reasons.push(
        `未入索引：${name} 有 ${entry.index.uncoveredCount} 个扫描选中的文件不在索引里` +
          sample(paths),
      );
    }

    if (options.missing && entry.index.staleCount > 0) {
      reasons.push(
        `索引过陈旧：${name} 记录了 ${entry.index.staleCount} 个磁盘上已不存在的文件` +
          sample(entry.index.staleSample),
      );
    }
  }

  return { failed: reasons.length > 0, reasons };
}
