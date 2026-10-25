/**
 * Turning a graph answer into something a model can read, without lying about it.
 *
 * Three rules, in order of importance:
 *
 * 1. The epistemic envelope is never trimmed. `epistemic`, `risk`, `boundaries` and
 *    `causes` say how much the answer can be trusted; a renderer that drops them turns a
 *    lower bound into a false certainty. They are printed even when everything else is
 *    cut for length.
 * 2. `risk: UNKNOWN` is passed through as-is. Upstream reports UNKNOWN when an upstream
 *    walk resolved no callers at all, which is not the same as "safe", and the sentence
 *    next to it has to say so.
 * 3. Lists are bounded, counts are not. A model needs "13 callers, here are 12" — not a
 *    26 KB payload it will summarise badly, and not a silent lie that there were 12.
 */

import type { GraphToolName } from './graph-query.js';

export interface RenderedTool {
  /** What the model reads. */
  text: string;
  /** The payload, unmodified, for hosts that want the whole thing. */
  result: unknown;
}

/** How many list items survive rendering. Counts in the prose are always the real ones. */
const MAX_EDGES = 12;
const MAX_PROCESSES = 6;
const MAX_DEFINITIONS = 12;

type Record0 = Record<string, unknown>;

function asRecord(value: unknown): Record0 | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record0) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record0 {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `src/a.ts · handler` — the tail of a UID is noise, the file and the name are not. */
function edge(entry: unknown): string {
  const record = asRecord(entry);
  if (record === null) return '';
  const name = str(record.name);
  const file = str(record.filePath);
  const relation = str(record.relationType);
  const confidence = num(record.confidence);
  const parts = [file === '' ? '(未知文件)' : file, name === '' ? '(匿名)' : name];
  if (relation !== '') parts.push(relation);
  if (confidence !== null) parts.push(confidence.toFixed(2));
  return `- ${parts.join(' · ')}`;
}

/** `- 还有 N 条未列出` when the list was longer than the budget. */
function more(total: number, shown: number): string[] {
  return total > shown ? [`- …还有 ${total - shown} 条未列出`] : [];
}

/**
 * Upstream's own failure sentence, when it sent one.
 *
 * `{ error: "Target 'x' not found" }` arrives with `risk: "UNKNOWN"` and empty lists, so
 * without this line it reads exactly like "the walk ran and found no callers". Those are
 * different answers to the reader: one means *the index does not have this symbol yet*
 * (refresh, then ask again), the other means *the index was asked and nobody calls it*.
 * Our UNKNOWN paragraph describes the second, so it must not be printed for the first.
 */
function failure(result: Record0): string[] {
  const error = str(result.error);
  if (error === '') return [];
  const out = [`上游返回错误：${error}`];
  if (/not found|not present|no such symbol|not in (the )?index/i.test(error)) {
    out.push('这个符号不在索引里 —— 先刷新索引再问它，不要把这条当成「没有人调用」。');
  }
  return out;
}

/** `Symbol 'Function:src/nope.ts:nope' not found` → `Function:src/nope.ts:nope`. */
function nameFromError(error: string): string {
  const quoted = /'([^']+)'/.exec(error);
  return quoted === null ? '' : quoted[1] ?? '';
}

/** One blank line between blocks, never two, never one at either end. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (out.length === 0 || out[out.length - 1] === '') continue;
      out.push('');
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** How much of an unexpected payload we echo before giving up on describing it. */
const SNIPPET_CHARS = 400;

/**
 * A bounded peek at a payload we could not interpret.
 *
 * Adding a tool must not break the caller when the tool's own payload changes
 * shape. Guessing a field name is worse than showing the bytes: the reader can
 * see whether the answer arrived at all, and we do not invent a second schema.
 */
