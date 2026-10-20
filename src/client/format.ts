import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import {
  ClientAnalyzeRun,
  ClientCap,
  ClientCapability,
  ClientGraphQuality,
  ClientReport,
  ClientStaleness,
  ClientTotals,
  ClientWarning,
  DotState,
  LanguageRowLike,
  StackSegment,
} from './types';

/**
 * How a run's state reads at a glance.
 *
 * Typed to the primitive's own union rather than `string`, so a state added to
 * `ClientAnalyzeRun` without a mapping here fails to compile instead of rendering a
 * dot the primitive silently falls back on.
 */
export function runStateTone(state: ClientAnalyzeRun['state']): primitives.StateDotState {
  switch (state) {
    case 'done':
      return 'done';
    case 'running':
      // The primitive spells this `ongoing`; the host calls it `running`.
      return 'ongoing';
    case 'cancelled':
      return 'idle';
    // Not errors: the sandbox did its job, and the operator's next step is to run the
    // command themselves rather than to investigate a failure.
    case 'denied':
    case 'unavailable':
      return 'warning';
    default:
      return 'error';
  }
}

export function runStateLabel(state: ClientAnalyzeRun['state']): string {
  switch (state) {
    case 'unavailable':
      return '无法执行';
    case 'running':
      return '刷新中';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'timed-out':
      return '超时终止';
    case 'cancelled':
      return '已取消';
    case 'denied':
      return '沙箱拒绝';
  }
}

/**
 * Empty blocks used to narrow a report past the point where an index is known to
 * exist. Zeros rather than absent fields, so a partially-populated report from an
 * older index still renders numbers instead of `undefined`.
 */
export const ZERO_TOTALS: ClientTotals = {
  scanned: 0,
  selected: 0,
  indexedInGraph: 0,
  large: 0,
  largeBytes: 0,
  suppressedDeclarations: 0,
  scannedBytes: 0,
};
export const ZERO_CAP: ClientCap = { text: '—', source: 'default', maxText: '—' };
export const ZERO_ANALYZER: { gitnexusVersion: string | null; primitives: string } = {
  gitnexusVersion: null,
  primitives: 'unknown',
};

// ---------------------------------------------------------------------------
// Pure view-model helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Fall back to local formatting unless the primitives package exposes its own.
 * `fileSizeText` was present in the export surface of installed bundles but never
 * observed at a call site, so it is used opportunistically rather than assumed.
 * @param {number} bytes
 */
export function fileSize(bytes: number): string {
  if (typeof primitives.fileSizeText === 'function') return primitives.fileSizeText(bytes);
  return formatBytes(bytes);
}

/**
 * The cap's provenance, in the panel's language. The host reports stable English
 * keys (`index` / `env` / `default`); showing those raw put an English word in the
 * middle of a Chinese metric row, measured in the real panel as "512.0 KB index".
 */
export function capSourceLabel(source: string): string {
  switch (source) {
    case 'index':
      return '索引记录';
    case 'env':
      return '环境变量';
    case 'default':
      return '默认值';
    default:
      return source;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Percentage of a whole, as a number in [0, 100].
 * @param {number} part
 * @param {number} whole
 */
export function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return (part / whole) * 100;
}

export function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.0';
}

/**
 * Turn language rows into stack segments whose widths sum to exactly 100.
 *
 * Rounding each share independently leaves a visible gap or overflow in a stacked
 * bar, so the largest segment absorbs the residual. The metric is a parameter
 * because "what is this repository written in" has two defensible answers — bytes
 * for weight of code, files for breadth of surface — and they disagree often enough
 * that showing only one invites the wrong conclusion.
 */
export function stackSegments(
  rows: LanguageRowLike[],
  totalBytes: number,
  totalFiles: number,
  metric: 'bytes' | 'files' = 'bytes',
): StackSegment[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const whole = metric === 'files' ? totalFiles : totalBytes;
  const valueOf = (row: LanguageRowLike): number => (metric === 'files' ? row.files : row.bytes);

  const shares = rows.map((row) => ({
    key: row.key,
    label: row.label,
    color: row.color,
    percent: percent(valueOf(row), whole),
  }));
  const sum = shares.reduce((acc, s) => acc + s.percent, 0);
  if (sum > 0 && Math.abs(sum - 100) > 0.005) {
    let biggest = 0;
    for (let i = 1; i < shares.length; i += 1) {
      if (shares[i].percent > shares[biggest].percent) biggest = i;
    }
    shares[biggest].percent += 100 - sum;
  }
  return shares;
}

