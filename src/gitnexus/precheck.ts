/**
 * The pre-change gate: how much does the file you are about to edit reach?
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else this plugin reports is *after* the fact: the risk card, the graph tools,
 * the tool-answer line. That is the wrong moment for the only question a developer actually
 * asks before an edit — "what does this file touch?". By the time the summary is on screen the
 * bytes are already written, and a human reviewing a diff cannot remember which of two hundred
 * files called `readIndexMeta`.
 *
 * So this module answers one question per edited file, cheaply enough to sit in front of every
 * `edit`/`write` call: how many files reference symbols in it, how many of those references
 * cross a community (the index's proxy for "another module"), and how concentrated they are.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a compiler and it does not run the project's toolchain. The answer is structural:
 * "these symbols have live callers elsewhere in the last analysis". `high` means "worth a
 * confirmation before you write", never "this will break".
 *
 * The numbers are a lower bound on dynamic languages: a Python call resolved by a type
 * annotation is an edge, one made through `getattr` is not. Wording therefore says "至少"
 * where a count could be read as a total.
 */

import fs from 'node:fs';
import path from 'node:path';
import { storageIsUsable } from './storage-state.js';
import type { RiskReport, RiskSymbolHit } from './risk.js';

/** The two tools whose call means "a file is about to change". */
const EDIT_TOOLS = new Set(['edit', 'write']);

/**
 * Which file paths a tool call is about to write.
 *
 * Deliberately narrow: only the harness's own edit/write shapes, and only their `file_path`.
 * A tool this plugin does not recognise contributes nothing — guessing at a shell command's
 * target would produce warnings about the wrong file, which is worse than silence.
 */
export function editedFiles(tool: string, args: unknown): string[] {
  if (!EDIT_TOOLS.has(tool)) return [];
  const record = args as Record<string, unknown> | null;
  const raw = record?.file_path ?? record?.path;
  if (typeof raw !== 'string') return [];
  const file = raw.trim();
  return file === '' ? [] : [file];
}

/**
 * The indexed repository a path belongs to, or `null`.
 *
 * Walks up from the file to the nearest directory whose `.gitnexus` holds a usable manifest.
 * A usable manifest is the whole test: anything else would let the gate warn about a file in
 * a repository that was never indexed, where it has no idea what the file touches.
 */
