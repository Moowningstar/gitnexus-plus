// Namespace imports, not `require` and not default imports. `tsconfig.client.json`
// runs with `esModuleInterop: false`, under which `import * as React from 'react'`
// compiles to a bare `const React = require("react")` — exactly the form the loader
// factory provides, with no `__importStar` helper riding along into every page load.
// It is also the only form that gives `React.ReactNode` and `React.CSSProperties`
// as usable type namespaces.
import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { compactNumber, fixed } from './format';
import { ClientLargeFile, DotState, HistogramBucketLike } from './types';

const {
  Button,
  FileTypeIcon,
  PathLabel,
  SegmentedControl,
  StateDot,
  Tag,
  Tooltip,
  IconRefreshOutlineRegular,
  classifyFileType,
} = primitives;

export { Button, FileTypeIcon, PathLabel, SegmentedControl, StateDot, Tag, Tooltip, IconRefreshOutlineRegular, classifyFileType };

export const h = React.createElement;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const MUTED = { opacity: 0.62 };
export const HAIRLINE = '1px solid color-mix(in srgb, currentColor 16%, transparent)';
export const SOFT_BG = 'color-mix(in srgb, currentColor 6%, transparent)';

/** Layout only. Appearance belongs to the primitives, which read `--dsw-*` tokens. */
/**
 * Layout.
 *
 * The panel is a CARD GRID, not a vertical stack: the surface it lives in can be
 * narrow (a docked sidebar) or very wide (a maximised pane), and a single column of
 * full-width cards reads as broken at the wide end — every metric row stretches
 * across a metre of empty space.
 *
 * A single column is the honest layout for a docked sidebar. The previous
 * `auto-fit` grid asked for two columns whenever the pane was wide enough for
 * `2 × 620px + gap`; in a real narrow sidebar it therefore laid the second column —
 * the entire language breakdown — past the visible edge, and the wide Git-activity
 * card lost its third verdict. Tuning the floor only moves which pane width breaks;
 * one column always fits. On a wide pane the card internals still distribute their
 * metrics, so the space is not wasted.
 *
 * `minmax(0, 1fr)` also removes the min-content floor that let the grid widen its
 * own container. A card that needs the full width still says so with
 * `gridColumn: '1 / -1'`, which is harmless in one column and keeps the markup
 * honest if the layout ever changes.
 */
export const styles = {
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    // No `alignItems: start`: grid items stretch to the row height by default, so
    // two cards sharing a row end level. With `start` each card took its natural
    // height and the row showed a ragged bottom edge.
    gap: '10px',
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    overflowY: 'auto',
    // A card that overflows must be scrolled to, not painted outside the pane and
    // mistaken for a neighbouring surface.
    overflowX: 'hidden',
    height: '100%',
    boxSizing: 'border-box',
  },
  /**
   * A card that takes one grid column.
   *
   * Flex column, not block. A card stretched by the grid has a definite height, and
   * its body needs to grow into that height — which `height: 100%` on the body gets
   * wrong: a percentage height is resolved from the parent, so the body's own
   * content stops contributing to the row's intrinsic height, the row is sized too
   * short, and the body spills past the border. `flex: 1` on the body grows it
   * without breaking the content-based sizing.
   */
  card: {
    border: HAIRLINE,
    borderRadius: '8px',
    padding: '10px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  /** A card that spans every column. */
  cardWide: {
    border: HAIRLINE,
    borderRadius: '8px',
    padding: '10px',
    minWidth: 0,
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  bar: { display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', background: SOFT_BG },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  fileRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' },
  fileMeta: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
};

/**
 * One card: an optional heading row, then the body.
 *
 * Every section goes through this so the span decision is made once per card, next
 * to the content that justified it, rather than as a style literal repeated at each
 * call site.
 *
 * `SectionProps` keeps `title` and `meta` open to a node as well as a string: some
 * cards pass an element (a control, a live status dot) where others pass a label.
 */
export interface SectionProps {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  wide?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Section({ title, meta, wide = false, children, style }: SectionProps) {
  return h(
    'section',
    { style: { ...(wide ? styles.cardWide : styles.card), ...style } },
    title === undefined
      ? null
      : h(
          'div',
          { style: { marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          typeof title === 'string' ? h('span', { style: MUTED }, title) : title,
          h('span', { style: { flex: 1 } }),
          meta ?? null,
        ),
    children,
  );
}

export interface RowProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Row({ children, style }: RowProps) {
  return h('div', { style: { ...styles.row, ...style } }, children);
}

/**
 * One file's flags, as native tags.
 */
export function FileFlags({ file }: { file: ClientLargeFile }) {
  const flags: React.ReactNode[] = [];
  if (file.minified?.binary) {
    flags.push(h(Tag, { key: 'bin', tone: 'neutral' }, '二进制'));
  } else if (file.minified?.suspect) {
    flags.push(h(Tag, { key: 'min', tone: 'info' }, `单行 ~${Math.round(file.minified.avgLineLength)}`));
  }
  if (file.generatedHint) {
    flags.push(h(Tag, { key: 'gen', tone: 'outline' }, '构建产物'));
  }
  if (flags.length === 0) return null;
  return h('span', { style: { display: 'inline-flex', gap: '4px', flexShrink: 0 } }, flags);
}

/**
 * A donut with its value in the middle.
 *
 * SVG rather than a charting dependency: one arc is a `stroke-dasharray` on a
 * circle, and pulling in a chart library for it would add more surface than the
 * whole client half. The value sits in the hole because that is the number the
 * ring is *about* — a ring whose meaning lives only in the stroke width makes the
 * reader estimate what could simply be stated.
 *
 * @param {{ ratio: number, caption: string, tone?: string, size?: number }} props
 */
export interface RingProps {
  ratio: number;
  caption: string;
  tone?: string;
  size?: number;
}

export function Ring({ ratio, caption, tone = 'currentColor', size = 76 }: RingProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clamped;

  return h(
    'div',
    { style: { position: 'relative', width: `${size}px`, height: `${size}px`, flexShrink: 0 } },
    h(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': caption },
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: 'currentColor',
        strokeOpacity: 0.15,
        strokeWidth: stroke,
      }),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: tone,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: `${dash} ${circumference - dash}`,
        // Start the arc at twelve o'clock rather than three.
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1px',
        },
      },
      h('span', { style: { fontSize: '15px', fontWeight: 600, ...styles.mono } }, `${fixed(clamped * 100, 1)}%`),
      h('span', { style: { fontSize: '10px', ...MUTED } }, caption),
    ),
  );
}

