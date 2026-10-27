import * as React from 'react';
import { compactNumber } from '../format';
import { routeUrl } from '../navigation';
import {
  Button,
  FileTypeIcon,
  HAIRLINE,
  Histogram,
  INLINE_BUTTON,
  MUTED,
  MetricGrid,
  PathLabel,
  SOFT_BG,
  SegmentedControl,
  StateDot,
  Tag,
  h,
  styles,
} from '../primitives';
import { FileHistorySection } from './file-history';
import {
  ClientActivity,
  ClientActivityBaseline,
  ClientActivityCommit,
  ClientActivityFile,
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
          h('span', null, baseline.reason ?? '基线提交不可读'),
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
          changedFiles.slice(0, 8).map((file) =>
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
        )
      : null,
  );
}

/** Newest-first commit list with per-commit index verdict. */
export function ActivityTimeline({
  timeline,
  indexKnown,
}: {
  timeline: ClientActivityCommit[];
  indexKnown: boolean;
}) {
  if (timeline.length === 0) {
    return h('div', { style: { ...MUTED } }, '该时间范围内没有提交。');
  }
  return h(
    'div',
    null,
    timeline.slice(0, 15).map((commit) => {
      const verdict = indexKnown
        ? activityVerdict(commit.verdict)
        : { label: '索引未知', tone: 'neutral' as const, dot: 'idle' as const };
      return h(
        'div',
        {
          key: commit.sha,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            padding: '4px 0',
            borderTop: HAIRLINE,
            minWidth: 0,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h(StateDot, { state: verdict.dot }),
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
        ),
        h(
          'div',
          {
            style: {
              ...MUTED,
              fontSize: '10px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6px',
              marginLeft: '14px',
            },
          },
          h(Tag, { tone: verdict.tone }, verdict.label),
          h('span', { style: { whiteSpace: 'nowrap' } }, commit.date.slice(0, 10)),
          h('span', { style: { whiteSpace: 'nowrap' } }, commit.author),
          h(
            'span',
            { style: { whiteSpace: 'nowrap' } },
            `+${compactNumber(commit.insertions)}/−${compactNumber(commit.deletions)}`,
          ),
          h(
            'span',
            { style: { whiteSpace: 'nowrap' } },
            `${compactNumber(commit.files)} 文件`,
          ),
        ),
      );
    }),
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
      ? h('div', null, changeRows.slice(0, 8).map((file) => fileListItem(file, 'byChanges')))
      : null,
    activeList === 'byRecency' && recentRows.length > 0
      ? h('div', null, recentRows.slice(0, 5).map((file) => fileListItem(file, 'byRecency')))
      : null,
    activeList === 'missing' && missingRows.length > 0
      ? h('div', null, missingRows.slice(0, 8).map((file) => fileListItem(file, 'missing')))
      : null,
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
      // Collapsed by default: the timeline is 50+ rows on an active repository and pushed
      // everything else (file lists, authors, branches) off the card. The count stays
      // visible, so the header still answers "how much happened" without the rows.
      h(
        Button,
        {
          variant: 'ghost',
          'aria-label': timelineOpen ? '收起提交时间线' : '展开提交时间线',
          title: timelineOpen ? '收起提交时间线' : '展开提交时间线',
          onClick: () => setTimelineOpen((open) => !open),
        },
        `${timelineOpen ? '▾' : '▸'} 提交时间线 · 近 ${timelineDays} 天 · ${projectTimeline.length} 个`,
      ),
      // The range selector moved to the card header: it scopes every number on the card,
      // not just this list, so it should not live behind the fold.
    ),
      timelineOpen
        ? h(ActivityTimeline, {
            timeline: projectTimeline,
            indexKnown: activity.totals?.indexKnown === true,
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
