import * as React from 'react';
import { fixed, stackSegments } from '../format';
import { MUTED, Section, SegmentedControl, Tooltip, h, styles } from '../primitives';
import { ClientLanguages, LanguageRowLike } from '../types';

/**
 * The stacked bar plus its legend.
 *
 * Each segment carries a `Tooltip` rather than a native `title`: the primitives'
 * tooltip is the themed one, and a colour swatch a few pixels wide is otherwise
 * impossible to identify.
 *
 * The legend shows the top rows and folds the tail, because a sidebar has room for
 * roughly one line of chips — and a language at 0.02 % is not something a reader
 * scans for, it is something they look up when they already suspect it.
 *
 * @param {{rows: any[], totalBytes: number, totalFiles?: number, metric?: 'bytes'|'files'}} props
 */
export interface LanguageBarProps {
  rows: LanguageRowLike[];
  totalBytes: number;
  totalFiles?: number;
  metric?: 'bytes' | 'files';
}

export function LanguageBar({ rows, totalBytes, totalFiles = 0, metric = 'bytes' }: LanguageBarProps) {
  const segments = stackSegments(rows, totalBytes, totalFiles, metric);
  if (segments.length === 0) return null;

  const visible = segments.filter((s) => s.percent >= 0.05);
  const hidden = segments.length - visible.length;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h(
      'div',
      { style: styles.bar, role: 'img', 'aria-label': '语言分布' },
      segments.map((segment, index) =>
        h(
          Tooltip,
          { key: `${segment.key}-${index}`, label: `${segment.label} ${fixed(segment.percent, 1)}%`, side: 'bottom' },
          h('div', {
            // A floor keeps a 0.01% language visible; the flex ratio keeps the
            // major segments proportional.
            style: { width: `${Math.max(0.4, segment.percent)}%`, background: segment.color, flexShrink: 0 },
          }),
        ),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } },
      visible.map((segment) =>
        h(
          'span',
          { key: segment.key, style: { display: 'inline-flex', gap: '5px', alignItems: 'center' } },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: segment.color,
              display: 'inline-block',
              flexShrink: 0,
            },
          }),
          h('span', null, segment.label),
          h('span', { style: MUTED }, `${fixed(segment.percent, 1)}%`),
        ),
      ),
      hidden > 0 ? h('span', { style: MUTED }, `…另有 ${hidden} 种`) : null,
    ),
  );
}

/**
 * Language distribution, with the metric switchable.
 *
 * The toggle earns its place because bytes and files disagree in a way that
 * changes the answer: a repository can be 70 % TypeScript by bytes while being
 * mostly Markdown by file count, and either statement alone is misleading. The
 * control is a stateful wrapper so `CoverageView` stays a pure function of its
 * props and can still be rendered against a fixture.
 *
 * @param {{languages: {rows: any[], totalBytes: number, totalFiles: number}}} props
 */
export function LanguageSection({ languages }: { languages: ClientLanguages }) {
  const [metric, setMetric] = React.useState<'bytes' | 'files'>('bytes');
  const unit = metric === 'files' ? '文件' : '字节';

  return h(
    Section,
    {
      title: `语言分布 · ${languages.rows.length} 种`,
      meta: h(SegmentedControl, {
        id: 'gitnexus-language-metric',
        label: '语言分布统计口径',
        value: metric,
        // The control's API is string-valued; narrowing here rather than widening the
        // state keeps the union intact downstream, where `stackSegments` switches on
        // it — a widened state would let a typo like `'bytse'` compile.
        onChange: (next) => setMetric(next === 'files' ? 'files' : 'bytes'),
        options: [
          { value: 'bytes', label: '按字节' },
          { value: 'files', label: '按文件' },
        ],
      }),
      // The card stretches to the row height beside the overview card; the footnote
      // below uses `marginTop: auto` to sit at the foot of that height.
    },
    h(LanguageBar, {
      rows: languages.rows,
      totalBytes: languages.totalBytes,
      totalFiles: languages.totalFiles,
      metric,
    }),
    h(
      'div',
      { style: { marginTop: 'auto', paddingTop: '8px', fontSize: '10px', ...MUTED } },
      languages.detector === 'builtin'
        ? `按${unit}计的占比；GitNexus 不可用，语言由内置扩展名映射识别（仅作参考）`
        : `按${unit}计的占比；GitNexus 只解析其中一部分语言，其余仅作为文件节点存在`,
    ),
  );
}