function snippet(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS)}…`;
}

function header(tool: GraphToolName, subject: string, facts: string[]): string {
  // Empty parts are dropped rather than joined: an unnamed answer must not read as
  // `GitNexus context ·  · Function`.
  const parts = [`GitNexus ${tool}`, subject, ...facts].filter((part) => part !== '');
  return parts.join(' · ');
}

/**
 * The envelope: every field that qualifies how much the answer can be trusted.
 *
 * Rendered as its own block so a reader that skips the lists still sees it.
 */
function envelope(result: Record0, lines: string[]): string[] {
  const out: string[] = [];
  const epistemic = str(result.epistemic);
  if (epistemic !== '') {
    out.push(
      epistemic === 'lower-bound'
        ? '可信度：**lower-bound**（结果是不完全遍历的下界，实际依赖可能更多）'
        : `可信度：${epistemic}`,
    );
  }
  const boundaries = asArray(result.boundaries).filter((item): item is string => typeof item === 'string');
  if (boundaries.length > 0) {
    out.push('边界：');
    for (const item of boundaries) out.push(`- ${item}`);
  }
  const causes = asRecord(result.causes);
  if (causes !== null) {
    const described = Object.entries(causes)
      .filter(([, value]) => num(value) !== null && (value as number) > 0)
      .map(([key, value]) => `${key}=${String(value)}`);
    if (described.length > 0) out.push(`缺口来源：${described.join('，')}`);
  }
  if (out.length === 0) return lines;
  // The header stays first — it is the one line a reader needs even if the rest
  // is cut — and the envelope follows it, before any list that could be long.
  const [title, ...rest] = lines;
  if (title === undefined) return out;
  return [title, ...out, ...rest];
}

function renderImpact(result: unknown): string {
  const record = asRecord(result);
  if (record === null) return `GitNexus impact：返回体不是对象，无法解读。原样：${snippet(result)}`;

  const target = asRecord(record.target);
  const name = target === null ? '(未知符号)' : str(target.name) === '' ? str(target.id) : str(target.name);
  const kind = target === null ? '' : str(target.type);
  const file = target === null ? '' : str(target.filePath);
  const direction = str(record.direction);
  const risk = str(record.risk);
  const shared = str(record.riskSharedAxes);

  const summary = asRecord(record.summary);
  const direct = summary === null ? null : num(summary.direct);
  const processesAffected = summary === null ? null : num(summary.processes_affected);
  const modulesAffected = summary === null ? null : num(summary.modules_affected);
  const impactedCount = num(record.impactedCount);

  const lines: string[] = [];
  lines.push(
    header('impact', `${name} · ${direction === '' ? 'upstream' : direction}`, [
      risk === '' ? '' : `风险 ${risk}`,
    ]),
  );
  const where = [kind, file].filter((part) => part !== '').join(' · ');
  if (where !== '') lines.push(where);

  const counts: string[] = [];
  if (impactedCount !== null) counts.push(`受影响 ${impactedCount}`);
  if (direct !== null) counts.push(`直接 ${direct}`);
  if (processesAffected !== null) counts.push(`流程 ${processesAffected}`);
  if (modulesAffected !== null) counts.push(`模块 ${modulesAffected}`);
  if (counts.length > 0) lines.push(counts.join(' · '));

  const depths = asRecord(record.byDepthCounts);
  if (depths !== null) {
    const described = Object.keys(depths)
      .sort((left, right) => Number(left) - Number(right))
      .map((depth) => `${depth}→${String(depths[depth])}`);
    if (described.length > 0) lines.push(`深度分布：${described.join('，')}`);
  }
  if (shared !== '' && shared !== risk) lines.push(`共享轴风险：${shared}`);

  const failed = failure(record);
  if (failed.length > 0) {
    lines.push('');
    lines.push(...failed);
  } else if (risk === 'UNKNOWN') {
    lines.push('');
    lines.push('**risk 为 UNKNOWN**：上游遍历没有解析到任何调用者。这不等于安全 —— 可能只是调用点在这里解析不出来（动态派发、跨语言、未索引的包）。改之前先用搜索确认。');
  }

  // The sentence above is our paraphrase. When the payload carries upstream's own
  // explanation, print it verbatim: whoever decides whether to trust an empty walk
  // should read the reason from the walk, not from us.
  const riskNote = str(record.riskNote);
  if (riskNote !== '') {
    lines.push('');
    lines.push(`上游说明：${riskNote}`);
  }

  const byDepth = asRecord(record.byDepth);
  if (byDepth !== null) {
    const keys = Object.keys(byDepth).sort((left, right) => Number(left) - Number(right));
    const first = keys.length > 0 ? byDepth[keys[0] as string] : null;
    const edges = asArray(first);
    if (edges.length > 0) {
      lines.push('');
      lines.push(`最近一层调用者（${edges.length}）：`);
      for (const entry of edges.slice(0, MAX_EDGES)) lines.push(edge(entry));
      lines.push(...more(edges.length, Math.min(edges.length, MAX_EDGES)));
    }
  }

  const processes = asArray(record.affected_processes);
  if (processes.length > 0) {
    lines.push('');
    lines.push(`受影响流程（${processes.length}）：`);
    for (const entry of processes.slice(0, MAX_PROCESSES)) {
      const one = asRecord(entry);
      if (one === null) continue;
      const label = str(one.name) === '' ? '(未命名)' : str(one.name);
      const where = str(one.filePath);
      const affectedSteps = num(one.affected_process_count);
      const totalHits = num(one.total_hits);
      const earliest = num(one.earliest_broken_step);
      const steps =
        affectedSteps === null
          ? ''
          : ` · ${affectedSteps} 个符号${totalHits === null ? '' : `/${totalHits} 次命中`}${earliest === null ? '' : ` · 最早第 ${earliest} 步`}`;
      lines.push(`- ${label}${where === '' ? '' : ` · ${where}`}${steps}`);
    }
    lines.push(...more(processes.length, Math.min(processes.length, MAX_PROCESSES)));
  }

  const modules = asArray(record.affected_modules);
  if (modules.length > 0) {
    lines.push('');
    const described = modules.slice(0, MAX_PROCESSES).map((entry) => {
      const one = asRecord(entry);
      if (one === null) return '';
      const name2 = str(one.name);
      const hits = num(one.hits);
      const impact = str(one.impact);
      return `${name2}${hits === null ? '' : ` ${hits}`}${impact === '' ? '' : `（${impact}）`}`;
    });
    lines.push(`模块：${described.filter((part) => part !== '').join('、')}`);
  }

  return tidy(envelope(record, lines)).join('\n');
}

function renderContext(result: unknown): string {
  const record = asRecord(result);
  if (record === null) return `GitNexus context：返回体不是对象，无法解读。原样：${snippet(result)}`;

  const status = str(record.status);
  const symbol = asRecord(record.symbol);
  const failed = failure(record);
  const lines: string[] = [];

  // A bare error envelope carries no `status` at all (`{"error":"Symbol '…' not
  // found"}`), so the `status !== 'found'` test below let it through and the card read
  // "found, with zero callers" — the one sentence E1 exists to prevent. The error is
  // therefore checked first, and the name is recovered from the message when the
  // payload has no symbol to name.
  if (failed.length > 0) {
    const named = symbol === null ? nameFromError(str(record.error)) : str(symbol.name);
    lines.push(`GitNexus context：未找到${named === '' ? '' : ` · ${named}`}`);
    lines.push('');
    lines.push(...failed);
    return tidy(envelope(record, lines)).join('\n');
  }

  if (status !== '' && status !== 'found') {
    lines.push(`GitNexus context：${status}${symbol === null ? '' : ` · ${str(symbol.name)}`}`);
    return tidy(envelope(record, lines)).join('\n');
  }

  const name = symbol === null ? '' : str(symbol.name);
  const kind = symbol === null ? '' : str(symbol.kind);
  const file = symbol === null ? '' : str(symbol.filePath);
  const start = symbol === null ? null : num(symbol.startLine);
  const end = symbol === null ? null : num(symbol.endLine);
  const span = start === null ? '' : end === null || end === start ? `:${start}` : `:${start}-${end}`;

  lines.push(header('context', name, [kind]));
  lines.push(file === '' ? '' : `${file}${span}`);
  lines.push('');

  const incoming = asRecord(record.incoming);
  const outgoing = asRecord(record.outgoing);
  const incomingTotal = incoming === null ? 0 : Object.values(incoming).reduce<number>((sum, list) => sum + asArray(list).length, 0);
  const outgoingTotal = outgoing === null ? 0 : Object.values(outgoing).reduce<number>((sum, list) => sum + asArray(list).length, 0);

  // No symbol and no edges is not "a symbol with zero callers" — it is an answer that
  // says nothing. Saying so is the difference between a reader checking their spelling
  // and a reader concluding a live function is dead.
  if (symbol === null && incomingTotal === 0 && outgoingTotal === 0) {
    lines.push('没有拿到这个符号的定义，也没有上下游 —— 名字可能不对，或者索引里没有它（先刷新索引再问一次）。');
    return tidy(envelope(record, lines)).join('\n');
  }

  lines.push(`上游 ${incomingTotal} · 下游 ${outgoingTotal}`);

  for (const [label, side] of [['调用者', incoming], ['下游', outgoing]] as const) {
    if (side === null) continue;
    const groups = Object.entries(side).filter(([, list]) => asArray(list).length > 0);
    if (groups.length === 0) continue;
    lines.push('');
    for (const [relation, list] of groups) {
      const entries = asArray(list);
      lines.push(`${label}（${relation}，${entries.length}）：`);
      for (const entry of entries.slice(0, MAX_EDGES)) lines.push(edge(entry));
      lines.push(...more(entries.length, Math.min(entries.length, MAX_EDGES)));
    }
  }

  const processes = asArray(record.processes);
  if (processes.length > 0) {
    lines.push('');
    lines.push(`参与流程（${processes.length}）：`);
    for (const entry of processes.slice(0, MAX_PROCESSES)) {
      const one = asRecord(entry);
      if (one === null) continue;
      const label = str(one.name) === '' ? '(未命名)' : str(one.name);
      const step = num(one.step_index);
      const total = num(one.step_count);
      lines.push(`- ${label}${step === null ? '' : ` · 第 ${step}${total === null ? '' : `/${total}`} 步`}`);
    }
    lines.push(...more(processes.length, Math.min(processes.length, MAX_PROCESSES)));
  }

  return tidy(envelope(record, lines)).join('\n');
}