export function repoForFile(file: string): string | null {
  let dir: string;
  try {
    const resolved = path.resolve(file);
    dir = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    dir = path.dirname(path.resolve(file));
  }
  for (let depth = 0; depth < 40; depth += 1) {
    if (storageIsUsable(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Repository-relative path with forward slashes, which is how the index records them. */
export function indexPathFor(repoPath: string, file: string): string {
  return path.relative(repoPath, path.resolve(file)).split(path.sep).join('/');
}

/**
 * When a file is worth interrupting for.
 *
 * Three independent ways to qualify, because they catch different mistakes: many callers
 * (`files`) means a wide edit, `crossCommunity` means it reaches a module the editor may not
 * have open, and `incoming` catches one hot symbol — a shared util — that is referenced from
 * everywhere even when only a couple of files do it. Any one of them is enough.
 */
export interface ImpactThresholds {
  /** Distinct files, outside the edited one, that reference it. */
  files: number;
  /** References from another community. */
  crossCommunity: number;
  /** Total incoming references. */
  incoming: number;
}

export const DEFAULT_IMPACT_THRESHOLDS: ImpactThresholds = {
  files: 5,
  crossCommunity: 2,
  incoming: 40,
};

/** What the gate knows about one file, before anyone decides to interrupt. */
export interface ImpactSummary {
  /** Repository-relative path, as the index records it. */
  path: string;
  /** Symbols in the file that something else still references. */
  symbols: number;
  /** Sum of those references. */
  incoming: number;
  /** Distinct files doing the referencing. */
  callers: number;
  /** How many of the referencing symbols are reached from another community. */
  crossCommunity: number;
  /** The heaviest symbols, for naming them in the prompt. */
  top: Array<{ name: string; filePath: string; incoming: number; crossCommunity: boolean }>;
}

/** The largest symbols first, which is the order a reader wants them in. */
const TOP_LIMIT = 5;

/**
 * Reduce one risk report into the numbers the gate decides on.
 *
 * The report was produced for a single file as `modified`, so every hit is an exposed symbol:
 * something outside the file still points at it. Callers are counted as distinct files because
 * one caller file referencing twenty symbols is one place to re-read, not twenty.
 */
export function summarizeImpact(repoPath: string, file: string, report: RiskReport | null | undefined): ImpactSummary {
  const empty: ImpactSummary = {
    path: indexPathFor(repoPath, file),
    symbols: 0,
    incoming: 0,
    callers: 0,
    crossCommunity: 0,
    top: [],
  };
  if (report === null || report === undefined || report.evaluated !== true) return empty;
  const hits: RiskSymbolHit[] = report.exposed;
  if (hits.length === 0) return empty;

  const callers = new Set<string>();
  let incoming = 0;
  let crossCommunity = 0;
  for (const hit of hits) {
    incoming += hit.incoming;
    if (hit.crossCommunity) crossCommunity += 1;
    for (const caller of hit.callers) {
      if (caller.fromFile !== null && caller.fromFile !== '') callers.add(caller.fromFile);
    }
  }
  const top = [...hits]
    .sort((left, right) => right.incoming - left.incoming || left.symbol.name.localeCompare(right.symbol.name))
    .slice(0, TOP_LIMIT)
    .map((hit) => ({
      name: hit.symbol.name,
      filePath: hit.symbol.filePath,
      incoming: hit.incoming,
      crossCommunity: hit.crossCommunity,
    }));

  return {
    path: empty.path,
    symbols: hits.length,
    incoming,
    callers: callers.size,
    crossCommunity,
    top,
  };
}

/** Whether this file is worth a confirmation, and which line qualified it. */
export function impactVerdict(
  summary: ImpactSummary,
  thresholds: ImpactThresholds = DEFAULT_IMPACT_THRESHOLDS,
): { large: boolean; reason: string } {
  const reasons: string[] = [];
  if (summary.callers >= thresholds.files) reasons.push(`${summary.callers} 个文件引用它`);
  if (summary.crossCommunity >= thresholds.crossCommunity) reasons.push(`${summary.crossCommunity} 处引用来自其他社区`);
  if (summary.incoming > thresholds.incoming) reasons.push(`${summary.incoming} 处引用`);
  return { large: reasons.length > 0, reason: reasons.join('、') };
}

/**
 * The sentence a developer reads before the write.
 *
 * Two audiences, one text: the operator's confirmation prompt and the agent's denial reason
 * both use it, so they cannot disagree about what was measured. It names numbers, names the
 * heaviest symbols, and says what it is *not* — without that last clause a reader takes
 * "18 个文件引用" for "18 things will break".
 */
export function describeImpact(summary: ImpactSummary, verdict?: string): string {
  const names = summary.top
    .slice(0, 3)
    .map((symbol) => `${symbol.name}（${symbol.incoming} 处引用${symbol.crossCommunity ? '，跨社区' : ''}）`)
    .join('、');
  const head = verdict === undefined || verdict === '' ? '' : `${verdict}。`;
  const body =
    `${head}${summary.path} 里有 ${summary.symbols} 个符号仍被 ${summary.callers} 个文件引用，共 ${summary.incoming} 处` +
    (summary.crossCommunity > 0 ? `，其中 ${summary.crossCommunity} 个符号被其他社区引用` : '') +
    (names === '' ? '' : `：${names}`) +
    '。这是上次 GitNexus 分析的结构关系，不是编译结论；改之前建议先看 gitnexus_risk 的完整清单。';
  return body;
}

/** The one line the system prompt carries, or `''` when there is nothing to say. */
export function scopeLine(summary: ImpactSummary | null): string {
  if (summary === null || summary.incoming === 0) return '';
  return (
    `改动辐射面：${summary.path} 被 ${summary.callers} 个文件引用（${summary.incoming} 处` +
    (summary.crossCommunity > 0 ? `，跨社区 ${summary.crossCommunity} 个符号` : '') +
    '）。'
  );
}
