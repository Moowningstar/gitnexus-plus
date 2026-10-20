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

/**
 * Theme tokens, with a fallback for a host that predates them.
 *
 * Measured against the installed `dsh-context` plugin: the platform's own cards are
 * `--dsw-alias-bg-layer-1` on `--dsw-alias-border-l2` at radius 10, 13px text, and
 * secondary text is `--dsw-alias-label-secondary` — not `opacity`, which fades the
 * text against whatever is behind it instead of using the alias colour the rest of
 * the app is tuned for.
 */
export const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, currentColor)';
export const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)';
export const BG_LAYER_1 = 'var(--dsw-alias-bg-layer-1, transparent)';
export const BG_LAYER_2 = 'var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 6%, transparent))';
export const BORDER_L2 = 'var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))';

export const MUTED = { color: LABEL_SECONDARY };
export const HAIRLINE = `1px solid ${BORDER_L2}`;
export const SOFT_BG = BG_LAYER_2;

/** Tabular figures, so a column of counts lines up instead of drifting. */
export const NUMERIC = { fontVariantNumeric: 'tabular-nums' as const };

/**
 * Layout.
 *
 * The panel is a CARD GRID: the surface it lives in can be narrow (a docked sidebar)
 * or wide (a maximised pane), and the platform's own panels use a responsive grid
 * rather than one column — measured on `dsh-context`, whose cards sit two-up on a wide
 * pane and stack in the sidebar.
 *
 * The floor is 320px, not the 620px an earlier revision used: with 620, a docked
 * sidebar of ~380px produced a second column laid *past* the visible edge and the
 * activity card lost its third verdict. 320 fits the narrowest sidebar this panel is
 * docked into, and two columns only appear when the pane can hold `2 × 320 + gap`.
 *
 * `alignItems: 'start'` is deliberate now that cards share rows: without it the grid
 * stretches a short card to the height of its tall neighbour, which is exactly the dead
 * space the reference layout avoids. With it, a card keeps its natural height and the
 * row's remaining space stays empty rather than inside a border.
 *
 * `minmax(0, 1fr)` keeps the min-content floor from letting a card widen its own
 * container. A card that needs the full width says so with `gridColumn: '1 / -1'`
 * (`wide` below).
 */
export const styles = {
  root: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    alignItems: 'start',
    gap: '8px',
    padding: '12px',
    fontSize: '13px',
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
    background: BG_LAYER_1,
    border: HAIRLINE,
    borderRadius: '10px',
    padding: '10px 12px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  /** A card that spans every column. */
  cardWide: {
    background: BG_LAYER_1,
    border: HAIRLINE,
    borderRadius: '10px',
    padding: '10px 12px',
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
  /**
   * Cap the card body and scroll inside it, instead of letting the card grow and the
   * whole panel scroll. A number is the cap in pixels; `true` uses 360.
   *
   * Opt-in per card: the platform's own panels do this for long lists (measured on
   * `dsh-context`: `max-height: min(560px, 80vh)` plus `overflow-y: auto`) while short
   * cards size to content. Wrapping every card unconditionally would change the
   * spacing of the ones that already manage their own layout.
   */
  scroll?: boolean | number;
  bodyStyle?: React.CSSProperties;
}

export function Section({ title, meta, wide = false, children, style, scroll = false, bodyStyle }: SectionProps) {
  const body =
    scroll === false || scroll === undefined
      ? children
      : h(
          'div',
          {
            style: {
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              overflowY: 'auto',
              maxHeight: typeof scroll === 'number' ? `${scroll}px` : '360px',
              overscrollBehavior: 'contain',
              paddingRight: '2px',
              ...bodyStyle,
            },
          },
          children,
        );

  return h(
    'section',
    { style: { ...(wide ? styles.cardWide : styles.card), ...style } },
    title === undefined
      ? null
      : h(
          'div',
          {
            style: {
              marginBottom: '8px',
              display: 'flex',
              alignItems: 'baseline',
              gap: '8px',
              minWidth: 0,
              fontWeight: 600,
            },
          },
          typeof title === 'string' ? h('span', { style: { color: LABEL_PRIMARY } }, title) : title,
          h('span', { style: { flex: 1 } }),
          meta === undefined || meta === null
            ? null
            : h('span', { style: { ...MUTED, fontWeight: 400, fontSize: '12px', minWidth: 0 } }, meta),
        ),
    body,
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
