import * as React from 'react';
import { compactNumber } from '../format';
import { routeUrl } from '../navigation';
import {
  FileTypeIcon,
  HAIRLINE,
  Histogram,
  MUTED,
  MetricGrid,
  PathLabel,
  SOFT_BG,
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
 * Files offered by the card header's picker.
 *
 * Recent work first, then the most-changed files, then the ones the index is missing —
 * a reader opening a timeline is usually asking "what changed lately", and a missing
 * file is the one worth inspecting. Deduplicated and capped: the header is a control,
 * not a file browser.
 */
export function activityFileOptions(
  activity: ClientActivity | null | undefined,
  limit = 40,
): string[] {
  if (activity === null || typeof activity !== 'object') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [activity.byRecency, activity.byChanges, activity.missingFiles]) {
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      const path = file?.path;
      if (typeof path !== 'string' || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= limit) return out;
    }
  }
  return out;
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
 * One touched file, with its verdict as a tag.
 *
 * The verdict tag is the whole point of the row: a path alone cannot tell a reader
 * whether the graph knows about it.
 * @param {{file: any}} props
 */
export function ActivityFileRow({
  file,
  onSelect,
}: {
  file: ClientActivityFile;
  onSelect?: (path: string) => void;
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
      style: { ...styles.fileRow, cursor: interactive ? 'pointer' : undefined },
    },
    h(FileTypeIcon, { path: file.path, size: 16 }),
    h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h(PathLabel, { path: file.path })),
    h(
      'span',
      { style: styles.fileMeta },
      interactive
        ? h('span', { style: { ...MUTED, fontSize: '10px', whiteSpace: 'nowrap' } }, '时间线')
        : null,
      h(Tag, { tone }, label),
      h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${file.changes}×`),
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
          fontSize: '10px',
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
}: {
  baseline: ClientActivityBaseline;
  onSelect?: (path: string) => void;
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
          changedFiles
            .slice(0, 8)
            .map((file) => h(ActivityFileRow, { key: file.path, file, onSelect })),
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
  onDaysChange,
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
  const [ownDays, setOwnDays] = React.useState(7);
  const timelineDays = days ?? ownDays;
  const [ownFile, setOwnFile] = React.useState<string | null>(null);
  const selectedFile = controlledFile === undefined ? ownFile : controlledFile;
  const [fileHistory, setFileHistory] = React.useState<ClientFileHistory | null>(null);
  const [fileHistoryBusy, setFileHistoryBusy] = React.useState(false);
  const [fileHistoryError, setFileHistoryError] = React.useState<string | null>(null);
  const fileHistorySeq = React.useRef(0);

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
  }, [selectedFile, timelineDays, projectPath]);

  const openFileHistory = (path: string): void => {
    if (onSelectFile) onSelectFile(path);
    else setOwnFile(path);
  };
  const closeFileHistory = (): void => {
    fileHistorySeq.current += 1;
    if (onCloseFile) onCloseFile();
    else setOwnFile(null);
    setFileHistory(null);
    setFileHistoryError(null);
    setFileHistoryBusy(false);
  };
  const changeTimelineDays = (value: number): void => {
    if (onDaysChange) onDaysChange(value);
    else setOwnDays(value);
  };

  const cutoff = Date.now() - timelineDays * 86_400_000;
  const projectTimeline = (Array.isArray(activity.timeline) ? activity.timeline : []).filter(
    (commit) => {
      const at = Date.parse(commit.date);
      return !Number.isFinite(at) || at >= cutoff;
    },
  );

  // Clicking a row expands that file's timeline under the row itself, so the answer
  // appears where the question was asked. The header picker can name a file that is not
  // in any of the lists below; that case still renders the block above the lists.
  const toggleFileHistory = (path: string): void => {
    if (selectedFile === path) closeFileHistory();
    else openFileHistory(path);
  };
  const fileHistoryBlock = (path: string): React.ReactNode =>
    selectedFile !== path
      ? null
      : h(
          'div',
          {
            style: {
              margin: '2px 0 8px',
              paddingLeft: '10px',
              borderLeft: HAIRLINE,
            },
          },
          h(FileHistorySection, {
            filePath: path,
            history: fileHistory,
            busy: fileHistoryBusy,
            error: fileHistoryError,
            onClose: closeFileHistory,
          }),
        );
  /**
   * One file, plus its inline timeline when open.
   *
   * The wrapper owns the key: the row and the expansion are one list item, so React does
   * not reuse a row's DOM for a different file when the list is re-filtered.
   */
  const fileListItem = (file: ClientActivityFile): React.ReactNode =>
    h(
      'div',
      { key: file.path },
      h(ActivityFileRow, { file, onSelect: toggleFileHistory }),
      fileHistoryBlock(file.path),
    );

  const listedPaths = new Set<string>();
  for (const list of [activity.byRecency, activity.byChanges, activity.missingFiles]) {
    if (!Array.isArray(list)) continue;
    for (const file of list) if (typeof file?.path === 'string') listedPaths.add(file.path);
  }
  const unlistedSelection = selectedFile !== null && !listedPaths.has(selectedFile);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
    // Only for a file that is not in a list below (usually picked in the header).
    unlistedSelection
      ? h(FileHistorySection, {
          filePath: selectedFile,
          history: fileHistory,
          busy: fileHistoryBusy,
          error: fileHistoryError,
          onClose: closeFileHistory,
        })
      : null,
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

    // Three views over the same window: what the index sees, what changed since the
    // index baseline, and the individual commits in order. Old hosts omit these
    // fields; each block disappears rather than rendering a false empty state.
    activity.totals?.indexKnown === false
      ? h(
          'div',
          { style: { ...MUTED } },
          '项目尚未建立索引：无法把活动文件与图谱交叉，也没有索引基线可审查。',
        )
      : activity.cross !== undefined && activity.cross !== null
        ? h(ActivityCrossTable, { cross: activity.cross })
        : null,
    activity.baseline !== undefined && activity.baseline !== null
      ? h(ActivityBaseline, { baseline: activity.baseline, onSelect: openFileHistory })
      : null,
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
      h(
        'span',
        { style: { ...MUTED } },
        `提交时间线 · 近 ${timelineDays} 天 · ${projectTimeline.length} 个`,
      ),
      h('span', { style: { flex: 1 } }),
      h(
        'select',
        {
          value: String(timelineDays),
          'aria-label': '项目提交时间线范围',
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            changeTimelineDays(Number(event.target.value)),
          style: {
            font: 'inherit',
            fontSize: '10px',
            padding: '2px 4px',
            border: HAIRLINE,
            borderRadius: '4px',
            background: SOFT_BG,
            color: 'inherit',
          },
        },
        [7, 14, 30].map((days) => h('option', { key: days, value: String(days) }, `${days} 天`)),
      ),
    ),
    h(ActivityTimeline, {
      timeline: projectTimeline,
      indexKnown: activity.totals?.indexKnown === true,
    }),
    activity.timelineTruncated === true
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px' } },
          '时间线最多显示最近 100 个提交；缩短范围可看更早记录。',
        )
      : null,

      // Missing files come from their own list, not from the display-capped
      // by-changes slice — otherwise the summary can report a count with no rows.
      missing > 0 && Array.isArray(activity.missingFiles) && activity.missingFiles.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '应被索引却缺失'),
            activity.missingFiles
              .slice(0, 8)
              .map((file) => fileListItem(file)),
          )
        : null,

      Array.isArray(activity.byChanges) && activity.byChanges.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '改动最频繁'),
            activity.byChanges
              .filter((f) => f.verdict !== 'excluded')
              .slice(0, 8)
              .map((file) => fileListItem(file)),
          )
        : null,

      Array.isArray(activity.byRecency) && activity.byRecency.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '最近改动'),
            activity.byRecency
              .filter((f) => f.verdict !== 'excluded')
              .slice(0, 5)
              .map((file) => fileListItem(file)),
          )
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

      Array.isArray(activity.branches) && activity.branches.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, `分支 · ${activity.branches.length}`),
            activity.branches.slice(0, 6).map((branch) =>
              h(
                'div',
                { key: branch.name, style: styles.fileRow },
                h('span', { style: { minWidth: 0, flex: '1 1 auto', ...styles.mono } }, branch.name),
                h(
                  'span',
                  { style: styles.fileMeta },
                  branch.current ? h(Tag, { tone: 'solid' }, '当前') : null,
                  h(
                    'span',
                    { style: { ...MUTED, whiteSpace: 'nowrap' } },
                    branch.lastCommitDate ? branch.lastCommitDate.slice(0, 10) : '',
                  ),
                ),
              ),
            ),
          )
        : null,
  );
}
