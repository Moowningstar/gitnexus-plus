/**
 * The host half of the dependency-risk check: ask the child process, then say one thing.
 *
 * The split of responsibilities here is the whole safety story of this feature. The child
 * answers a structural question — which symbols in the changed files still have callers
 * elsewhere — and this module decides what a person is told. It never upgrades that answer
 * into a build verdict: "确定断裂" is reserved for a deleted file whose symbols the index
 * still points at, everything modified is "暴露", and a failure to evaluate is said as a
 * failure to evaluate rather than as calm.
 *
 * `riskLine` is the one-line form the graph tools append. It is written from a report that
 * was already computed somewhere else; it never starts a query, because a tool answer must
 * not wait on a child process to be honest.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exitDetail, parseHelperOutput } from '../shell.js';
import type { Runner } from '../subprocess.js';
import type { RiskQueryResult, RiskSymbolHit } from './risk-query.js';

export type { RiskSymbolHit, RiskQueryResult };

/** What the alarm is allowed to say about the current change set. */
export type RiskVerdict = 'broken' | 'exposed' | 'clear' | 'unknown';

export interface RiskReport {
  /** False when the query could not be answered; `reason` then says why. */
  evaluated: boolean;
  verdict: RiskVerdict;
  reason: string | null;
  /** ISO timestamp of the evaluation, or `null` when there is none. */
  at: string | null;
  counts: { broken: number; exposed: number; blind: number; crossCommunity: number };
  broken: RiskSymbolHit[];
  exposed: RiskSymbolHit[];
  blind: Array<{ path: string; kind: 'modified' | 'added' | 'deleted'; reason: string }>;
  truncated: boolean;
  filesTruncated: boolean;
  /** Identity of the change set this report answers; compared to decide if it is stale. */
  deltaKey: string | null;
  notes: string[];
}

