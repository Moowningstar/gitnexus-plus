import { capabilityRows, compactNumber, compatibilityLine, graphQualitySummary } from '../format';
import { MUTED, MetricGrid, StateDot, Tag, h } from '../primitives';
import { ClientCapability, ClientCompatibility, ClientGraphQuality, ClientProvenance } from '../types';

/**
 * Which query surfaces are live.
 * @param {{capabilities: any}} props
 */
export function CapabilityStrip({ capabilities }: { capabilities: Record<string, ClientCapability> | undefined }) {
  const rows = capabilityRows(capabilities);
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
    rows.map((row) =>
      h(
        'div',
        { key: row.key, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h(StateDot, { state: row.ok ? 'done' : 'idle' }),
        h('span', { style: { minWidth: '68px' } }, row.label),
        row.ok
          ? h('span', { style: MUTED }, row.provider)
          : h(Tag, { tone: 'outline' }, row.note),
      ),
    ),
  );
}

/**
 * Resolver confidence and analysis provenance.
 *
 * Body only — the surrounding `Section` card supplies the border and the heading.
 *
 * @param {{quality: any, provenance: any}} props
 */
export function ProvenanceBlock({ quality, provenance, compatibility }: { quality: ClientGraphQuality | null; provenance: ClientProvenance | null; compatibility?: ClientCompatibility | null }) {
  const summary = graphQualitySummary(quality);
  const versionLine = compatibilityLine(compatibility);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', flex: '1 1 auto' } },
    summary === null
      ? h('div', { style: MUTED }, '该索引未记录未解析接收者统计（旧版本写入）')
      : h(
          'div',
          null,
          h(
            'div',
            null,
            `未解析接收者 ${compactNumber(summary.total)} 处——存在这些位置时，impact / context 的结果是下界而非精确值`,
          ),
          h(
            'div',
            { style: { ...MUTED, marginTop: '3px' } },
            summary.names
              .slice(0, 6)
              .map((entry) => `${entry.name} ${entry.count}`)
              .join('  ·  '),
          ),
        ),
    provenance === null
      ? null
      : h(
          'div',
          // Pushed to the bottom: this card shares a row with the caveats card and
          // stretches to its height, so anchoring the metrics at the foot turns the
          // leftover space into a gap between two groups rather than a void below.
          { style: { marginTop: 'auto', paddingTop: '8px' } },
          h(MetricGrid, {
            items: [
              { label: 'schema', value: provenance.schemaFingerprint ?? '—' },
              { label: '内容保留', value: provenance.contentRetention ?? '—' },
              { label: 'FTS 配置', value: provenance.ftsProfile ?? '—' },
              { label: '跨语言属性', value: compactNumber(provenance.crossLanguageProperties ?? 0) },
              { label: '分析器', value: provenance.runnerCliVersion ?? '—' },
              {
                label: '索引/CLI',
                value: compatibility === undefined || compatibility === null
                  ? '—'
                  : `${compatibility.indexedBy ?? '缺失'} / ${compatibility.installed ?? '缺失'}`,
              },
            ],
          }),
          versionLine === null
            ? null
            : h(
                'div',
                {
                  style: {
                    ...MUTED,
                    marginTop: '4px',
                    fontSize: '10px',
                    ...(versionLine.tone === 'warn' ? { color: '#d9a441' } : null),
                  },
                },
                versionLine.text,
              ),
        ),
  );
}

/** Collapsed summary for the provenance card's header. */
export function provenanceCollapsed(quality: ClientGraphQuality | null): string {
  const summary = graphQualitySummary(quality);
  return summary === null ? '无未解析接收者记录' : `未解析接收者 ${compactNumber(summary.total)} 处`;
}