/**
 * Split the report's warnings by severity.
 *
 * Warnings arrive as structured records rather than prose so that a caller (the
 * model, via the tool) can act on `code`. The panel only renders them, but keeps
 * the split: `warn` is what the reader must not miss, `info` is context.
 *
 * @param {Array<{level:string,code:string,message:string}>} warnings
 */
export function splitWarnings(warnings: ClientWarning[] | undefined): { notable: ClientWarning[]; context: ClientWarning[] } {
  const list = Array.isArray(warnings) ? warnings : [];
  return {
    notable: list.filter((w) => w.level === 'warn'),
    context: list.filter((w) => w.level !== 'warn'),
  };
}

/**
 * Derive the header's one-line summary from a report.
 * @param {any} report
 * @returns {string}
 */
export function summaryLine(report: ClientReport | null): string {
  if (report === null || typeof report !== 'object') return '';
  // Optional-chained per read rather than `report.totals ?? {}`: an empty object
  // literal would erase the field types and every read below would be `unknown`.
  const totals = report.totals;
  const parts = [
    `扫描 ${totals?.scanned ?? 0}`,
    `选中 ${totals?.selected ?? 0}`,
    `图内 ${totals?.indexedInGraph ?? 0}`,
  ];
  const large = totals?.large ?? 0;
  if (large > 0) parts.push(`跳过 ${large}`);
  const suppressed = totals?.suppressedDeclarations ?? 0;
  if (suppressed > 0) parts.push(`声明抑制 ${suppressed}`);
  return parts.join('  ·  ');
}

/**
 * Fraction of scanned files the index covers, in [0, 1], or `null` when there is
 * nothing to divide by — so the UI can omit rather than print a fabricated 0/100.
 * @param {any} report
 * @returns {number | null}
 */
export function coverageRatio(report: ClientReport | null): number | null {
  const scanned = report?.totals?.scanned;
  const indexed = report?.totals?.indexedInGraph;
  // Explicit `typeof` guards rather than `Number.isFinite` alone: `isFinite` takes
  // `unknown` and does not narrow, so the division below would still be typed
  // against a possibly-absent value.
  if (typeof scanned !== 'number' || typeof indexed !== 'number') return null;
  if (!Number.isFinite(scanned) || !Number.isFinite(indexed) || scanned <= 0) return null;
  return Math.max(0, Math.min(1, indexed / scanned));
}

/**
 * Index health as a `StateDot` state.
 *
 * `error` is reserved for an index that is absent or badly behind; `warning` for
 * one that is usable but has dropped files worth knowing about.
 * @param {any} report
 * @returns {'done' | 'warning' | 'error' | 'idle'}
 */
export function healthState(report: ClientReport | null): DotState {
  if (report === null || report?.repo?.indexed !== true) return 'error';
  const ratio = coverageRatio(report);
  const skipped = report?.totals?.large ?? 0;
  if (skipped > 0) return 'warning';
  if (ratio !== null && ratio < 0.9) return 'warning';
  return 'done';
}

/**
 * Staleness as a dot state plus a sentence.
 *
 * `diverged` is deliberately not folded into `behind`: when HEAD has moved off the
 * indexed commit, the distance between them does not measure how much of the index
 * is wrong, so the UI must not imply a count it cannot give. Measured on a real
 * repository, the panel had been showing the indexed commit as though it were
 * current while HEAD was already one commit ahead on a different line.
 *
 * @param {any} staleness
 * @returns {{ state: 'done' | 'warning' | 'error' | 'idle', text: string }}
 */
export function stalenessView(staleness: ClientStaleness | undefined): { state: DotState; text: string } {
  if (!staleness || staleness.gitAvailable !== true) {
    return { state: 'idle', text: 'git 不可用，无法判断新鲜度' };
  }
  const short = (sha: string | null | undefined): string => (typeof sha === 'string' && sha !== '' ? sha.slice(0, 8) : '?');
  const head = short(staleness.headCommit);
  const indexed = short(staleness.indexedCommit);
  const dirtyCount = typeof staleness.dirtyCount === 'number' ? staleness.dirtyCount : 0;
  const dirty = dirtyCount > 0 ? `，工作区 ${dirtyCount} 处未提交改动` : '';

  switch (staleness.state) {
    case 'current':
      return { state: 'done', text: `current · HEAD ${head} 与索引一致${dirty}` };
    case 'behind': {
      const ahead = staleness.aheadBehind?.ahead ?? 0;
      // Says where the action lives, not that one is available nearby. The previous
      // wording — "可直接增量刷新" — sat directly under the panel's refresh button and
      // read as an instruction to press it, while that control only re-reads the
      // report and never touches the index. Pointing at the maintenance commands
      // costs one clause and stops the panel promising something it does not do.
      return {
        state: 'warning',
        text: `behind · 索引落后 ${ahead} 个提交（${indexed} → ${head}）· 重建见下方「维护命令」${dirty}`,
      };
    }
    case 'diverged': {
      // Diverged means the *indexed* commit holds work HEAD no longer reaches —
      // not merely that HEAD is ahead. The distinction decides whether an
      // incremental refresh is enough or a rebuild is required, so the wording
      // must not blur it.
      const indexedSide = staleness.aheadBehind?.behind ?? 0;
      return {
        state: 'warning',
        text:
          `diverged · HEAD ${head} 已偏离索引提交 ${indexed}（索引侧另有 ${indexedSide} 个提交不在 HEAD 上）` +
          `${dirty}`,
      };
    }
    default:
      return { state: 'idle', text: `unknown · 无法比对 ${indexed} 与 ${head}${dirty}` };
  }
}

