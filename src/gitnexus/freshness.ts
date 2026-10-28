/**
 * The one line that tells a caller how far to trust an index-backed answer.
 *
 * Every graph tool answers from the index, not from the working tree. When the two have
 * drifted apart the answer stays internally consistent and still wrong in the way that
 * hurts: a caller reads "no callers" off a function that gained three of them an hour ago.
 * The drift is already measured — `readDelta` is the gate the panel and the delta tool run
 * — so this module only has to say it in a sentence someone can act on.
 *
 * Three deliberate choices:
 *
 * - The sentence names the commit and the count. "The index may be stale" cannot be acted
 *   on; "3 files changed since `abc1234`" can, and it lets the reader decide whether those
 *   three files are the ones they care about.
 * - `unknown` gets wording of its own, never the stale wording. A report that could not
 *   compare is not evidence of drift; saying so would train a reader to distrust indexes
 *   that are in fact fresh.
 * - Nothing is said when there is nothing to say. A clean index contributes no line at
 *   all, because a banner that is always present is a banner that is never read.
 *
 * No I/O here on purpose: the report is the input, so every branch is testable without a
 * git repository.
 */

import type { DeltaReport } from './delta.js';

/** Seven, because every other surface in this plugin prints short shas. */
const SHA_LENGTH = 7;

/** The first note the engine wrote, if it wrote one. */
function firstNote(report: DeltaReport): string | null {
  const notes = report.notes;
  if (!Array.isArray(notes)) return null;
  for (const note of notes) {
    if (typeof note === 'string' && note.trim() !== '') return note.trim();
  }
  return null;
}

/** The short sha the index was built from, or a placeholder when it never recorded one. */
function indexSha(report: DeltaReport): string {
  const commit = report.indexedCommit;
  if (typeof commit === 'string' && commit !== '') return commit.slice(0, SHA_LENGTH);
  return '未知提交';
}

/** `3 改 / 1 增 / 0 删`, with the truncation caveat when the candidate set was capped. */
function movement(report: DeltaReport): string {
  const counts = report.counts;
  const modified = counts?.modified ?? 0;
  const added = counts?.added ?? 0;
  const deleted = counts?.deleted ?? 0;
  const tail = report.truncated === true ? '，候选文件已截断' : '';
  return `${modified} 改 / ${added} 增 / ${deleted} 删${tail}`;
}

/** The movement the report is about, however the walk counted it. */
function total(report: DeltaReport): number {
  const counts = report.counts;
  return (counts?.modified ?? 0) + (counts?.added ?? 0) + (counts?.deleted ?? 0);
}

/**
 * One line about index freshness, or `null` when there is nothing worth saying.
 *
 * `null` is returned for a clean index *and* for a repository with no index at all: the
 * graph tools already refuse that case in their own words, and repeating it here would put
 * two different problems behind one sentence.
 */
export function describeStaleness(report: DeltaReport | null | undefined): string | null {
  if (report === null || report === undefined) return null;

  // An absent index is a different situation, and the tool already reports it. This line
  // only exists for the case the tool cannot see: an index that exists and has drifted.
  if (report.indexed !== true) return null;

  if (report.comparable !== true) {
    const why = firstNote(report) ?? '无法与工作区比较';
    return `索引新鲜度无法确认：${why}；以下结果可能过期。`;
  }

  if (report.needsRefresh !== true) {
    // A clean verdict is only worth silence if the walk actually finished. When it was
    // truncated the engine says so with `certain: false`, and claiming "fresh" on a
    // partial walk would be a certainty this plugin does not have.
    if (report.certain === true) return null;
    const why = firstNote(report) ?? '检查提前中止';
    return `索引新鲜度无法确认：${why}；以下结果可能过期。`;
  }

  // A worktree basis means the index recorded no usable commit — it was initialised and
  // then moved, so "since <sha>" would name a commit the comparison never used.
  if (report.basis !== 'index') {
    return `索引落后（没有可记录的提交基线）：工作区相对 HEAD 有 ${total(report)} 个文件已改（${movement(
      report,
    )}），以下结果可能过期。`;
  }

  const label = typeof report.advice?.label === 'string' ? report.advice.label.trim() : '';
  const suggestion = label === '' ? '' : `；建议${label}`;
  return `索引落后：自 ${indexSha(report)} 起 ${total(report)} 个文件已改（${movement(
    report,
  )}），以下结果可能过期${suggestion}。`;
}
