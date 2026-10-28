import * as React from 'react';
import { compactNumber } from '../format';
import { routeUrl } from '../navigation';
import {
  FileTypeIcon,
  HAIRLINE,
  Histogram,
  INLINE_BUTTON,
  MUTED,
  MetricGrid,
  NUMERIC,
  PathLabel,
  SOFT_BG,
  SegmentedControl,
  StateDot,
  Tag,
  h,
  styles,
} from '../primitives';
import { DiffView, FileHistorySection } from './file-history';
import {
  ClientActivity,
  ClientActivityBaseline,
  ClientActivityCommit,
  ClientActivityFile,
  ClientCommitDiff,
  ClientFileHistory,
  DotState,
} from '../types';

/** Collapsed summary for the activity card's header. */
export function activityCollapsed(activity: ClientActivity | null | undefined): string {
  const view = activityView(activity);
  if (view === null) return '不可用';
  const missing = view.verdicts.find((v) => v.key === 'missing')?.value ?? 0;
  if (missing > 0) return `${missing} 个活跃文件不在索引中`;
  return `活跃文件均在索引中${view.truncated ? ' · 窗口已截断' : ''}`;
}

/**
 * All activity numbers in one place, so the view stays a layout decision.
 * @param {any} activity
 * @returns {null | { window: string, totals: string, verdicts: Array<{key:string,label:string,value:number,tone:string}> }}
 */
export function activityView(activity: ClientActivity | null | undefined): { window: string; totals: string; verdicts: Array<{ key: string; label: string; value: number; tone: DotState }>; truncated: boolean } | null {
  if (activity === null || typeof activity !== 'object') return null;
  const t = activity.totals ?? {};
  const v = t.verdicts ?? { indexed: 0, excluded: 0, missing: 0 };
  return {
    window: `近 ${activity.window?.sinceDays ?? '?'} 天`,
    truncated: activity.window?.truncated === true,
    totals: `${t.commits ?? 0} 提交 · ${t.authors ?? 0} 作者 · ${compactNumber(t.insertions ?? 0)} 增 / ${compactNumber(t.deletions ?? 0)} 删`,
    // Ordered so the actionable verdict is first: "missing" is the only one that
    // means the index is behind. "excluded" next to it, because a reader who sees
    // only "not indexed" will otherwise read it as a defect.
    verdicts: [
      { key: 'indexed', label: '已索引', value: v.indexed, tone: 'done' },
      { key: 'missing', label: '索引缺失', value: v.missing, tone: v.missing > 0 ? 'warning' : 'idle' },
      { key: 'excluded', label: '有意排除', value: v.excluded, tone: 'idle' },
    ],
  };
}

/**
 * Rows a list should show.
 *
 * `excluded` is dropped because a dotfile or an ignored path is not something to act
 * on. Without this filter the lists read as noise: the index classifies every scanned
 * file, and the ones nobody is looking for outnumber the ones they are.
 *
 * @param {ClientActivityFile[] | undefined} files
 * @returns {ClientActivityFile[]}
 */
export function listedActivityFiles(files: ClientActivityFile[] | undefined): ClientActivityFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => file.verdict !== 'excluded');
}

/** Which of the card's lists a row was clicked in. */
export type ActivityFileList = 'baseline' | 'missing' | 'byChanges' | 'byRecency';

/**
 * The list that owns the open timeline, given where it was clicked.
 *
 * The same path can sit in three lists at once, so "where the block goes" cannot be
 * derived from the path — it is the pair that was clicked. Returning null means the
 * header's picker named the file, and the block belongs under the picker.
 *
 * @param {{path: string, list: string} | null} origin
 * @param {string | null} selectedFile
 * @returns {ActivityFileList | null}
 */
export function activityBlockHost(
  origin: { path: string; list: ActivityFileList } | null,
  selectedFile: string | null,
): ActivityFileList | null {
  if (origin === null || selectedFile === null) return null;
  return origin.path === selectedFile ? origin.list : null;
}

/**
 * One touched file, with its verdict as a tag.
 *
 * The verdict tag is the whole point of the row: a path alone cannot tell a reader
 * whether the graph knows about it.
 */