/** The empty-by-construction report for a run that could not answer. */
export function unknownRisk(reason: string, deltaKey: string | null): RiskReport {
  return {
    evaluated: false,
    verdict: 'unknown',
    reason,
    at: null,
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

/** Turn a successful child answer into a report with a verdict. */
export function riskReportFromQuery(query: RiskQueryResult, deltaKey: string | null, at = new Date().toISOString()): RiskReport {
  const verdict: RiskVerdict = query.counts.broken > 0 ? 'broken' : query.counts.exposed > 0 ? 'exposed' : 'clear';
  return {
    evaluated: true,
    verdict,
    reason: null,
    at,
    counts: query.counts,
    broken: query.broken,
    exposed: query.exposed,
    blind: query.blind,
    truncated: query.truncated,
    filesTruncated: query.filesTruncated,
    deltaKey,
    notes: query.notes,
  };
}

export interface EvaluateRiskOptions {
  repoPath: string;
  /** Repository-relative paths from `readDelta`, already filtered by the caller. */
  files: ReadonlyArray<{ path: string; kind: string }>;
  runner: Runner;
  /** Absolute path to `lib/bin/risk-helper.js`. */
  helperPath: string;
  managedPrefix?: string;
  limit?: number;
  timeoutMs?: number;
  /** Identity of the change set, copied into the report. */
  deltaKey?: string | null;
  sandboxPolicy?: unknown;
}

/**
 * Ask the child process once.
 *
 * A 20 s budget covers a cold Node start plus the native adapter load on a large index; on
 * expiry the report says the evaluation timed out, which is different from "nothing is
 * broken" and must stay different.
 */
export async function evaluateRisk(options: EvaluateRiskOptions): Promise<RiskReport> {
  const deltaKey = options.deltaKey ?? null;
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const request = {
    files: options.files.map((file) => ({ path: file.path.replace(/\\/g, '/'), kind: file.kind })),
    limit,
  };
  const tempFile = path.join(
    os.tmpdir(),
    `gnp-risk-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await fs.writeFile(tempFile, JSON.stringify(request), 'utf8');
  try {
    const run = await options.runner.run({
      argv: ['node', options.helperPath, path.resolve(options.repoPath), tempFile, options.managedPrefix ?? ''],
      cwd: path.resolve(options.repoPath),
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: 4 * 1024 * 1024,
      ...(options.sandboxPolicy === undefined ? {} : { sandboxPolicy: options.sandboxPolicy }),
    });
    if (run.kind === 'spawn-failed') return unknownRisk(`无法启动依赖查询进程：${run.message}`, deltaKey);
    if (run.kind === 'timed-out') return unknownRisk('依赖查询超时，结论未知。', deltaKey);
    if (run.kind === 'cancelled') return unknownRisk('依赖查询已取消。', deltaKey);

    const parsed = parseHelperOutput(run.stdout);
    if (parsed === null) {
      return unknownRisk(`依赖查询进程没有返回可解析结果${exitDetail(run.exitCode, run.stderr)}`, deltaKey);
    }
    if (parsed.ok !== true) {
      const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : '依赖查询失败。';
      return unknownRisk(message, deltaKey);
    }
    const query = parsed.risk;
    if (!isRiskQueryResult(query)) return unknownRisk('依赖查询返回了无法识别的结果形状。', deltaKey);
    return riskReportFromQuery(query, deltaKey);
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
  }
}

function isRiskQueryResult(value: unknown): value is RiskQueryResult {
  if (value === null || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    Array.isArray(raw.broken) &&
    Array.isArray(raw.exposed) &&
    Array.isArray(raw.blind) &&
    raw.counts !== null &&
    typeof raw.counts === 'object'
  );
}

/** A symbol line: `name (kind) — 文件:行 · 3 处引用`. */
function describeSymbol(hit: RiskSymbolHit): string {
  const where = hit.symbol.startLine === null ? hit.symbol.filePath : `${hit.symbol.filePath}:${hit.symbol.startLine}`;
  return `${hit.symbol.name}（${hit.symbol.kind}）— ${where} · ${hit.incoming} 处引用`;
}

/** The caller line under a symbol, bounded to three names. */
function describeCallers(hit: RiskSymbolHit): string | null {
  if (hit.callers.length === 0) return null;
  const names = hit.callers.slice(0, 3).map((caller) => caller.fromName ?? caller.fromFile ?? '未命名');
  const more = hit.incoming - names.length;
  return `     被 ${names.join('、')}${more > 0 ? ` 等 ${hit.incoming} 处` : ''} 引用`;
}

const FORBIDDEN = /编译失败|构建破坏|测试会挂|一定安全|不会出问题/;

/**
 * The text form: three buckets, honest counts, and no verdict stronger than the evidence.
 *
 * A report that could not be evaluated is printed as such — with the reason — instead of an
 * empty list, because "no output" and "nothing broken" read the same to a person and only one
 * of them is true here.
 */
export function formatRisk(report: RiskReport): string {
  const lines: string[] = [];
  if (!report.evaluated) {
    lines.push(`依赖风险：无法评估（${report.reason ?? '原因未知'}）`);
    lines.push('这不是“没有风险”，而是这次没能查询索引。改动集与索引状态都会再变，稍后会自动重试。');
    return lines.join('\n');
  }
  const { broken, exposed, counts } = report;
  if (report.verdict === 'clear') {
    lines.push('依赖风险：未见断裂或暴露（改动文件在索引中没有外部引用）');
  } else {
    lines.push(
      `依赖风险：${counts.broken} 处确定断裂、${counts.exposed} 处暴露` +
        `${counts.crossCommunity > 0 ? `（其中 ${counts.crossCommunity} 处跨社区）` : ''}`,
    );
  }
  if (broken.length > 0) {
    lines.push('', '确定断裂（文件已删除，但索引里仍有代码引用它的符号）：');
    for (const hit of broken) {
      lines.push(`  - ${describeSymbol(hit)}`);
      const callers = describeCallers(hit);
      if (callers !== null) lines.push(callers);
    }
    if (counts.broken > broken.length) lines.push(`  …另有 ${counts.broken - broken.length} 处未列出`);
  }
  if (exposed.length > 0) {
    lines.push('', '暴露（外部代码引用了被改动的符号；这是结构性提示，不是编译结论）：');
    for (const hit of exposed) {
      lines.push(`  - ${describeSymbol(hit)}`);
      const callers = describeCallers(hit);
      if (callers !== null) lines.push(callers);
    }
    if (counts.exposed > exposed.length) lines.push(`  …另有 ${counts.exposed - exposed.length} 处未列出`);
  }
  if (report.blind.length > 0) {
    lines.push('', '盲区（这些改动文件在索引中没有符号，因此无法判断引用）：');
    for (const spot of report.blind.slice(0, 10)) lines.push(`  - ${spot.path}（${spot.reason}）`);
    if (report.blind.length > 10) lines.push(`  …另有 ${report.blind.length - 10} 个未列出`);
  }
  if (report.filesTruncated) lines.push('', '改动文件超过单次评估上限，以上是其中一部分；结论不是完整的。');
  else if (report.truncated) lines.push('', '结果被查询上限截断，计数是下限。');
  return lines.join('\n');
}

/**
 * One line for a graph tool answer, or `null` when there is nothing worth saying.
 *
 * The tool already carries a freshness sentence; this line only adds what the freshness
 * sentence cannot — that a change to the tree has structural consequences. Silence is the
 * rule for a clean change set, matching `describeStaleness`.
 */
export function riskLine(report: RiskReport | null | undefined): string | null {
  if (report === null || report === undefined) return null;
  if (!report.evaluated) return `依赖风险：无法评估（${report.reason ?? '原因未知'}）。`;
  if (report.verdict === 'clear') return null;
  const parts: string[] = [];
  if (report.counts.broken > 0) parts.push(`${report.counts.broken} 处确定断裂`);
  if (report.counts.exposed > 0) parts.push(`${report.counts.exposed} 处暴露`);
  const line = `依赖风险：${parts.join('、')}（改动后结构上的引用，不是编译结论）。`;
  return FORBIDDEN.test(line) ? null : line;
}
