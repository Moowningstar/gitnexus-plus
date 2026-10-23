/**
 * The coverage view: one project's report, rendered.
 *
 * Split out of `panel.ts` when that file passed 1 800 lines. This half only turns an
 * already-fetched state (`CoverageViewProps`) into elements; `panel.ts` keeps the
 * fetching, the run orchestration and the project switcher, which is where the state
 * and the timers live.
 */

import * as React from 'react';
import { ZERO_ANALYZER, ZERO_CAP, ZERO_TOTALS, capSourceLabel, compactNumber, coverageRatio, fileSize, fixed, healthState, splitWarnings, stalenessView } from '../format';
import { Button, HAIRLINE, IconRefreshOutlineRegular, MUTED, MetricGrid, PathLabel, Row, Section, StateDot, SOFT_BG, h, styles } from '../primitives';
import { MemoizedOverviewBody } from '../sections/overview';
import { MemoizedGitActivitySection, activityCollapsed, activityView } from '../sections/activity';
import { ProvenanceBlock, provenanceCollapsed } from '../sections/capabilities';
import { ToolchainNotice } from '../sections/install';
import { MemoizedLanguageSection } from '../sections/languages';
import { LargeFileList } from '../sections/large-files';
import { MaintenanceSection, type MaintenanceStartMode } from '../sections/maintenance';
import { WorkspaceOverview } from '../sections/workspace';
import { SearchSection } from '../sections/search';
import { GraphSection } from '../sections/graph';
import { WebViewSection } from '../sections/webview';
import { ClientAnalyzeRun, ClientDelta, ClientInstallRun, ClientMaintenance, ClientProject, ClientReport, ContextDiagnostic, GraphViewState, SearchViewState } from '../types';
export interface CoverageViewProps {
  report: ClientReport | null;
  maintenance: ClientMaintenance | null | undefined;
  projectPath: string | null;
  /**
   * The workspace the panel was opened with. It is the search root for the project
   * list; the active project may be one of its descendants.
   */
  workspacePath?: string | null;
  /** Indexed projects under the workspace, nearest first. */
  projects?: ClientProject[];
  /** How many directories the host examined for the list. */
  projectsVisited?: number;
  /** Whether the host's search hit a bound. */
  projectsTruncated?: boolean;
  /** Why the project list could not be read, when it failed. */
  projectsError?: string | null;
  /** Switch the active project. The host reloads coverage; this view does not fetch. */
  onSelectProject?: (path: string) => void;
  context: ContextDiagnostic | null;
  busy: boolean;
  /** Numeric progress from the host, or null before the first event/for an old host. */
  progress?: LoadingProgress | null;
  error: string | null;
  /** When the report was read from the host, ISO. */
  readAt: string | null;
  /** The refresh run, or null when nothing has been started in this host. */
  run: ClientAnalyzeRun | null;
  runError: string | null;
  /**
   * The Tier 0 verdict that gates the refresh control. Optional so a view rendered
   * without a delta surface — a test fixture, or an older host — keeps the old
   * behaviour instead of demanding a prop it cannot be given.
   */
  delta?: ClientDelta | null;
  deltaError?: string | null;
  /** Whether the host mounted the delta route; `missing` is named, not swallowed. */
  deltaRoute?: 'unknown' | 'ready' | 'missing';
  onRefresh: () => void;
  onStartRun: (mode?: MaintenanceStartMode) => void;
  onCancelRun: () => void;
  /** The GitNexus install, when the operator authorised one. */
  installRun: ClientInstallRun | null;
  installError: string | null;
  onInstall: () => void;
  onCancelInstall: () => void;
  /**
   * Keyword search state. Optional so a view rendered without a search surface —
   * the no-index state, or a test fixture that only exercises the cards — stays a
   * pure function of what it is given.
   */
  search?: SearchViewState;
  /** Graph projection state. Optional for the same reason as `search`. */
  graph?: GraphViewState;
  /** Fired once the graph card is near the viewport, so the panel can defer its fetch. */
  onGraphNear?: () => void;
  /** Whether the panel has already been told the graph card is near. */
  graphVisible?: boolean;
}

