import { capSourceLabel, compactNumber, fileSize, summaryLine } from '../format';
import { HAIRLINE, MUTED, MetricGrid, Ring, h } from '../primitives';
import { ClientCap, ClientReport, ClientTotals } from '../types';
import { CapabilityStrip } from './capabilities';

/**
 * The overview card's body: the coverage ring, the scan summary, and the three
 * readings (files in, graph out, query capabilities).
 *
 * Lifted out of the panel so the card can be read on its own. The panel keeps the
 * section wrapper and the split-region layout around it.
 */
export function OverviewBody({
  report,
  totals,
  cap,
  ratio,
}: {
  report: ClientReport;
  totals: ClientTotals;
  cap: ClientCap;
  ratio: number | null;
}) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        // Ring and scan summary on one line, metrics below at full card width. Keeping
        // the ring in a left rail stole ~90px from the metric grid at exactly the widths
        // where it needed two columns, so the card turned into a tall single column.
        h(
          'div',
          { style: { display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0 } },
          ratio === null
            ? null
            : h(Ring, {
                ratio,
                caption: '覆盖',
                tone:
                  ratio >= 0.9
                    ? 'var(--dsw-alias-state-success-primary, #3fb950)'
                    : 'var(--dsw-alias-state-warn-primary, #d9a441)',
              }),
          h('div', { style: { ...MUTED, minWidth: 0 } }, summaryLine(report)),
        ),

        // The three readings sit in a grid instead of a column: 文件 and 图谱 share a
        // row, and the capability strip spans the full width below them. A stacked
        // layout left the right half of the card empty at every width above ~360px.
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '10px 20px',
              alignItems: 'start',
            },
          },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { style: { ...MUTED, marginBottom: '5px' } }, '文件'),
              h(MetricGrid, {
                items: [
                  { label: '大小上限', value: cap.text, hint: capSourceLabel(cap.source), color: '#d9a441' },
                  { label: '跳过合计', value: fileSize(totals.largeBytes), color: '#e0af68' },
                  {
                    label: '超限文件',
                    value: compactNumber(totals.large),
                    // Amber when something was actually dropped, grey when the count is
                    // zero: a zero is good news and should not shout.
                    color: totals.large > 0 ? '#f7768e' : undefined,
                  },
                ],
              }),
            ),
            report.graph === null || report.graph === undefined
              ? null
              : h(
                  'div',
                  { style: { minWidth: 0 } },
                  h('div', { style: { ...MUTED, marginBottom: '5px' } }, '图谱'),
                  h(MetricGrid, {
                    items: [
                      { label: '符号', value: compactNumber(report.graph.nodes), color: '#7aa2f7' },
                      { label: '边', value: compactNumber(report.graph.edges), color: '#9ece6a' },
                      { label: '社区', value: compactNumber(report.graph.communities), color: '#bb9af7' },
                      { label: '流程', value: compactNumber(report.graph.processes), color: '#7dcfff' },
                      { label: '向量', value: compactNumber(report.graph.embeddings), color: '#f7768e' },
                    ],
                  }),
                ),
            h(
              'div',
              { style: { gridColumn: '1 / -1', borderTop: HAIRLINE, paddingTop: '8px' } },
              h('div', { style: { ...MUTED, marginBottom: '5px' } }, '查询能力'),
              h(CapabilityStrip, { capabilities: report.capabilities }),
              report.capabilities?.fts?.status === 'available'
                ? null
                : h(
                    'div',
                    { style: { ...MUTED, marginTop: '4px', fontSize: '10px' } },
                    '顶部「关键词搜索」会先查图；图查询不可用时回退到源码关键词。',
                  ),
            ),
        ),

  );
}
