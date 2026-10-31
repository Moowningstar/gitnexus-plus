import * as React from 'react';
import { HAIRLINE, MUTED, SOFT_BG, StateDot, Tag, h } from '../primitives';
import type { ClientRisk, ClientRiskHit, ClientWarning } from '../types';

/**
 * The dependency-risk card.
 *
 * Three states, and the panel must not blur them: the tracker has a verdict, it has none yet,
 * or the host does not serve the route. The verdict itself is rendered from the host's own
 * sentence (`line`) and body (`text`) — the wording depends on whether the answer is "broken",
 * "exposed" or "could not be evaluated", and a second copy of that rule in the client is a
 * second thing to drift, the same lesson the delta notice already taught.
 *
 * What the client adds is only what prose cannot: a dot whose colour can be read at a glance,
 * counts, and the symbols themselves. Nothing here is clickable — a symbol reference is a
 * location, and the panel's habit of "click to open" belongs to the graph card, which knows
 * which session owns the file.
 */
export function RiskSection({
  risk,
  route,
  error,
  drift,
}: {
  risk: ClientRisk | null;
  /** Whether the host mounted `/api/gitnexus/risk`; `missing` is named, not swallowed. */
  route: 'unknown' | 'ready' | 'missing';
  error: string | null;
  /**
   * The scan's own "index and working tree disagree" warnings, moved here from the
   * caveats card so one fact has one home. Rendered only as a fallback: when the
   * tracker has a live change set, its numbers are the better answer and saying both
   * would invite the reader to reconcile two counting methods.
   */
  drift?: ClientWarning[];
}) {
  const report = risk?.risk ?? null;
  const counts = report?.counts ?? null;
  const tone =
    report === null || report.evaluated === false
      ? 'idle'
      : counts !== null && counts.broken > 0
        ? 'error'
        : counts !== null && counts.exposed > 0
          ? 'warning'
          : 'done';

  // A known verdict outranks a running refresh. `busy` is transient — an edit a few hundred
  // milliseconds ago starts one — and letting it replace the sentence meant a card that had
  // an answer spent its life saying 评估中… while the answer sat right below it.
  const headline =
    route === 'missing'
      ? '宿主未挂载追踪路由'
      : risk === null
        ? '读取中…'
        : risk.line ?? (risk.busy ? '评估中…' : '暂无改动');

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
      h(StateDot, { state: tone }),
      h('span', { style: { fontWeight: 600 } }, headline),
      risk?.watching === true ? h(Tag, { tone: 'outline' }, risk.live ? '监听中' : '轮询中') : null,
      risk?.busy === true ? h(Tag, { tone: 'outline' }, '正在查询') : null,
      risk?.degraded === null || risk?.degraded === undefined
        ? null
        : h(Tag, { tone: 'outline' }, '已降级'),
    ),

    route === 'missing'
      ? h(
          'div',
          { style: MUTED },
          '当前宿主没有 GET /api/gitnexus/risk，改动追踪不可用。重启 DSH 后加载新版本即可；工具与文本输出的风险行不受影响。',
        )
      : null,

    error === null
      ? null
      : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, error),

    risk?.degraded !== null && risk?.degraded !== undefined
      ? h('div', { style: MUTED }, risk.degraded)
      : null,

    // An unevaluated risk is not a clean one. Without this line the empty lists below read as
    // "nothing to see", which is the one failure mode this card exists to avoid.
    report !== null && report.evaluated === false
      ? h('div', { style: MUTED }, '这不是“没有风险”，而是这次没能算出来。')
      : null,

    counts === null
      ? null
      : h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', ...MUTED } },
          h('span', null, `确定断裂 ${counts.broken}`),
          h('span', null, `暴露 ${counts.exposed}`),
          h('span', null, `盲区 ${counts.blind}`),
          counts.crossCommunity > 0 ? h('span', null, `跨社区 ${counts.crossCommunity}`) : null,
          risk?.delta === null || risk?.delta === undefined
            ? null
            : h(
                'span',
                null,
                `改动 +${risk.delta.counts.added} ~${risk.delta.counts.modified} -${risk.delta.counts.deleted}`,
              ),
        ),

    report === null ? null : riskBody(report),

    risk === null ? null : filesBlock(risk),

    driftBlock(risk, drift),

    report !== null && report.truncated
      ? h('div', { style: MUTED }, '列表已截断：这里只列出引用最多的部分，计数是完整的。')
      : null,

    h(
      'div',
      { style: { ...MUTED, fontSize: '11px' } },
      '结构判断：来自上次 GitNexus 分析的调用关系，不是编译结论，也不代表测试通过或失败。',
    ),
  );
}