/**
 * A two-column metric grid with a coloured dot per row.
 *
 * The dot is `StateDot` where a metric has a state, and a plain swatch where it
 * only has an identity — the distinction keeps a neutral count from reading as a
 * status. Tabular figures and right-aligned values so a column of numbers can be
 * compared without reading each one.
 *
 * @param {{ items: Array<{ label: string, value: string, hint?: string, color?: string, state?: string }> }} props
 */
export interface MetricItem {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  /** Present when the metric carries a status; absent when it is only an identity. */
  state?: DotState;
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return h(
    'div',
    { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '4px 16px' } },
    items.map((item) =>
      h(
        'div',
        { key: item.label, style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        item.state !== undefined
          ? h(StateDot, { state: item.state })
          : h('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: item.color ?? 'currentColor',
                opacity: item.color === undefined ? 0.4 : 1,
                flexShrink: 0,
              },
            }),
        // Label and value sit ADJACENT. A flex spacer between them was a bug that
        // only showed on a wide pane: the cell stretched and pushed the two ends
        // hundreds of pixels apart, so a row read as two unrelated columns of text
        // rather than one metric.
        h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, item.label),
        h('span', { style: { fontWeight: 600, ...styles.mono, whiteSpace: 'nowrap' } }, item.value),
        item.hint !== undefined ? h('span', { style: { ...MUTED, fontSize: '10px' } }, item.hint) : null,
      ),
    ),
  );
}

/**
 * Commit activity over time, as columns.
 *
 * The reference panel's trend chart, reduced to what this data supports: counts per
 * bucket, with the bucket width taken from the data rather than assumed. Bars are
 * stacked insertions-over-deletions in the two directions a chart can honestly show
 * — one column's total height is commits, so line churn rides as a filled fraction
 * rather than a second scale the eye would have to calibrate.
 *
 * @param {{ histogram: { bucketDays: number, buckets: Array<{label:string,commits:number,insertions:number,deletions:number}> }, height?: number }} props
 */
export interface HistogramProps {
  histogram: { bucketDays: number; buckets: HistogramBucketLike[] };
  height?: number;
}

export function Histogram({ histogram, height = 54 }: HistogramProps) {
  const buckets = histogram?.buckets ?? [];
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.commits), 1);
  const bucketDays = histogram.bucketDays ?? 1;

  // One bucket is not a time series. Drawing it produced a full-width, full-height
  // rectangle that read as a skeleton or a broken chart — measured on this
  // repository, whose entire history fits in one week. The totals directly above
  // already say the same number, so state the bucket instead of drawing it.
  if (buckets.length === 1) {
    const only = buckets[0];
    return h(
      'div',
      { style: { ...MUTED, display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('span', null, `${only.label} 起这一${bucketDays === 7 ? '周' : '天'}`),
      h('span', null, `${only.commits} 次提交`),
      h('span', null, `+${compactNumber(only.insertions)} / -${compactNumber(only.deletions)}`),
    );
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
    h(
      'div',
      {
        style: { display: 'flex', alignItems: 'flex-end', gap: '1px', height: `${height}px` },
        role: 'img',
        'aria-label': `提交活动，每${bucketDays === 7 ? '周' : '天'}一柱`,
      },
      buckets.map((bucket, index) =>
        h(
          Tooltip,
          {
            key: `${bucket.label}-${index}`,
            label: `${bucket.label} · ${bucket.commits} 提交 · +${bucket.insertions}/-${bucket.deletions}`,
            side: 'bottom',
          },
          h('div', {
            style: {
              flex: '1 1 0',
              // Bars do not grow past a readable width on a wide pane; a two-bucket
              // chart otherwise stretches each bar across half the card.
              maxWidth: '56px',
              // A zero bucket keeps a visible floor so a gap reads as "no commits"
              // rather than as missing data.
              height: `${Math.max(2, (bucket.commits / max) * height)}px`,
              // The host's real token. The first version invented `--dsw-color-accent`,
              // which does not exist, so every bar fell back to `currentColor` and the
              // chart rendered as a grey block in both themes.
              background:
                bucket.commits === 0
                  ? 'currentColor'
                  : 'var(--dsw-alias-brand-primary, currentColor)',
              opacity: bucket.commits === 0 ? 0.16 : 0.75,
              borderRadius: '1px',
              alignSelf: 'flex-end',
            },
          }),
        ),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', ...MUTED } },
      h('span', null, buckets[0]?.label ?? ''),
      h('span', null, `每${bucketDays === 7 ? '周' : '天'} · 峰值 ${max}`),
      h('span', null, buckets[buckets.length - 1]?.label ?? ''),
    ),
  );
}
