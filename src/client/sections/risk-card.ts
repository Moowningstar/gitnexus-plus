import * as React from 'react';
import { HAIRLINE, MUTED, SOFT_BG, StateDot, Tag, h } from '../primitives';
import type { ClientRisk, ClientRiskHit } from '../types';

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
}: {
  risk: ClientRisk | null;
  /** Whether the host mounted `/api/gitnexus/risk`; `missing` is named, not swallowed. */
  route: 'unknown' | 'ready' | 'missing';
  error: string | null;
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

  const headline =
    route === 'missing'
      ? '宿主未挂载追踪路由'
      : risk === null
        ? '读取中…'
        : risk.busy
          ? '评估中…'
          : risk.line ?? '暂无改动';

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