/** How long ago an ISO time was, in the few words a badge can hold. */
function ageText(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 1_000) return '刚刚';
  if (ms < 60_000) return `${Math.round(ms / 1_000)} 秒前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  return `${Math.round(ms / 3_600_000)} 小时前`;
}

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px' } as const;

/** One path, with the change kind when it has one and the time when it is a live event. */
function FileRow({ path, kind, at }: { path: string; kind?: string; at?: string }) {
  const mark = kind === 'added' ? '+' : kind === 'deleted' ? '-' : kind === 'excluded' ? '·' : '~';
  return h(
    'div',
    { style: { display: 'flex', gap: '8px', alignItems: 'baseline', minWidth: 0 } },
    kind === undefined ? null : h('span', { style: { ...MUTED, ...MONO, width: '10px', flex: 'none' } }, mark),
    h('span', { style: { ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, path),
    at === undefined ? null : h('span', { style: { ...MUTED, fontSize: '11px', marginLeft: 'auto', flex: 'none' } }, ageText(at)),
  );
}

/**
 * The two lists that answer "which files is the edit touching".
 *
 * They are different questions and stay separate. `recent` is event-level: a file appears the
 * moment it is written, before any hash is compared, so a save that changes nothing still
 * shows up — that is what makes it usable while an agent is mid-edit. `delta.files` is the
 * exact difference from the index, which is why it carries +/~/- marks and is only as fresh as
 * the last evaluation.
 */
function filesBlock(risk: ClientRisk): React.ReactElement | null {
  const recent = risk.recent ?? [];
  const changed = risk.delta?.files ?? [];
  const counts = risk.delta?.counts ?? null;
  if (recent.length === 0 && changed.length === 0) return null;
  const total = counts === null ? 0 : counts.modified + counts.added + counts.deleted + counts.excluded;
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },

    recent.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h(
            'div',
            { style: { ...MUTED, fontSize: '11px' } },
            `最近被写入 · ${recent.length} 个文件${risk.lastChangeAt === null || risk.lastChangeAt === undefined ? '' : `（最近一次 ${ageText(risk.lastChangeAt)}）`}`,
          ),
          recent.slice(0, 6).map((entry) => h(FileRow, { key: `recent-${entry.path}`, path: entry.path, at: entry.at })),
          recent.length > 6 ? h('div', { style: { ...MUTED, fontSize: '11px' } }, `另有 ${recent.length - 6} 个文件。`) : null,
        ),

    changed.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h(
            'div',
            { style: { ...MUTED, fontSize: '11px' } },
            counts === null
              ? '相对索引的改动'
              : `相对索引的改动（+${counts.added} ~${counts.modified} -${counts.deleted}${counts.excluded > 0 ? ` ·${counts.excluded} 被排除` : ''}）`,
          ),
          changed.slice(0, 8).map((entry) => h(FileRow, { key: `changed-${entry.path}`, path: entry.path, kind: entry.kind })),
          total > changed.length
            ? h('div', { style: { ...MUTED, fontSize: '11px' } }, `另有 ${total - changed.length} 个文件未列出。`)
            : null,
        ),
  );
}

/**
 * The scan's index-vs-working-tree caveats, shown only when the tracker has nothing to say.
 *
 * `uncovered-files` and `index-holds-retired-paths` describe the same gap as `delta` — the
 * working tree moved and the index did not — but they are computed from a fresh scan rather
 * than from a hash comparison, so the two counts can differ (exclusion rules, files outside
 * git). When a live change set exists it wins: two numbers for one fact would make the reader
 * compare counting methods instead of reading the answer.
 */
function driftBlock(risk: ClientRisk | null, drift: ClientWarning[] | undefined): React.ReactElement | null {
  const list = Array.isArray(drift) ? drift : [];
  if (list.length === 0) return null;
  const counts = risk?.delta?.counts ?? null;
  const deltaSilent =
    counts === null || counts.modified + counts.added + counts.deleted + counts.excluded === 0;
  if (!deltaSilent) return null;
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px', ...MUTED, fontSize: '11px' } },
    h('div', null, '索引与工作树（来自扫描，不是本次改动）'),
    list.map((warning, index) => h('div', { key: `${warning.code}-${index}` }, `· ${warning.message}`)),
  );
}

/** The prose body the host rendered, plus the broken symbols as a short list. */
function riskBody(report: NonNullable<ClientRisk['risk']>): React.ReactElement {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    report.broken.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { fontWeight: 600 } }, '确定断裂'),
          report.broken.slice(0, 5).map((hit) => h(RiskRow, { key: `b-${hit.symbol.id}`, hit, broken: true })),
        ),
    report.exposed.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { fontWeight: 600 } }, '暴露'),
          report.exposed
            .slice(0, 3)
            .map((hit) => h(RiskRow, { key: `e-${hit.symbol.id}`, hit, broken: false })),
        ),
    report.blind.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...MUTED } },
          h('div', null, '盲区（这些文件没有被比对）'),
          report.blind.slice(0, 3).map((spot) =>
            h(
              'div',
              { key: `s-${spot.path}` },
              `${spot.path} · ${spot.reason === 'not-in-index' ? '不在索引里' : '没有符号'}`,
            ),
          ),
        ),
    report.notes.length === 0
      ? null
      : h('div', { style: { ...MUTED, fontSize: '11px' } }, report.notes.join(' · ')),
  );
}

function RiskRow({ hit, broken }: { hit: ClientRiskHit; broken: boolean }) {
  const location = `${hit.symbol.filePath ?? '（未知文件）'}${hit.symbol.startLine === null ? '' : `:${hit.symbol.startLine}`}`;
  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px 8px',
        border: HAIRLINE,
        borderRadius: '6px',
        background: SOFT_BG,
      },
    },
    h(
      'div',
      { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('span', { style: { fontWeight: broken ? 600 : 400 } }, hit.symbol.name),
      h('span', { style: { ...MUTED, fontSize: '11px' } }, location),
      h('span', { style: { ...MUTED, fontSize: '11px' } }, `${hit.incoming} 处引用`),
      hit.crossCommunity ? h(Tag, { tone: 'outline' }, '跨社区') : null,
    ),
    hit.callers.length === 0
      ? null
      : h(
          'div',
          { style: { ...MUTED, fontSize: '11px' } },
          hit.callers
            .slice(0, 3)
            .map((caller) => `${caller.fromName ?? '（匿名）'} @ ${caller.fromFile ?? '?'}`)
            .join(' · '),
        ),
  );
}