/**
 * An indeterminate progress bar for the one request the panel makes.
 *
 * The host returns a single coverage JSON body; it has no byte/phase progress to
 * report. A native `<progress>` without `value` is the honest shape: it animates
 * while the request is pending and does not pretend to know a percentage. The
 * label is also the accessible value, so a screen reader gets the state, not just
 * a spinning rectangle.
 */
/** Real progress reported by the host while a read is in flight. */
export interface LoadingProgress {
  /** 0–100, based on completed phases and real scan/probe counters. */
  percent: number;
  /** The phase or file counter the host is currently in. */
  label: string;
}

/** The final NDJSON object from the streaming coverage route. */
export interface StreamReportPayload {
  report: ClientReport;
  maintenance: ClientMaintenance | null;
  readAt: string | null;
}

/**
 * Whether two polled run snapshots say the same thing.
 *
 * The poll runs every second and the host returns a fresh object each time, so setting
 * it unconditionally re-rendered the whole report once a second even when nothing had
 * changed. Elapsed time is advanced by each card's own clock now; this comparison is
 * what lets a quiet second stay quiet.
 */
export function LoadingBar({ label, percent }: { label: string; percent?: number | null }) {
  const value =
    percent === null || percent === undefined
      ? undefined
      : Math.max(0, Math.min(100, Math.round(percent)));
  const text = value === undefined ? label : `${label} · ${value}%`;
  return h(
    'div',
    {
      style: {
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
    },
    h('progress', {
      value,
      max: 100,
      'aria-label': label,
      'aria-valuetext': text,
      'aria-valuenow': value,
      style: {
        width: '100%',
        height: '4px',
        border: 0,
        borderRadius: '999px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.16))',
        accentColor: 'var(--dsw-alias-brand-primary, #4f8cff)',
        color: 'var(--dsw-alias-brand-primary, #4f8cff)',
      },
    }),
    h('div', { style: { ...MUTED, fontSize: '10px' } }, text),
  );
}

export function CoverageView({
  report,
  maintenance,
  projectPath,
  workspacePath,
  projects,
  projectsVisited,
  projectsTruncated,
  projectsError,
  onSelectProject,
  context,
  busy,
  progress,
  error,
  readAt,
  run,
  runError,
  delta,
  deltaError,
  deltaRoute,
  onRefresh,
  onStartRun,
  onCancelRun,
  installRun,
  installError,
  onInstall,
  onCancelInstall,
  search,
  graph,
  onGraphNear,
  graphVisible = false,
}: CoverageViewProps) {
  // Whether an index exists decides which maintenance command is applicable. When
  // the project could not even be identified there is nothing to claim, so it is
  // false rather than assumed.
  const indexed = report?.repo?.indexed === true;
  const graphCardRef = React.useRef<HTMLDivElement | null>(null);
  // Hooks must stay above every early return below: the panel renders once with
  // `report === null` while the first request is in flight, then again with the
  // report. Declaring this state after the loading/no-index returns changed the
  // hook count between those renders and crashed the sidebar with React #310.
  const [activityDays, setActivityDays] = React.useState(7);

  /**
   * Tell the panel when the graph card is near the viewport.
   *
   * The view stays presentational: it owns the ref and the observer, but the fetch
   * lives in the panel. A browser without IntersectionObserver reports immediately;
   * the test harness records effects but deliberately does not run them.
   */
  React.useEffect(() => {
    if (!indexed || graph === undefined) return undefined;
    const node = graphCardRef.current;
    if (node === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      onGraphNear?.();
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onGraphNear?.();
          observer.disconnect();
        }
      },
      { rootMargin: '200px', threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [indexed, graph === undefined, onGraphNear]);
  // A maintenance payload with no commands is not a section: rendering its title
  // produced an empty card on failed reads and on hosts that predate the route.
  const maintenanceSection =
    maintenance !== null &&
    maintenance !== undefined &&
    Array.isArray(maintenance.commands) &&
    maintenance.commands.length > 0
      ? maintenance
      : null;
  // The workspace and the active project are different facts when the index lives in a
  // subdirectory. The path position becomes a switcher when there is more than one.
  const projectChoices = projects ?? [];
  const indexedProjectCount = projectChoices.filter((project) => project.kind === 'index').length;
  const gitProjectCount = projectChoices.filter((project) => project.kind === 'git').length;
  const projectLabel = (project: ClientProject): string => {
    const base =
      project.relPath === ''
        ? `${project.name}（本工作区）`
        : project.relPath === project.name
          ? project.name
          : `${project.name} — ${project.relPath}`;
    return project.kind === 'git' ? `${base}（未索引）` : base;
  };
  const activeInChoices = projectChoices.some((project) => project.path === projectPath);
  const showSwitcher =
    projectChoices.length > 1 &&
    activeInChoices &&
    onSelectProject !== undefined &&
    projectPath !== null;
  const activeDiffers =
    projectPath !== null && workspacePath !== null && projectPath !== workspacePath;
  const header = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
    h(
      Row,
      null,
      report !== null && report.repo?.indexed ? h(StateDot, { state: healthState(report) }) : null,
      h('span', { style: { fontWeight: 600 } }, 'GitNexus 索引'),
      // The project, not a global picker. A workspace-scoped switcher is the one
      // selection this panel offers; it changes what the cards describe, nothing else.
      projectPath === null
        ? h('span', { style: MUTED }, '未解析到工作区')
        : showSwitcher
          ? h(
              'span',
              { style: { display: 'flex', alignItems: 'center', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
              h(
                'select',
                {
                  value: projectPath,
                  onChange: (event: { target: { value: string } }) =>
                    onSelectProject?.(event.target.value),
                  'aria-label': '切换工作区内的 GitNexus 索引',
                  title: `工作区：${workspacePath ?? ''} · ${projectChoices.length} 个索引`,
                  style: {
                    appearance: 'none',
                    border: 0,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    minWidth: 0,
                    maxWidth: '100%',
                    padding: 0,
                    cursor: 'pointer',
                  },
                },
                projectChoices.map((project) =>
                  h(
                    'option',
                    { key: project.path, value: project.path },
                    projectLabel(project),
                  ),
                ),
              ),
              h('span', { style: { ...MUTED, fontSize: '10px' } }, '▾'),
            )
          : h(
              'span',
              { style: { minWidth: 0, flex: '1 1 auto' } },
              h(PathLabel, { path: projectPath }),
            ),
      h('span', { style: { flex: 1 } }),
      // The label states the scope. "刷新" alone next to a staleness warning reads as
      // "rebuild the index", which this control has never done and — by design, since
      // the plugin spawns nothing — cannot do.
      h(
        Button,
        {
          variant: 'ghost',
          onClick: onRefresh,
          disabled: busy,
          title: '重新读取报告（不会重建索引；重建见下方「维护命令」）',
          'aria-label': '重新读取报告',
        },
        h(IconRefreshOutlineRegular, { size: 14 }),
      ),
    ),
    showSwitcher ||
    activeDiffers ||
    projectsTruncated === true ||
    (projectsError !== null && projectsError !== undefined)
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '11px', minWidth: 0, overflowWrap: 'anywhere' } },
          [
            showSwitcher
              ? `工作区：${workspacePath ?? ''} · ${projectChoices.length} 个项目` +
                (indexedProjectCount > 0
                  ? `（${indexedProjectCount} 个已索引）`
                  : gitProjectCount > 0
                    ? `（${gitProjectCount} 个 git 项目未索引）`
                    : '') +
                ` · 当前 ${projectPath ?? ''}`
              : activeDiffers
                ? `工作区：${workspacePath ?? ''} · 当前 ${projectPath ?? ''}`
                : null,
            projectsTruncated === true ? '项目搜索达到上限，可能还有未列出的项目。' : null,
            projectsError !== null && projectsError !== undefined
              ? `项目列表读取失败：${projectsError}`
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join(' '),
        )
      : null,
  );

  // A report already on screen stays readable while a manual refresh runs; the bar
  // rides above it. Before the first report exists, the bar is the whole body.
  // `percent` is null when the host does not stream (old host, or a cached read):
  // the native progress element is then indeterminate, not a made-up number.
  const progressBar =
    report === null || busy
      ? h(LoadingBar, {
          label: progress?.label ?? (report === null ? '正在读取索引…' : '正在刷新索引…'),
          percent: progress?.percent ?? null,
        })
      : null;

  // "I cannot tell which project this is" and "this project has no index" are
  // different facts, and the first revision conflated them: an unresolved project
  // fell through to the no-index branch and told the operator to initialise an
  // index for a project it had not identified. The diagnostic exists so that state
  // is actionable rather than a dead end.
  if (projectPath === null) {
    return h(
      'div',
      { style: styles.root },
      header,
      h(
        Section,
        { wide: true, style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'warning' }),
        h('span', null, '未能确定当前项目路径。'),
      ),
      context === null || context === undefined
        ? null
        : h(
            Section,
            { wide: true, title: '面板收到的上下文' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              h('div', null, `存在：${context.present.length > 0 ? context.present.join('、') : '（无）'}`),
              h('div', null, `缺失：${context.absent.length > 0 ? context.absent.join('、') : '（无）'}`),
            ),
          ),
    );
  }

  if (error !== null) {
    return h(
      'div',
      { style: styles.root },
      header,
      h(
        Section,
        { wide: true, style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'error' }),
        h('span', null, error),
      ),
      maintenanceSection !== null
        ? h(
            Section,
            {
              wide: true,
              title: '维护命令',
              meta: h('span', { style: { ...MUTED, fontSize: '12px' } }, '复制后到会话执行（沙箱与提权由 DSH 处理）'),
              scroll: 320,
            },
            h(MaintenanceSection, { maintenance: maintenanceSection, projectPath, indexed: false, run, runError, delta, deltaError, deltaRoute, onStartRun, onCancelRun }),
          )
        : null,
    );
  }

  if (report === null) {
    return h('div', { style: styles.root }, header, progressBar);
  }

  // Defaults are resolved before the no-index branch: a scan-only report still has
  // totals, a cap and languages even though it has no graph. Building them only for
  // an indexed report is what made "no index" mean "nothing to show".
  const totals = report.totals ?? ZERO_TOTALS;
  const cap = report.cap ?? ZERO_CAP;
  const analyzer = report.analyzer ?? ZERO_ANALYZER;
  const largeFiles = report.largeFiles ?? [];
  const languages = report.languages ?? null;

  const { notable, context: contextWarnings } = splitWarnings(report.warnings);
  const ratio = coverageRatio(report);

  // Multi-project workspaces get one aggregate card before the project-scoped ones.
  // It is null for a single project, so the common case is unchanged.
  const workspaceSection = h(WorkspaceOverview, {
    projects: projects ?? [],
    activePath: projectPath,
    onSelectProject,
  });

  // No index yet. This is the state the initialize command exists for, but it is
  // also a state in which the working tree is still readable: file counts, bytes,
  // the cap and the language split do not need GitNexus. The panel used to show
  // only "没有索引" and a command, which made an otherwise healthy repository look
  // empty. The scan is the "at least something to look at" floor.
  if (report.repo?.indexed !== true) {
    return h(
      'div',
      { style: styles.root },
      h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' } }, header),
      progressBar,
      h(ToolchainNotice, {
        toolchain: report.toolchain,
        run: installRun,
        runError: installError,
        onInstall,
        onCancelInstall,
      }),
      h(
        'div',
        { style: { gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'idle' }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h(
            'span',
            null,
            report.repo?.hasGit === false
              ? '该目录不是 git 仓库，也没有 GitNexus 索引。下面是工作区扫描结果；仍可建立索引（--skip-git），但没有提交基线与增量刷新，也不会有 Git 活动。'
              : '该项目还没有 GitNexus 索引。下面是工作区扫描结果；初始化后可看到图谱、查询能力与 Git 活动对账。',
          ),
          Array.isArray(projects)
            ? h(
                'span',
                { style: { ...MUTED, fontSize: '11px' } },
                projectsError !== null && projectsError !== undefined
                  ? `项目列表读取失败：${projectsError}；已按工作区描述。`
                  : indexedProjectCount === 0 && gitProjectCount > 0
                    ? `已在 ${projectsVisited ?? 0} 个目录中查找；工作区内有 ${gitProjectCount} 个 git 项目尚未建索引，可在标题栏切换后初始化。`
                    : indexedProjectCount === 0
                      ? `已在 ${projectsVisited ?? 0} 个目录中查找，没有找到 GitNexus 索引或 git 仓库。`
                      : null,
              )
            : null,
        ),
      ),
      h(
        Section,
        { wide: true, title: '扫描概览 · 尚未索引' },
        h(MetricGrid, {
          items: [
            { label: '扫描文件', value: compactNumber(totals.scanned) },
            { label: '选中文件', value: compactNumber(totals.selected) },
            { label: '扫描字节', value: fileSize(totals.scannedBytes ?? 0) },
            { label: '大小上限', value: cap.text, hint: capSourceLabel(cap.source) },
          ],
        }),
        h(
          'div',
          { style: { ...MUTED, marginTop: '6px' } },
          '这里的数字来自工作区，不是索引；索引里有什么，只有建立后才能回答。',
        ),
      ),
      languages !== null && languages.rows.length > 0 ? h(MemoizedLanguageSection, { languages }) : null,
      maintenanceSection !== null
        ? h(
            Section,
            {
              wide: true,
              title: '初始化索引',
              meta: h(
                'span',
                { style: { ...MUTED, fontSize: '11px' } },
                maintenanceSection.supportsForce === true
                  ? '均可直接执行，也可复制到会话（沙箱与提权由 DSH 处理）'
                  : '重启 DSH 后可执行；当前仅可复制（沙箱与提权由 DSH 处理）',
              ),
            },
            h(MaintenanceSection, { maintenance: maintenanceSection, projectPath, indexed, run, runError, delta, deltaError, deltaRoute, onStartRun, onCancelRun }),
          )
        : null,
    );
  }

  return h(
    'div',
    { style: styles.root },
    // The header and the two status lines span everything: they describe the whole
    // panel, so giving them a column would make them look like one card's heading.
    h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' } }, header),
    progressBar,

    // Immediately after the header, before any index content. If GitNexus is missing,
    // that single fact explains everything the panel is about to show or fail to show,
    // so it belongs above the numbers rather than beside them.
    h(ToolchainNotice, {
      toolchain: report.toolchain,
      run: installRun,
      runError: installError,
      onInstall,
      onCancelInstall,
    }),

    workspaceSection,

    h(
      'div',
      { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '3px' } },
      h(
        'div',
        { style: MUTED },
        `${report.repo.indexedAt ?? '未知时间'} · ${report.repo.branch ?? 'unknown'}@${String(report.repo.lastCommit ?? '').slice(0, 8)}` +
          ` · manifest ${report.repo.metaFile ?? '?'} · GitNexus ${analyzer.gitnexusVersion}` +
          // The read time is the only thing on screen a refresh can change when the
          // repository has not moved, so without it the control reads as broken.
          (readAt === null ? '' : ` · 读取于 ${String(readAt).slice(11, 19)}Z`),
      ),
      // Freshness against HEAD. The line above states the *indexed* commit, which
      // reads as current unless this one says otherwise.
      report.staleness === undefined
        ? null
        : (() => {
            const s = stalenessView(report.staleness);
            return h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h(StateDot, { state: s.state }),
              h('span', null, s.text),
            );
          })(),
    ),

    // Search sits above the report cards: it is the action a reader reaches for
    // before reading, not an annotation on the numbers below it.
    search === undefined ? null : h(SearchSection, { search }),

    // One card for the whole "what is this index" question — file coverage and
    // graph contents together.
    //
    // They were two cards. Side by side, the ring made the coverage card tall while
    // its three metrics stayed short, so the card carried a band of dead space; and
    // splitting them forced a reader to assemble one answer from two boxes. They are
    // the same fact at two resolutions: what went in, and what came out.
    // One split region: the tall overview on the left, the two compact readings
    // stacked on the right. The right column stretches to the overview's height, so the
    // quality card absorbs the difference instead of leaving a gap under it; a narrow
    // pane collapses the three into one column.
    h(
      'div',
      {
        style: {
          gridColumn: '1 / -1',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '8px',
          alignItems: 'stretch',
        },
      },
    h(
      Section,
      {
        // The left column of the split region: the one card that answers "what is in
        // this index". The right column stacks the two compact readings beside it.
        title: '索引概览',
        meta:
          report.graph === null || report.graph === undefined
            ? null
            : h('span', { style: { ...MUTED, fontSize: '12px' } }, `${fixed(report.graph.edgesPerNode, 2)} 边/符号`),
      },
      h(MemoizedOverviewBody, { report, totals, cap, ratio }),

    ),

      h(
        'div',
        // The column stretches to the overview's height; the quality card below takes
        // whatever the language card leaves, so the right side ends level with the left.
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 } },
    // Shares the overview row: a stacked bar plus its legend is a proportional reading,
    // and pairing it with the coverage figure puts the two "how much of this
    // repository" answers side by side. The grid gives them one row on a wide pane and
    // one column in a narrow sidebar, which is the platform's own behaviour.
    languages !== null && languages.rows.length > 0
      ? h('div', { style: { flex: '0 0 auto', minWidth: 0 } }, h(MemoizedLanguageSection, { languages }))
      : null,

    // Fills the rest of the column: at the overview's height it ends level with the left
    // card, and its body scrolls rather than growing past it.
    h(
      Section,
      {
        title: '解析质量与溯源',
        style: { flex: '1 1 auto', minHeight: 0 },
        bodyStyle: { maxHeight: 'none', flex: '1 1 auto', minHeight: 0 },
        scroll: true,
        meta: h('span', { style: { ...MUTED, fontSize: '11px' } }, provenanceCollapsed(report.graphQuality ?? null)),
      },
      h(ProvenanceBlock, {
        quality: report.graphQuality ?? null,
        provenance: report.provenance ?? null,
        compatibility: report.compatibility ?? null,
      }),
    ),

      )
    ),

    // The 3D view sits above the 2D fallback, and only once there is an index: the
    // whole point of starting a server is to show this repository's graph, and doing so
    // for a directory that has never been analysed would embed a view of some other
    // project. The card decides that itself — this is only the visibility gate.
    projectPath === null || !indexed
      ? null
      : h(
          'div',
          { style: { gridColumn: '1 / -1', minWidth: 0 } },
          h(WebViewSection, { projectPath }),
        ),

    // The graph is the index's own shape, not a derived statistic: it belongs directly
    // under the overview, before the caveats that explain its omissions.
    graph === undefined || !indexed
      ? null
      : h(
          'div',
          { ref: graphCardRef, style: { gridColumn: '1 / -1', minWidth: 0 } },
          h(
            Section,
            {
              wide: true,
              title: '图视图',
              meta: h(
                'span',
                { style: { ...MUTED, fontSize: '11px' } },
                graph.projection === null
                  ? graph.routeState === 'missing'
                    ? '宿主未挂载图路由'
                    : graph.loading
                      ? '读取中…'
                      : graphVisible
                        ? '暂无图数据'
                        : '滚动到此处加载'
                  : `${graph.projection.view === 'communities' ? '社区聚合' : '单个社区'} · ` +
                    `上限 ${graph.projection.budget.nodes} 节点 / ${graph.projection.budget.edges} 边`,
              ),
            },
            h(GraphSection, { state: graph }),
          ),
        ),

    // Caveats, in one card, sharing a row with the provenance card.
    //
    // `notable` and `contextWarnings` were two cards — one amber, one an untitled
    // list of `·` lines. They are the same thing at two volumes: both say "this
    // index does not line up with the working tree". Splitting them made the reader
    // check two boxes to answer one question, and the untitled one had no heading
    // to say what it was.
    notable.length > 0 || contextWarnings.length > 0
      ? h(
          Section,
          {
            // Full width: a list of warnings would otherwise pair with whatever card
            // happened to follow and leave a hole in the other column.
            wide: true,
            title: `需要注意 · ${notable.length + contextWarnings.length}`,
            scroll: 300,
          },
          notable.map((warning, index) =>
            h(
              'div',
              {
                key: `${warning.code}-${index}`,
                style: {
                  display: 'flex',
                  gap: '7px',
                  alignItems: 'flex-start',
                  padding: '6px 8px',
                  border: '1px solid color-mix(in srgb, #d9a441 45%, transparent)',
                  background: 'color-mix(in srgb, #d9a441 9%, transparent)',
                  borderRadius: '6px',
                },
              },
              h(StateDot, { state: 'warning' }),
              h('span', { style: { minWidth: 0 } }, warning.message),
            ),
          ),
          // The milder ones stay quiet rows: giving every item an amber box would
          // make a stale-index count look as urgent as a truncated activity window.
          contextWarnings.length === 0
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    ...MUTED,
                    ...(notable.length > 0 ? { borderTop: HAIRLINE, paddingTop: '8px' } : {}),
                  },
                },
                contextWarnings.map((warning, index) =>
                  h('div', { key: `${warning.code}-${index}` }, `· ${warning.message}`),
                ),
              ),
        )
      : null,

    // Wide: file paths must keep their tails.
    largeFiles.length > 0
      ? h(
          Section,
          {
            wide: true,
            title: `被跳过的超大文件 · ${largeFiles.length} 个 · ${fileSize(totals.largeBytes)}`,
            // A list of up to 40 paths would push every card below it off screen; the
            // platform's own panels cap long lists and scroll inside the card.
            scroll: 280,
          },
          h(LargeFileList, { files: largeFiles.slice(0, 40) }),
          largeFiles.length > 40
            ? h('div', { style: { ...MUTED, marginTop: '6px' } }, `…另有 ${largeFiles.length - 40} 个未显示`)
            : null,
        )
      : null,

    report.activity === undefined || report.activity === null
      ? null
      : h(
          Section,
          {
            wide: true,
            // The header names the window the reader is actually looking at (the
            // timeline's 7-day default), not the 90-day fetch window — the two used to
            // disagree, so the card read "近 90 天" above a list of seven days.
            title: `Git 活动 · 近 ${activityDays} 天`,
            meta: h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', ...MUTED, fontSize: '11px' } },
              // The range control belongs to the card, not to the folded timeline: it
              // scopes every number on the card, and it should be reachable without
              // opening the list.
              h(
                'select',
                {
                  value: String(activityDays),
                  'aria-label': 'Git 活动窗口',
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                    setActivityDays(Number(event.target.value)),
                  style: {
                    font: 'inherit',
                    fontSize: '11px',
                    padding: '1px 4px',
                    border: HAIRLINE,
                    borderRadius: '4px',
                    background: SOFT_BG,
                    color: 'inherit',
                  },
                },
                [7, 14, 30].map((days) => h('option', { key: days, value: String(days) }, `${days} 天`)),
              ),
              h(StateDot, {
                state:
                  activityView(report.activity)?.verdicts.find((v) => v.key === 'missing')?.tone ?? 'done',
              }),
              activityCollapsed(report.activity),
            ),
            // Timeline + cross-tab + baseline is the longest card in the panel.
            scroll: 560,
          },
          h(MemoizedGitActivitySection, {
            activity: report.activity,
            projectPath,
            days: activityDays,
            onDaysChange: setActivityDays,
          }),
        ),

    // Wide, and always open: the commands are the action this panel offers.
    maintenanceSection !== null
      ? h(
          Section,
          {
            wide: true,
            title: '维护命令',
            meta: h(
              'span',
              { style: { ...MUTED, fontSize: '12px' } },
              `${maintenanceSection.commands?.length ?? 0} 条 · ` +
                (maintenanceSection.supportsForce === true
                  ? '均可直接执行，也可复制到会话'
                  : '重启 DSH 后可执行；当前仅可复制') +
                '（沙箱与提权由 DSH 处理）',
            ),
            scroll: 360,
          },
          h(MaintenanceSection, { maintenance: maintenanceSection, projectPath, indexed, run, runError, delta, deltaError, deltaRoute, onStartRun, onCancelRun }),
        )
      : null,
  );
}