export function ActivityFileRow({
  file,
  onSelect,
  selected = false,
  showVerdict = true,
}: {
  file: ClientActivityFile;
  onSelect?: (path: string) => void;
  /** The open timeline belongs to this row: tint it and say how to close. */
  selected?: boolean;
  /** Off while the row is classified against a different branch's manifest. */
  showVerdict?: boolean;
}) {
  const tone = file.verdict === 'indexed' ? 'solid' : file.verdict === 'missing' ? 'outline' : 'neutral';
  const label = file.verdict === 'indexed' ? '已索引' : file.verdict === 'missing' ? '缺失' : '排除';
  const interactive = typeof onSelect === 'function';
  return h(
    'div',
    {
      role: interactive ? 'button' : undefined,
      tabIndex: interactive ? 0 : undefined,
      title: interactive ? '查看该文件的提交时间线' : undefined,
      onClick: interactive ? () => onSelect?.(file.path) : undefined,
      onKeyDown: interactive
        ? (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect?.(file.path);
            }
          }
        : undefined,
      style: {
        ...styles.fileRow,
        // A clickable row is a button: the same hairline and radius as the workspace
        // project rows, so "this row acts" is visible before hovering. A row that only
        // reports (no `onSelect`) stays plain text.
        ...(interactive
          ? { cursor: 'pointer', border: HAIRLINE, borderRadius: '4px', padding: '3px 6px' }
          : {}),
        ...(selected ? { background: SOFT_BG } : {}),
      },
    },
    h(FileTypeIcon, { path: file.path, size: 16 }),
    h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h(PathLabel, { path: file.path })),
    h(
      'span',
      { style: styles.fileMeta },
      interactive
        ? h('span', { style: { ...INLINE_BUTTON, ...MUTED } }, selected ? '收起' : '时间线')
        : null,
      showVerdict ? h(Tag, { tone }, label) : null,
      h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${file.changes} 次`),
    ),
  );
}

/** Shared labels/tones for the three activity verdicts. */
export function activityVerdict(verdict: string): { label: string; tone: 'solid' | 'outline' | 'neutral'; dot: DotState } {
  if (verdict === 'indexed') return { label: '已索引', tone: 'solid', dot: 'done' };
  if (verdict === 'missing') return { label: '索引缺失', tone: 'outline', dot: 'warning' };
  return { label: '设计排除', tone: 'neutral', dot: 'idle' };
}

/** Rows each "show more" adds to a file list. */
const FILE_PAGE_STEP = 25;

/**
 * The rest of a list, one click away.
 *
 * Fixed slices were why the card showed 8 rows beside a label reading 97: the count said
 * how much there was and the list silently stopped. A truncation a reader can act on is
 * worth more than one they have to notice.
 */
function MoreRows({
  shown,
  total,
  onMore,
}: {
  shown: number;
  total: number;
  onMore: () => void;
}) {
  if (total <= shown) return null;
  return h(
    'div',
    { style: { ...MUTED, fontSize: '10px', paddingTop: '2px' } },
    h(
      'span',
      {
        role: 'button',
        tabIndex: 0,
        onClick: onMore,
        onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onMore();
          }
        },
        style: { ...INLINE_BUTTON },
      },
      `显示更多（还有 ${total - shown} 个）`,
    ),
  );
}

/**
 * The three-way verdict with the volume behind it.
 *
 * The old UI had counts only, which made "2 missing" look as urgent as "2 excluded"
 * even when the missing files accounted for 40 commits. This table adds the volume
 * without changing the verdict definition.
 */
export function ActivityCrossTable({ cross }: { cross: NonNullable<ClientActivity['cross']> }) {
  const rows = Array.isArray(cross.rows) ? cross.rows : [];
  if (rows.length === 0) return null;
  const cell = { padding: '3px 0', textAlign: 'right' as const };
  return h(
    'div',
    null,
    h(
      'div',
      { style: { ...MUTED, marginBottom: '4px' } },
      `活动 × 索引交叉对比 · ${compactNumber(cross.totalFiles ?? 0)} 文件 / ` +
        `${compactNumber(cross.totalChanges ?? 0)} 次变更`,
    ),
    h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.5fr) repeat(4, minmax(0, 0.65fr))',
          gap: '4px',
          alignItems: 'center',
          fontSize: '11px',
        },
      },
      h('span', { style: MUTED }, '分类'),
      h('span', { style: { ...MUTED, ...cell } }, '文件'),
      h('span', { style: { ...MUTED, ...cell } }, '变更'),
      h('span', { style: { ...MUTED, ...cell } }, '+行'),
      h('span', { style: { ...MUTED, ...cell } }, '−行'),
      rows.map((row) => {
        const verdict = activityVerdict(row.verdict);
        return [
          h(
            'span',
            { key: `${row.verdict}-label`, style: { display: 'flex', alignItems: 'center', gap: '5px' } },
            h(StateDot, { state: verdict.dot }),
            verdict.label,
          ),
          h('span', { key: `${row.verdict}-files`, style: cell }, compactNumber(row.files)),
          h('span', { key: `${row.verdict}-changes`, style: cell }, compactNumber(row.changes)),
          h('span', { key: `${row.verdict}-ins`, style: cell }, `+${compactNumber(row.insertions)}`),
          h('span', { key: `${row.verdict}-del`, style: cell }, `−${compactNumber(row.deletions)}`),
        ];
      }),
    ),
  );
}

/** HEAD against the commit the index was built from. */
export function ActivityBaseline({
  baseline,
  onSelect,
  selectedPath = null,
  renderBlock,
}: {
  baseline: ClientActivityBaseline;
  onSelect?: (path: string) => void;
  /** The file whose timeline is open, when this list owns it. */
  selectedPath?: string | null;
  /** Renders the timeline directly under its row. */
  renderBlock?: (path: string) => React.ReactNode;
}) {
  const changedFiles = Array.isArray(baseline.changedFiles) ? baseline.changedFiles : [];
  // The engine ships up to 50 of the changed files. Eight is a screenful; the rest is
  // behind one click rather than silently absent from a list that names its own size.
  const [shownFiles, setShownFiles] = React.useState(8);
  const short = baseline.shortSha ?? baseline.ref?.slice(0, 8) ?? '未知';
  const date = typeof baseline.date === 'string' ? baseline.date.slice(0, 10) : '';
  const windowBaseline = baseline.source === 'window';
  return h(
    'div',
    null,
    h(
      'div',
      { style: { ...MUTED, marginBottom: '4px' } },
      `${windowBaseline ? '活动窗口基线审查' : '索引基线审查'} · ${short}` +
        (date === '' ? '' : ` · ${date}`),
    ),
    windowBaseline
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px', marginBottom: '3px' } },
          '索引没有记录基线提交，使用活动窗口最早的提交作为基线。',
        )
      : null,
    baseline.available === false
      ? h(
          'div',
          { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
          h(StateDot, { state: 'warning' }),
          h('span', null, baseline.reason ?? '基线提交不可用'),
        )
      : h(
          'div',
          { style: { ...MUTED } },
          (baseline.commits ?? 0) === 0 && (baseline.files ?? 0) === 0
            ? '工作区与索引基线一致，没有新增变更。'
            : `自基线以来 ${compactNumber(baseline.commits ?? 0)} 个提交 · ` +
              `${compactNumber(baseline.files ?? 0)} 个文件 · ` +
              `+${compactNumber(baseline.insertions ?? 0)} / −${compactNumber(baseline.deletions ?? 0)}`,
        ),
    changedFiles.length > 0
      ? h(
          'div',
          { style: { marginTop: '4px' } },
          changedFiles.slice(0, shownFiles).map((file) =>
            h(
              'div',
              { key: file.path },
              h(ActivityFileRow, {
                file,
                onSelect,
                selected: selectedPath === file.path,
              }),
              typeof renderBlock === 'function' ? renderBlock(file.path) : null,
            ),
          ),
          h(MoreRows, {
            shown: shownFiles,
            total: changedFiles.length,
            onMore: () => setShownFiles((count) => count + FILE_PAGE_STEP),
          }),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Commit graph: a lane per line of history, plus the files behind a commit
// ---------------------------------------------------------------------------

/**
 * Gutter geometry.
 *
 * A fixed row height is what makes a lane graph possible without measuring the DOM:
 * each row draws its own SVG of known height, so a line that continues downwards ends
 * exactly where the next row's line begins. The cost is that the row's text must fit
 * — one line for the subject, one for the metadata — which it already did.
 *
 * The numbers are borrowed from the two readers people already know (VS Code's Git Graph
 * and GitHub Desktop): 14px per column and a 3.6px dot. At the 10px this started with,
 * two adjacent branches were 10px apart while the dot was 6.4px wide, so the lines ran
 * under the dots and the picture read as one thick smear.
 */
const LANE_WIDTH = 14;
const LANE_PAD = 10;
const LANE_ROW_HEIGHT = 46;

/**
 * The dot, and the hole the lines leave around it.
 *
 * The gap is geometric, not a background-coloured stroke: a stroke can only match the
 * card colour if it knows the card colour, and at the panel's own background the
 * effect is a subtly wrong halo — which is what the first attempt looked like.
 * Ending the lines 2px outside the dot radius makes the dot sit *in* the lane instead
 * of being threaded onto it, whatever the theme does.
 */
const DOT_RADIUS = 4.5;
const DOT_GAP = 2;
/** Where a line may start or stop relative to the dot's centre. */
const DOT_CLEARANCE = DOT_RADIUS + DOT_GAP;

/**
 * Lanes drawn before the gutter stops widening.
 *
 * A repository mid-release can have a dozen branches open at once. The first columns
 * carry the trunk and its active branches — what a reader actually follows — and the
 * rest are counted in the gutter's title instead of drawn. Six at 14px is 94px of
 * gutter, which leaves the subject about 20 more characters than seven did at 10px.
 */
const MAX_DRAWN_LANES = 6;

/**
 * One colour per column, in the order a reader meets them.
 *
 * Colour is the only thing that makes a graph followable: without it every line is the
 * same grey and a reader has to trace pixels to see which branch a commit belongs to.
 * These are the eight hues VS Code's graph extension uses, chosen for dark and light
 * both — no state colour (green/yellow/red) appears here, because state belongs to the
 * index verdict and mixing the two vocabularies is what made the old gutter unreadable.
 */
const LANE_COLORS = [
  '#4c8dff',
  '#f9826c',
  '#a371f7',
  '#3fb950',
  '#d29922',
  '#db6d28',
  '#39c5cf',
  '#f778ba',
];

/** Where one commit sits in the graph, and which lines cross its row. */
export interface CommitLaneCell {
  lane: number;
  /** Other lanes whose commits are still pending, so their line crosses this row. */
  passThrough: number[];
  /** Lines leaving this row towards a parent's lane (a merge, or a branch point). */
  merges: Array<{ from: number; to: number }>;
  continuesDown: boolean;
}

/**
 * Assign every commit a column, newest first.
 *
 * This is the layout half of a commit graph, kept as a pure function because it is the
 * part that can be wrong in a way that is invisible: a lane is either the column a
 * commit's child continued into, or a new column. Two properties are deliberate and
 * covered by the tests — a first parent keeps its child's column when that column is
 * free (a trunk, not a staircase), and a parent that already waits in another column
 * is joined by a curve instead of opening a second lane for the same history.
 *
 * A parent older than the window simply opens a lane nobody terminates; its line then
 * runs to the bottom of the list, which is the honest picture.
 */
export function commitLanes(commits: Array<{ sha: string; parents?: string[] }>): {
  cells: CommitLaneCell[];
  laneCount: number;
} {
  /** The sha each column is waiting for, or null when the column is free. */
  const slots: Array<string | null> = [];
  const cells: CommitLaneCell[] = [];
  let laneCount = 0;

  const allocate = (): number => {
    const free = slots.indexOf(null);
    if (free !== -1) return free;
    slots.push(null);
    return slots.length - 1;
  };

  for (const commit of commits) {
    let lane = slots.indexOf(commit.sha);
    if (lane === -1) {
      // A commit whose child is outside the window starts a lane of its own.
      lane = allocate();
      slots[lane] = commit.sha;
    }
    const passThrough: number[] = [];
    for (let i = 0; i < slots.length; i += 1) {
      if (i !== lane && slots[i] !== null) passThrough.push(i);
    }
    slots[lane] = null;

    let continuesDown = false;
    const merges: Array<{ from: number; to: number }> = [];
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    parents.forEach((parent, order) => {
      const waiting = slots.indexOf(parent);
      if (waiting !== -1) {
        if (waiting !== lane) merges.push({ from: lane, to: waiting });
        return;
      }
      const target = order === 0 && slots[lane] === null ? lane : allocate();
      slots[target] = parent;
      if (target === lane) continuesDown = true;
      else merges.push({ from: lane, to: target });
    });

    laneCount = Math.max(
      laneCount,
      lane + 1,
      ...passThrough.map((i) => i + 1),
      ...merges.map((m) => m.to + 1),
    );
    cells.push({ lane, passThrough, merges, continuesDown });
  }

  return { cells, laneCount };
}

/** The colour of a column. Stable by index, so lane 1 is the same blue on every row. */
function laneColor(lane: number): string {
  const index = Number.isFinite(lane) && lane >= 0 ? Math.floor(lane) : 0;
  return LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0];
}

/**
 * The ring a dot wears when its commit is not fully indexed.
 *
 * The old gutter encoded this in the dot's fill, which meant colour said two different
 * things at once ("this branch" and "this commit has missing files"). The ring keeps the
 * verdict without taking the lane colour away from it; `null` means "nothing to add",
 * which is the normal case.
 */
function verdictRing(verdict: DotState): string | null {
  if (verdict === 'warning') return 'var(--dsw-alias-state-warning-primary, #d29922)';
  if (verdict === 'error') return 'var(--dsw-alias-state-error-primary, #f85149)';
  return null;
}

function laneX(lane: number): number {
  return LANE_PAD + lane * LANE_WIDTH;
}

/** The gutter width a lane count needs, clamped to what is drawn. */
function gutterWidth(laneCount: number): number {
  return LANE_PAD + Math.min(Math.max(laneCount, 1), MAX_DRAWN_LANES) * LANE_WIDTH;
}

/**
 * The curve a merge draws from one column to another.
 *
 * This is the shape the graph readers people already use produce (`toSvgPath` in
 * `@gitgraph/core` as a vertical bezier): both control points sit at the vertical
 * midpoint of the run, so the line leaves its commit vertically and enters the next
 * column vertically. The earlier fixed 18px inset looked fine on a square move and
 * doubled back on itself on a short one, which reads as a kink rather than a merge.
 *
 * Kept as a named function so it can be asserted without a renderer: the numbers are
 * the whole contract.
 */
export function laneCurve(fromX: number, toX: number, fromY: number, toY: number): string {
  const bend = (fromY + toY) / 2;
  return `M${fromX} ${fromY} C ${fromX} ${bend}, ${toX} ${bend}, ${toX} ${toY}`;
}

/**
 * One row's slice of the graph.
 *
 * Drawn per row rather than as one tall SVG on purpose: the list is small and not
 * virtualised, so a row's gutter cannot drift from the row it belongs to, and there is
 * no scroll offset to map. `overflow: visible` lets a curve reach a lane the width
 * clamped away instead of being silently cut in half.
 *
 * `emphasised` is the hover state: the row's own lane thickens and every lane it merely
 * passes stays at a third of its weight, so "which line am I on" is answered by pointing
 * at it. It is a prop rather than a CSS rule because there is no stylesheet to hook a
 * `:hover` into — the panel builds plain elements.
 */
export function LaneGutter({
  cell,
  laneCount,
  verdict,
  emphasised = false,
}: {
  cell: CommitLaneCell;
  laneCount: number;
  verdict: DotState;
  emphasised?: boolean;
}) {
  const drawn = Math.min(Math.max(laneCount, cell.lane + 1), MAX_DRAWN_LANES);
  const own = laneColor(cell.lane);
  const x0 = laneX(Math.min(cell.lane, drawn - 1));
  const middle = LANE_ROW_HEIGHT / 2;
  const width = gutterWidth(Math.max(laneCount, cell.lane + 1));
  const parts: React.ReactNode[] = [];
  const ownWidth = emphasised ? 2.8 : 2;

  for (const lane of cell.passThrough) {
    if (lane >= drawn) continue;
    parts.push(
      h('line', {
        key: `pass-${lane}`,
        x1: laneX(lane),
        x2: laneX(lane),
        y1: 0,
        y2: LANE_ROW_HEIGHT,
        stroke: laneColor(lane),
        strokeWidth: 2,
        opacity: emphasised ? 0.3 : 0.75,
        strokeLinecap: 'round',
      }),
    );
  }
  // The vertical run stops at the dot's clearance instead of crossing behind it: with a
  // 2px stroke drawn over every crossing, a continuous line reads as a bright seam
  // through the dot at any zoom level shorter than 100%.
  parts.push(
    h('line', {
      key: 'up',
      x1: x0,
      x2: x0,
      y1: 0,
      y2: middle - DOT_CLEARANCE,
      stroke: own,
      strokeWidth: ownWidth,
      strokeLinecap: 'round',
    }),
  );
  if (cell.continuesDown) {
    parts.push(
      h('line', {
        key: 'down',
        x1: x0,
        x2: x0,
        y1: middle + DOT_CLEARANCE,
        y2: LANE_ROW_HEIGHT,
        stroke: own,
        strokeWidth: ownWidth,
        strokeLinecap: 'round',
      }),
    );
  }
  for (const merge of cell.merges) {
    if (merge.to >= drawn) continue;
    const x2 = laneX(merge.to);
    // Control points at the vertical midpoint of the run, not a fixed 18px inset: the
    // inset version doubles back on itself when a column is short, which is what a
    // "kinked" merge looks like. This is the shape `toSvgPath` produces for a vertical
    // bezier, and it stays smooth at every column width. Starts at the dot's clearance
    // for the same reason the straight runs do.
    parts.push(
      h('path', {
        key: `merge-${merge.to}`,
        d: laneCurve(x0, x2, middle + DOT_CLEARANCE, LANE_ROW_HEIGHT),
        fill: 'none',
        stroke: laneColor(merge.to),
        strokeWidth: ownWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    );
  }
  // One divider at the gutter's right edge, drawn per row so it lines up with the
  // fixed row height. This replaces the old per-row horizontal connector: sixteen
  // faint rules crossing the graph read as table borders — the ugliest part of the
  // first version — while one continuous vertical rule just says "graph ends here".
  parts.push(
    h('line', {
      key: 'divider',
      x1: width - 1,
      x2: width - 1,
      y1: 0,
      y2: LANE_ROW_HEIGHT,
      stroke: 'var(--dsw-alias-border-secondary, #30363d)',
      strokeWidth: 1,
    }),
  );
  parts.push(
    h('circle', {
      key: 'dot',
      cx: x0,
      cy: middle,
      r: emphasised ? DOT_RADIUS + 0.7 : DOT_RADIUS,
      fill: own,
    }),
  );
  const ring = verdictRing(verdict);
  if (ring !== null) {
    // Outside the dot, with a gap: a verdict that recolours the dot is a verdict that
    // erases the lane colour, which is the one thing the graph is for.
    parts.push(
      h('circle', {
        key: 'ring',
        cx: x0,
        cy: middle,
        r: 6.2,
        fill: 'none',
        stroke: ring,
        strokeWidth: 1.4,
      }),
    );
  }
  // Lanes past the gutter's width limit are counted, not drawn: a number at the right
  // edge says "this row continues off the graph" and the title spells it out. Counting
  // the lanes this row actually touches, rather than `laneCount - drawn`, keeps the
  // number honest on a row where only some of the clamped lanes are alive.
  const hidden = new Set<number>();
  for (const lane of cell.passThrough) if (lane >= drawn) hidden.add(lane);
  for (const merge of cell.merges) if (merge.to >= drawn) hidden.add(merge.to);
  if (cell.lane >= drawn) hidden.add(cell.lane);
  if (hidden.size > 0) {
    parts.push(
      h(
        'text',
        {
          key: 'hidden',
          x: width - 5,
          y: middle + 3,
          textAnchor: 'end',
          fontSize: 9,
          fill: 'var(--dsw-alias-label-tertiary, #8b949e)',
          stroke: 'none',
        },
        `+${hidden.size}`,
      ),
    );
    parts.push(
      h('title', { key: 'title' }, `共 ${laneCount} 条分支线，仅绘制前 ${drawn} 条`),
    );
  }

  return h(
    'svg',
    {
      width,
      height: LANE_ROW_HEIGHT,
      'aria-hidden': true,
      style: { flexShrink: 0, display: 'block', overflow: 'visible' },
    },
    parts,
  );
}

/**
 * The files behind one commit, and the patch behind one of those files.
 *
 * The list rides in the activity payload; the patch is fetched per file because that
 * is the expensive half (`git show`, and a minified file is 120 KB) and only one file
 * is open at a time. `DiffView` is the same component the file timeline uses, so a
 * commit read from two directions looks identical. Pure view: the patch arrives as a
 * prop, so this renders in tests without a network.
 */
export function CommitFileList({
  commit,
  projectPath,
  openPath,
  diff,
  busy,
  error,
  onOpenPath,
}: {
  commit: ClientActivityCommit;
  projectPath?: string | null;
  openPath: string | null;
  diff: ClientCommitDiff | null;
  busy: boolean;
  error: string | null;
  onOpenPath: (path: string) => void;
}) {
  const files = Array.isArray(commit.changed) ? commit.changed : [];
  if (files.length === 0) {
    return h(
      'div',
      { style: { ...MUTED, fontSize: '10px', padding: '2px 0 4px' } },
      commit.files > 0 ? '该提交的文件列表没有随活动数据下发。' : '该提交没有改动文件。',
    );
  }
  const canOpen = typeof projectPath === 'string' && projectPath !== '';
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '2px 0 4px' } },
    commit.filesTruncated === true
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px' } },
          `仅列出前 ${files.length} 个文件（共 ${compactNumber(commit.files)} 个）`,
        )
      : null,
    files.map((file) => {
      const open = openPath === file.path;
      return h(
        'div',
        { key: file.path },
        h(
          'div',
          {
            role: canOpen ? 'button' : undefined,
            tabIndex: canOpen ? 0 : undefined,
            title: canOpen ? (open ? '收起该文件的改动' : '展开该文件的改动') : '需要宿主路由才能展开改动',
            onClick: canOpen ? () => onOpenPath(file.path) : undefined,
            onKeyDown: canOpen
              ? (event: React.KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenPath(file.path);
                  }
                }
              : undefined,
            style: {
              ...styles.fileRow,
              ...(canOpen
                ? { cursor: 'pointer', border: HAIRLINE, borderRadius: '4px', padding: '2px 6px' }
                : {}),
              ...(open ? { background: SOFT_BG } : {}),
            },
          },
          h(FileTypeIcon, { path: file.path, size: 14 }),
          h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h(PathLabel, { path: file.path })),
          h(
            'span',
            { style: { ...styles.fileMeta, whiteSpace: 'nowrap' } },
            h(
              'span',
              { style: { color: 'var(--dsw-alias-state-success-primary, #3fb950)' } },
              `+${compactNumber(file.insertions)}`,
            ),
            h(
              'span',
              { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } },
              `−${compactNumber(file.deletions)}`,
            ),
            canOpen ? h('span', { style: { ...INLINE_BUTTON, ...MUTED } }, open ? '收起' : '改动') : null,
          ),
        ),
        open ? h(DiffView, { path: file.path, diff, busy, error }) : null,
      );
    }),
  );
}

/** Commits a timeline shows before it offers the rest. */
const COMMIT_PAGE = 15;
/** Commits each "show more" adds. */
const COMMIT_PAGE_STEP = 50;

/**
 * Newest-first commit list: a lane gutter, the commit, and — on click — the files that
 * commit touched, each of which opens its patch.
 *
 * The timeline used to be a flat list of fifteen rows. Two things were missing for it
 * to be usable as a history view: where a commit sits relative to the branches around
 * it, and what it actually changed. Both are carried by the host payload (`parents`,
 * `changed`); the patch is the only thing fetched on demand.
 */
export function ActivityTimeline({
  timeline,
  indexKnown,
  projectPath,
}: {
  timeline: ClientActivityCommit[];
  indexKnown: boolean;
  /** Needed to fetch a commit's patch; absent in a test render disables the expansion. */
  projectPath?: string | null;
}) {
  const [shown, setShown] = React.useState(COMMIT_PAGE);
  const [openSha, setOpenSha] = React.useState<string | null>(null);
  // Which row the pointer is on. Only the gutter reads it, but it lives here because the
  // gutter is rendered per row and the row owns the pointer events.
  const [hoverSha, setHoverSha] = React.useState<string | null>(null);
  const [openPath, setOpenPath] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<ClientCommitDiff | null>(null);
  const [diffBusy, setDiffBusy] = React.useState(false);
  const [diffError, setDiffError] = React.useState<string | null>(null);
  const diffSeq = React.useRef(0);

  // A different commit, or a different file inside it, invalidates the open patch. The
  // sequence guard is what stops a slow `git show` for the previous file from landing
  // under the new one.
  React.useEffect(() => {
    if (openSha === null || openPath === null || !projectPath) {
      setDiff(null);
      setDiffError(null);
      setDiffBusy(false);
      return undefined;
    }
    const seq = diffSeq.current + 1;
    diffSeq.current = seq;
    setDiff(null);
    setDiffError(null);
    setDiffBusy(true);
    fetch(
      routeUrl(
        `/api/gitnexus/file-diff?repo=${encodeURIComponent(projectPath)}` +
          `&path=${encodeURIComponent(openPath)}&sha=${encodeURIComponent(openSha)}`,
      ),
    )
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .then(({ status, body }) => {
        if (seq !== diffSeq.current) return;
        if ((status === 404 && body?.code !== 'not-a-project') || status === 401) {
          throw new Error('当前宿主没有文件改动路由；重启 DSH 后再试。');
        }
        if (!body?.ok) {
          throw new Error(typeof body?.message === 'string' ? body.message : `请求失败 (${status})`);
        }
        setDiff(body as ClientCommitDiff);
      })
      .catch((cause) => {
        if (seq !== diffSeq.current) return;
        setDiffError(String((cause as Error)?.message ?? cause));
      })
      .finally(() => {
        if (seq === diffSeq.current) setDiffBusy(false);
      });
    return undefined;
  }, [openSha, openPath, projectPath]);

  if (timeline.length === 0) {
    return h('div', { style: { ...MUTED } }, '该时间范围内没有提交。');
  }

  // Lanes are computed over the whole list, not the visible prefix: paging then does
  // not re-shuffle the graph under the reader's cursor.
  const graph = commitLanes(timeline);
  const visible = timeline.slice(0, shown);
  const showMore = (): void => setShown((count) => count + COMMIT_PAGE_STEP);

  return h(
    'div',
    null,
    visible.map((commit, index) => {
      const cell: CommitLaneCell =
        graph.cells[index] ?? { lane: 0, passThrough: [], merges: [], continuesDown: false };
      const verdict = indexKnown
        ? activityVerdict(commit.verdict)
        : { label: '索引未知', tone: 'neutral' as const, dot: 'idle' as const };
      const open = openSha === commit.sha;
      const canOpen = Array.isArray(commit.changed) && commit.changed.length > 0;
      return h(
        'div',
        { key: commit.sha, style: { borderTop: HAIRLINE } },
        h(
          'div',
          {
            role: canOpen ? 'button' : undefined,
            tabIndex: canOpen ? 0 : undefined,
            'aria-expanded': canOpen ? open : undefined,
            title: canOpen
              ? open
                ? '收起该提交的文件列表'
                : '展开该提交的文件列表'
              : undefined,
            onClick: canOpen
              ? () => {
                  setOpenSha(open ? null : commit.sha);
                  setOpenPath(null);
                }
              : undefined,
            onKeyDown: canOpen
              ? (event: React.KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setOpenSha(open ? null : commit.sha);
                    setOpenPath(null);
                  }
                }
              : undefined,
            onMouseEnter: () => setHoverSha(commit.sha),
            onMouseLeave: () => setHoverSha((current) => (current === commit.sha ? null : current)),
            style: {
              display: 'flex',
              alignItems: 'stretch',
              gap: '2px',
              minWidth: 0,
              cursor: canOpen ? 'pointer' : undefined,
              // A row's lane is only legible while it can be followed: pointing at a row
              // dims every lane it merely crosses, so the one it sits on is the one you
              // see. Hover is React state rather than a CSS rule because the panel builds
              // plain elements and has no stylesheet to hang `:hover` on.
              ...(hoverSha === commit.sha ? { background: SOFT_BG } : {}),
            },
          },
          h(LaneGutter, {
            cell,
            laneCount: graph.laneCount,
            verdict: verdict.dot,
            emphasised: hoverSha === commit.sha,
          }),
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: '2px',
                minWidth: 0,
                flex: '1 1 auto',
                height: LANE_ROW_HEIGHT,
                paddingRight: '2px',
                ...(open ? { background: SOFT_BG } : {}),
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
              h(
                'span',
                { style: { ...styles.mono, color: 'inherit', whiteSpace: 'nowrap' } },
                commit.shortSha ?? commit.sha.slice(0, 8),
              ),
              h(
                'span',
                {
                  style: {
                    minWidth: 0,
                    flex: '1 1 auto',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  title: commit.subject,
                },
                commit.subject === '' ? '(无提交说明)' : commit.subject,
              ),
              ...(commit.refs ?? []).slice(0, 2).map((ref) => {
                // Tinted with the commit's own lane colour: the chip then answers "which
                // of these lines is this one" without a legend, which is the whole reason
                // the labels are inline. `color-mix` keeps it working in both themes; if
                // the engine is too old the declaration is dropped and only the border
                // shows, which still reads.
                const laneInk = laneColor(Math.min(cell.lane, MAX_DRAWN_LANES - 1));
                return h(
                  'span',
                  {
                    key: `ref-${ref}`,
                    title: ref,
                    style: {
                      ...MUTED,
                      flexShrink: 0,
                      fontSize: '10px',
                      lineHeight: 1.4,
                      padding: '0 4px',
                      borderRadius: '3px',
                      border: `1px solid ${laneInk}`,
                      color: laneInk,
                      background: `color-mix(in srgb, ${laneInk} 14%, transparent)`,
                      maxWidth: '110px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  ref,
                );
              }),
              canOpen ? h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, open ? '▾' : '▸') : null,
            ),
            h(
              'div',
              {
                style: {
                  ...MUTED,
                  fontSize: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                },
                title: `${commit.date} · ${commit.author}`,
              },
              h(Tag, { tone: verdict.tone }, verdict.label),
              h('span', { style: { whiteSpace: 'nowrap' } }, commit.date.slice(0, 10)),
              h(
                'span',
                { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                commit.author,
              ),
              h(
                'span',
                { style: { whiteSpace: 'nowrap' } },
                `+${compactNumber(commit.insertions)}/−${compactNumber(commit.deletions)}`,
              ),
              h('span', { style: { whiteSpace: 'nowrap' } }, `${compactNumber(commit.files)} 文件`),
            ),
          ),
        ),
        // The expansion keeps the gutter column, with the commit's own line running
        // down its left edge — otherwise opening a commit visually severs the branch
        // it belongs to.
        open
          ? h(
              'div',
              { style: { display: 'flex', gap: '2px' } },
              h(
                'div',
                {
                  style: {
                    width: gutterWidth(Math.max(graph.laneCount, cell.lane + 1)),
                    flexShrink: 0,
                    position: 'relative',
                  },
                },
                cell.continuesDown
                  ? h('div', {
                      style: {
                        position: 'absolute',
                        left: `${laneX(Math.min(cell.lane, MAX_DRAWN_LANES - 1)) - 0.5}px`,
                        top: 0,
                        bottom: 0,
                        width: '1px',
                        background: laneColor(Math.min(cell.lane, MAX_DRAWN_LANES - 1)),
                      },
                    })
                  : null,
              ),
              h(
                'div',
                { style: { minWidth: 0, flex: '1 1 auto' } },
                h(CommitFileList, {
                  commit,
                  projectPath,
                  openPath: open ? openPath : null,
                  diff: open ? diff : null,
                  busy: open && diffBusy,
                  error: open ? diffError : null,
                  onOpenPath: (path: string) => setOpenPath(openPath === path ? null : path),
                }),
              ),
            )
          : null,
      );
    }),
    timeline.length > shown
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px', borderTop: HAIRLINE, paddingTop: '4px' } },
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              onClick: showMore,
              onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  showMore();
                }
              },
              style: { ...INLINE_BUTTON },
            },
            `显示更多提交（还有 ${timeline.length - shown} 个）`,
          ),
        )
      : null,
  );
}

/**
 * Git activity, crossed with the index.
 *
 * Body only — the card and its disclosure header come from `CollapsibleCard`. The
 * header's collapsed line still carries the number that matters, so a reader who
 * never expands it learns whether recent work is visible to the graph.
 * @param {{activity: any}} props
 */
export function GitActivitySection({
  activity: rawActivity,
  projectPath,
  days,
  selectedFile: controlledFile,
  onSelectFile,
  onCloseFile,
}: {
  activity: ClientActivity | null | undefined;
  projectPath: string | null;
  /**
   * Controlled from the card header, which owns both the window label and the file
   * picker — the reader should not have to scroll past the whole timeline to open a
   * file's history. When the props are absent the section keeps its own state, so the
   * component still renders standalone in tests.
   */
  days?: number;
  onDaysChange?: (days: number) => void;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
  onCloseFile?: () => void;
}) {
  // The project timeline defaults to 7 days and caps at 30; the file timeline
  // reuses the same range. Hooks are before the "activity unavailable" return so
  // the hook order cannot change with the data.
  const [ownDays] = React.useState(7);
  const timelineDays = days ?? ownDays;
  /** The commit list starts folded: its header keeps the count visible. */
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  // One list at a time: `baseline`, `byChanges`, `byRecency` and `missing` describe the
  // same window from different angles, and stacking them made the card a wall of rows
  // that repeated the same paths three times. The control keeps every view one click
  // away without the duplication; `null` means "whichever list exists first".
  const [listTab, setListTab] = React.useState<ActivityFileList | null>(null);
  const [ownFile, setOwnFile] = React.useState<string | null>(null);
  const selectedFile = controlledFile === undefined ? ownFile : controlledFile;
  /** Which list the open timeline belongs to; null means the header's picker. */
  const [origin, setOrigin] = React.useState<{ path: string; list: ActivityFileList } | null>(null);
  // How many rows each list shows, kept per list: expanding the by-changes list and then
  // looking at the recency list must not reset the first one to a screenful. The numbers
  // start where the old fixed slices were, so the card opens at the same density. The
  // baseline list is absent on purpose — `ActivityBaseline` owns its own page, because it
  // renders outside this state and must keep paging while the timeline is open.
  const [shownRows, setShownRows] = React.useState<Record<Exclude<ActivityFileList, 'baseline'>, number>>({
    byChanges: 8,
    byRecency: 5,
    missing: 8,
  });
  const showMoreRows = (list: Exclude<ActivityFileList, 'baseline'>): void => {
    setShownRows((current) => ({ ...current, [list]: (current[list] ?? 0) + FILE_PAGE_STEP }));
  };
  const [fileHistory, setFileHistory] = React.useState<ClientFileHistory | null>(null);
  const [fileHistoryBusy, setFileHistoryBusy] = React.useState(false);
  const [fileHistoryError, setFileHistoryError] = React.useState<string | null>(null);
  /** Bumped by "重试"; it is the only thing that re-runs a failed read. */
  const [fileHistoryAttempt, setFileHistoryAttempt] = React.useState(0);
  const fileHistorySeq = React.useRef(0);
  const historyBlockRef = React.useRef<HTMLDivElement | null>(null);
  /** The list whose row opened the block, or null when the header picker did. */
  const blockHost = activityBlockHost(origin, selectedFile);

  // Scroll the open block into the nearest edge of the card. The lists sit in the
  // middle of a very long card, so a block opened from the last row can land off
  // screen without this. `origin` is in the deps because clicking the same path in
  // another list moves the block without changing `selectedFile`.
  React.useEffect(() => {
    const node = historyBlockRef.current;
    if (selectedFile === null || node === null) return;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [selectedFile, origin]);

  // Narrowed to a local const before use. `activityView` returns null for an absent
  // activity, but TypeScript cannot carry that back to the parameter, so every later
  // read would need its own guard — and a guard per read is how one gets forgotten.
  const activity = rawActivity;
  const view = activityView(activity);
  if (view === null || activity === null || activity === undefined) {
    return h('div', { style: { ...MUTED } }, 'Git 活动不可用');
  }
  const missing = view.verdicts.find((v) => v.key === 'missing')?.value ?? 0;

  // Fetching is driven by state, not by the click handler: the selected file can now
  // change from the card header, and the effect keeps both entry points on one path.
  React.useEffect(() => {
    if (selectedFile === null || projectPath === null) {
      setFileHistory(null);
      setFileHistoryError(null);
      setFileHistoryBusy(false);
      return undefined;
    }
    const seq = fileHistorySeq.current + 1;
    fileHistorySeq.current = seq;
    setFileHistory(null);
    setFileHistoryError(null);
    setFileHistoryBusy(true);
    const query =
      `/api/gitnexus/file-history?repo=${encodeURIComponent(projectPath)}` +
      `&path=${encodeURIComponent(selectedFile)}&days=${timelineDays}`;
    fetch(routeUrl(query))
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .then(({ status, body }) => {
        if (seq !== fileHistorySeq.current) return;
        // The client bundle can hot-reload before the host does. An unregistered
        // route comes back as the desktop carrier's 401/404, not the route's own
        // not-a-project JSON; say that instead of a generic status.
        if ((status === 404 && body?.code !== 'not-a-project') || status === 401) {
          throw new Error('当前宿主没有文件时间线路由；重启 DSH 后再试。');
        }
        if (!body?.ok) {
          throw new Error(
            typeof body?.message === 'string' ? body.message : `请求失败 (${status})`,
          );
        }
        setFileHistory(body as ClientFileHistory);
      })
      .catch((cause) => {
        if (seq !== fileHistorySeq.current) return;
        setFileHistoryError(String((cause as Error)?.message ?? cause));
      })
      .finally(() => {
        if (seq === fileHistorySeq.current) setFileHistoryBusy(false);
      });
    return undefined;
  }, [selectedFile, timelineDays, projectPath, fileHistoryAttempt]);

  const openFileHistory = (path: string, list: ActivityFileList): void => {
    // The origin is set here, not derived later: the same path can sit in three lists.
    setOrigin({ path, list });
    if (onSelectFile) onSelectFile(path);
    else setOwnFile(path);
  };
  const closeFileHistory = (): void => {
    fileHistorySeq.current += 1;
    setOrigin(null);
    if (onCloseFile) onCloseFile();
    else setOwnFile(null);
    setFileHistory(null);
    setFileHistoryError(null);
    setFileHistoryBusy(false);
  };

  const cutoff = Date.now() - timelineDays * 86_400_000;
  const projectTimeline = (Array.isArray(activity.timeline) ? activity.timeline : []).filter(
    (commit) => {
      const at = Date.parse(commit.date);
      return !Number.isFinite(at) || at >= cutoff;
    },
  );

  // The timeline opens *under the row that asked for it*, and only that row can open it.
  // Three lists name the same file independently (baseline, by-changes, by-recency), so
  // "where" cannot be derived from the path — it is remembered at the click.
  const toggleFileHistory = (path: string, list: ActivityFileList): void => {
    if (selectedFile === path && blockHost === list) closeFileHistory();
    else openFileHistory(path, list);
  };
  const historyBlock = (path: string): React.ReactNode =>
    h(
      'div',
      {
        key: `${path}#history`,
        ref: (node: HTMLDivElement | null) => {
          historyBlockRef.current = node;
        },
        style: {
          margin: '2px 0 8px',
          padding: '6px 8px',
          border: HAIRLINE,
          borderRadius: '6px',
          background: SOFT_BG,
        },
      },
      h(FileHistorySection, {
        projectPath,
        filePath: path,
        history: fileHistory,
        busy: fileHistoryBusy,
        error: fileHistoryError,
        onClose: closeFileHistory,
        onRetry: () => setFileHistoryAttempt((n) => n + 1),
      }),
    );
  /** The block, but only for the list that was clicked — null everywhere else. */
  const blockHere = (path: string, list: ActivityFileList): React.ReactNode =>
    blockHost === list && selectedFile === path ? historyBlock(path) : null;
  /**
   * One file, plus its inline timeline when open.
   *
   * The wrapper owns the key: the row and the expansion are one list item, so React does
   * not reuse a row's DOM for a different file when the list is re-filtered.
   */
  const fileListItem = (file: ClientActivityFile, list: ActivityFileList): React.ReactNode =>
    h(
      'div',
      { key: file.path },
      h(ActivityFileRow, {
        file,
        // The click records where it came from; the block follows that list, not the path.
        onSelect: (path: string) => toggleFileHistory(path, list),
        selected: blockHost === list && selectedFile === file.path,
        showVerdict: true,
      }),
      blockHere(file.path, list),
    );

  // The header picker names a file that belongs to no list; its block renders under the
  // control that named it, so the timeline still appears where the question was asked.
  const headerHistory = selectedFile !== null && blockHost === null ? historyBlock(selectedFile) : null;

  // The lists are one window seen from four angles: what changed since the index, what
  // changed most, what changed last, and what the index should have but does not. Only
  // one renders at a time — stacked, they repeated the same paths four times and turned
  // the card into a wall of rows, which is the density complaint this layout answers.
  const baselineData = activity.baseline;
  const changeRows = Array.isArray(activity.byChanges) ? activity.byChanges : [];
  const recentRows = Array.isArray(activity.byRecency) ? activity.byRecency : [];
  const missingRows = Array.isArray(activity.missingFiles) ? activity.missingFiles : [];
  const listViews: Array<{ value: ActivityFileList; label: string }> = [];
  if (baselineData !== undefined && baselineData !== null) {
    listViews.push({ value: 'baseline', label: `基线以来 ${baselineData.files ?? 0}` });
  }
  if (changeRows.length > 0) listViews.push({ value: 'byChanges', label: `改动最频繁 ${changeRows.length}` });
  if (recentRows.length > 0) listViews.push({ value: 'byRecency', label: `最近改动 ${recentRows.length}` });
  if (missing > 0 && missingRows.length > 0) {
    listViews.push({ value: 'missing', label: `应被索引缺失 ${missing}` });
  }
  const activeList =
    listTab !== null && listViews.some((entry) => entry.value === listTab)
      ? listTab
      : (listViews[0]?.value ?? null);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
    headerHistory,
    h('div', { style: MUTED }, view.totals),
    view.truncated
      ? h('div', { style: MUTED }, `活动窗口达到提交上限，更早的改动未统计`)
      : null,

    h(MetricGrid, {
      items: view.verdicts.map((v) => ({ label: v.label, value: compactNumber(v.value), state: v.tone })),
    }),

    // Commit activity over time. Placed above the file lists because "when" is
    // what makes the rest legible: a hot file means something different in a
    // burst week than in a slow one.
    activity.histogram !== undefined && activity.histogram !== null
      ? h(Histogram, { histogram: activity.histogram })
      : null,

    // One list, one control. Rendering all four side by side was the density problem:
    // the same path appeared in three of them and the card ran past two screens.
    listViews.length > 1
      ? h(SegmentedControl, {
          id: 'gnx-activity-list',
          label: '活动文件列表视图',
          value: activeList ?? '',
          options: listViews,
          onChange: (next: string) => setListTab(next as ActivityFileList),
        })
      : null,
    activeList === 'baseline' && baselineData !== undefined && baselineData !== null
      ? h(ActivityBaseline, {
          baseline: baselineData,
          onSelect: (path: string) => toggleFileHistory(path, 'baseline'),
          selectedPath: blockHost === 'baseline' ? selectedFile : null,
          renderBlock: (path: string) => blockHere(path, 'baseline'),
        })
      : null,
    activeList === 'byChanges' && changeRows.length > 0
      ? h(
          'div',
          null,
          changeRows.slice(0, shownRows.byChanges).map((file) => fileListItem(file, 'byChanges')),
          h(MoreRows, {
            shown: shownRows.byChanges,
            total: changeRows.length,
            onMore: () => showMoreRows('byChanges'),
          }),
        )
      : null,
    activeList === 'byRecency' && recentRows.length > 0
      ? h(
          'div',
          null,
          recentRows.slice(0, shownRows.byRecency).map((file) => fileListItem(file, 'byRecency')),
          h(MoreRows, {
            shown: shownRows.byRecency,
            total: recentRows.length,
            onMore: () => showMoreRows('byRecency'),
          }),
        )
      : null,
    activeList === 'missing' && missingRows.length > 0
      ? h(
          'div',
          null,
          missingRows.slice(0, shownRows.missing).map((file) => fileListItem(file, 'missing')),
          h(MoreRows, {
            shown: shownRows.missing,
            total: missingRows.length,
            onMore: () => showMoreRows('missing'),
          }),
        )
      : null,
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
      // Collapsed by default: the timeline is 50+ rows on an active repository and pushed
      // everything else (file lists, authors, branches) off the card. The count stays
      // visible, so the header still answers "how much happened" without the rows.
      //
      // Dressed as `INLINE_BUTTON`, not a ghost `Button`: a ghost button is a word with a
      // hover state, and on a card of plain sentences nothing said this line could be
      // clicked at all. Same hairline/tint/radius as the per-file `时间线` control, so the
      // two ways into the same list look like the same kind of thing.
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': timelineOpen,
          'aria-label': timelineOpen ? '收起提交时间线' : '展开提交时间线',
          title: timelineOpen ? '收起提交时间线' : '展开提交时间线',
          onClick: () => setTimelineOpen((open) => !open),
          style: {
            ...INLINE_BUTTON,
            fontSize: '11px',
            lineHeight: '20px',
            padding: '0 8px',
            gap: '6px',
            // Same tint as the per-file chip it mirrors; the caret is what says which way
            // the fold is pointing, so the fill does not have to carry that too.
            background: SOFT_BG,
          },
        },
        h('span', { style: { ...MUTED, fontSize: '9px' } }, timelineOpen ? '▾' : '▸'),
        h('span', null, '提交时间线'),
        h('span', { style: { ...MUTED, ...NUMERIC } }, `近 ${timelineDays} 天 · ${projectTimeline.length} 个`),
      ),
      // The range selector moved to the card header: it scopes every number on the card,
      // not just this list, so it should not live behind the fold.
    ),
      timelineOpen
        ? h(ActivityTimeline, {
            timeline: projectTimeline,
            indexKnown: activity.totals?.indexKnown === true,
            projectPath,
          })
        : null,
    timelineOpen && activity.timelineTruncated === true
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px' } },
          '时间线最多显示最近 100 个提交；缩短范围可看更早记录。',
        )
      : null,

    // Reference material, not the answer: the cross table restates the verdicts above,
    // and authors matter once per session. One disclosure keeps both reachable without
    // spending the card's height on them.
    h(
      'details',
      { style: { marginTop: '2px' } },
      h(
        'summary',
        { style: { ...INLINE_BUTTON, width: 'fit-content', listStyle: 'none' } },
        '更多统计 · 活动 × 索引交叉对比、提交者',
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '6px' } },
        activity.totals?.indexKnown === false
          ? h(
              'div',
              { style: { ...MUTED } },
              '项目尚未建立索引：无法把活动文件与图谱交叉，也没有索引基线可审查。',
            )
          : activity.cross !== undefined && activity.cross !== null
            ? h(ActivityCrossTable, { cross: activity.cross })
            : null,
        Array.isArray(activity.authors) && activity.authors.length > 0
          ? h(
              'div',
              null,
              h('div', { style: { ...MUTED, marginBottom: '4px' } }, '提交者'),
              activity.authors.slice(0, 6).map((author) =>
                h(
                  'div',
                  { key: `${author.name}-${author.email}`, style: styles.fileRow },
                  h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, author.name),
                  h(
                    'span',
                    { style: styles.fileMeta },
                    author.bot ? h(Tag, { tone: 'neutral' }, 'bot') : null,
                    h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${author.commits} 提交`),
                    h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${author.files} 文件`),
                  ),
                ),
              ),
            )
          : null,
      ),
    ),
  );
}

/**
 * Memoized for the panel: the activity payload is a stable object per report, and the
 * card is the longest one in the panel — re-rendering its lists on unrelated state is
 * the most expensive thing a stray render can do. Callbacks passed into it must be
 * stable (`setState` functions or `useCallback`), or the memo never hits.
 */
export const MemoizedGitActivitySection = React.memo(GitActivitySection);