function renderQuery(result: unknown, query: string): string {
  const record = asRecord(result);
  if (record === null) return `GitNexus query：返回体不是对象，无法解读。原样：${snippet(result)}`;

  const processes = asArray(record.processes);
  const processSymbols = asArray(record.process_symbols);
  const definitions = asArray(record.definitions);

  const lines: string[] = [];
  lines.push(header('query', query === '' ? '' : `"${query}"`, []));
  lines.push(`${processes.length} 个流程 · ${processSymbols.length} 个流程内符号 · ${definitions.length} 个定义`);
  lines.push('');

  const body: string[] = [];
  if (processes.length > 0) {
    body.push(`流程（${processes.length}）：`);
    for (const entry of processes.slice(0, MAX_PROCESSES)) {
      const one = asRecord(entry);
      if (one === null) continue;
      const summary = str(one.summary);
      const steps = num(one.step_count);
      const type = str(one.process_type);
      body.push(`- ${summary === '' ? '(未命名流程)' : summary}${steps === null ? '' : ` · ${steps} 步`}${type === '' ? '' : ` · ${type}`}`);
    }
    body.push(...more(processes.length, Math.min(processes.length, MAX_PROCESSES)));
  }

  if (processSymbols.length > 0) {
    if (body.length > 0) body.push('');
    body.push(`流程内符号（${processSymbols.length}）：`);
    for (const entry of processSymbols.slice(0, MAX_EDGES)) {
      const one = asRecord(entry);
      if (one === null) continue;
      const name = str(one.name);
      const file = str(one.filePath);
      const start = num(one.startLine);
      const module = str(one.module);
      body.push(`- ${name}${file === '' ? '' : ` · ${file}${start === null ? '' : `:${start}`}`}${module === '' ? '' : ` · ${module}`}`);
    }
    body.push(...more(processSymbols.length, Math.min(processSymbols.length, MAX_EDGES)));
  }

  if (definitions.length > 0) {
    if (body.length > 0) body.push('');
    body.push(`定义（${definitions.length}）：`);
    for (const entry of definitions.slice(0, MAX_DEFINITIONS)) {
      const one = asRecord(entry);
      if (one === null) continue;
      const name = str(one.name);
      const file = str(one.filePath);
      const start = num(one.startLine);
      // The id is printed because `gitnexus_context` advertises `uid` and named the id
      // as its source. The canonical payload never reaches the transcript, so an id
      // that is not written here is an id the model cannot obtain — the parameter
      // promised a handle it never handed over.
      const id = str(one.id);
      const where = `${name}${file === '' ? '' : ` · ${file}${start === null ? '' : `:${start}`}`}`;
      body.push(`- ${where}${id === '' ? '' : ` · uid ${id}`}`);
    }
    body.push(...more(definitions.length, Math.min(definitions.length, MAX_DEFINITIONS)));
  }

  const failed = failure(record);
  if (failed.length > 0) {
    body.push('');
    body.push(...failed);
  } else if (body.length === 0) {
    body.push('没有匹配到流程、符号或定义。换个说法，或先用 gitnexus_coverage 看索引里有什么。');
  }
  return tidy(envelope(record, [...lines, ...body])).join('\n');
}

/** Route one payload to its renderer. `query` needs the question for its heading. */
export function renderTool(tool: GraphToolName, result: unknown, query = ''): RenderedTool {
  const text =
    tool === 'impact'
      ? renderImpact(result)
      : tool === 'context'
        ? renderContext(result)
        : renderQuery(result, query);
  return { text, result };
}

/** Exported for the tests: the shapes above are easy to get subtly wrong. */
export const RENDER_LIMITS = { MAX_EDGES, MAX_PROCESSES, MAX_DEFINITIONS } as const;

export { isRecord };