/**
 * Capability rows for the query surfaces, in a fixed order so the panel does not
 * reshuffle between repositories.
 *
 * A capability whose provider reports `unavailable` still gets a row: "no keyword
 * search" is information, and hiding it is how a reader concludes the graph can do
 * something it cannot.
 *
 * @param {any} capabilities
 * @returns {Array<{ key: string, label: string, ok: boolean, provider: string, note: string }>}
 */
export const CAPABILITY_KEYS = ['graph', 'fts', 'vectorSearch'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * Turn a capability's machine reason into something a reader can act on.
 *
 * The manifest reports `disabled-by-flag` and friends, which are useful in a bug report
 * and useless in a panel: the reader needs to know *what stops working*. Unknown values
 * pass through unchanged — a reason this plugin has not seen is still better than a
 * blank.
 */
const CAPABILITY_REASONS: Record<string, string> = {
  'disabled-by-flag': '建索引时关闭',
  'missing-extension': '扩展未安装',
  'extension-unavailable': '扩展无法加载',
  unavailable: '不可用',
};

export function capabilityRows(capabilities: Record<string, ClientCapability> | undefined): Array<{ key: string; label: string; ok: boolean; provider: string; note: string }> {
  const caps = capabilities ?? {};
  // Keyed by the same literal union the loop walks, so the lookup is checked rather
  // than an index-signature read that would silently yield `undefined`.
  const labels: Record<CapabilityKey, string> = {
    graph: '图查询',
    fts: '关键词搜索',
    vectorSearch: '语义搜索',
  };
  return CAPABILITY_KEYS.map((key) => {
    const entry: ClientCapability = caps[key] ?? {};
    const ok = entry.status === 'available';
    const raw = String(entry.skipReason ?? entry.status ?? 'unavailable');
    const reason = CAPABILITY_REASONS[raw] ?? raw;
    return {
      key,
      label: labels[key],
      ok,
      provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
      // The consequence matters more than the cause: an unavailable keyword index means
      // search matches names and paths only, which is exactly what the search box does.
      note: ok ? '' : key === 'fts' ? `${reason} · 仅按名称/路径匹配` : reason,
    };
  });
}

/**
 * Summarise the resolver's untyped receiver sites.
 *
 * GitNexus publishes this so `impact` and `context` can report `exact` versus
 * `lower-bound`; the panel surfaces it because it is the honest caveat on every
 * other number here.
 */
export function graphQualitySummary(graphQuality: ClientGraphQuality | null | undefined): { total: number; names: Array<{ name: string; count: number }> } | null {
  const counts = graphQuality?.counts;
  if (counts === null || counts === undefined || typeof counts !== 'object') return null;
  const names = Object.entries(counts)
    // Narrow to numbers here rather than at the `.sort` below: the counts come from
    // an external manifest, so a non-numeric entry is possible and would otherwise
    // reach the comparator as `unknown`.
    .filter((pair): pair is [string, number] => typeof pair[1] === 'number' && Number.isFinite(pair[1]))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const total =
    typeof graphQuality?.totalSites === 'number' && Number.isFinite(graphQuality.totalSites)
      ? graphQuality.totalSites
      : names.reduce((sum, entry) => sum + entry.count, 0);
  return { total, names };
}

/**
 * Compact a count for a dense row: 26788 → "26.8k", 2366932 → "2.4M".
 *
 * One decimal is kept all the way up, matching how the product's own dashboards
 * render counts. Rounding 26 788 to a bare "27k" discards the digits a reader is
 * actually comparing between repositories.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
