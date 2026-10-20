import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import {
  ZERO_ANALYZER,
  ZERO_CAP,
  ZERO_TOTALS,
  capSourceLabel,
  compactNumber,
  coverageRatio,
  fileSize,
  fixed,
  healthState,
  splitWarnings,
  stalenessView,
  summaryLine,
} from '../format';
import {
  contextDiagnostic,
  fileResourceAddress,
  openResource,
  openResourceIn,
  routeUrl,
  useProjectPath,
} from '../navigation';
import {
  Button,
  HAIRLINE,
  IconRefreshOutlineRegular,
  MUTED,
  MetricGrid,
  PathLabel,
  Ring,
  Row,
  Section,
  StateDot,
  h,
  styles,
} from '../primitives';
import { GitActivitySection, activityCollapsed, activityView } from '../sections/activity';
import { CapabilityStrip, ProvenanceBlock, provenanceCollapsed } from '../sections/capabilities';
import { ToolchainNotice } from '../sections/install';
import { LanguageSection } from '../sections/languages';
import { LargeFileList } from '../sections/large-files';
import { MaintenanceSection, type MaintenanceStartMode } from '../sections/maintenance';
import { SearchSection } from '../sections/search';
import { GraphSection } from '../sections/graph';
import {
  ClientAnalyzeRun,
  ClientDelta,
  ClientGraphNode,
  ClientGraphProjection,
  ClientInstallRun,
  ClientMaintenance,
  ClientReport,
  ClientSearchHit,
  ContextDiagnostic,
  GraphViewState,
  SearchViewState,
  SlotProps,
} from '../types';

/**
 * The panel body registered into `sidebar.right.pane.tab`.
 *
 * Split in two on purpose. `CoveragePanel` owns fetching and state;
 * `CoverageView` is a pure function of its props. The split is what makes the
 * populated view testable at all: a component that fetches cannot be rendered
 * against a fixture, and the states worth asserting on — a report with skipped
 * files, one without, an error, missing language data — are exactly the ones a
 * fixture supplies.
 *
 * @param {{
 *   report: any,
 *   repos: any[],
 *   repo: string | null,
 *   busy: boolean,
 *   error: string | null,
 *   onSelect: (path: string) => void,
 *   onRefresh: () => void,
 * }} props
 */
export interface CoverageViewProps {
  report: ClientReport | null;
  maintenance: ClientMaintenance | null | undefined;
  projectPath: string | null;
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
  /** Advances once a second while a run is in flight, so elapsed time moves. */
  now: number;
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
  now,
  onRefresh,
  onStartRun,
  onCancelRun,
  installRun,
  installError,
  onInstall,
  onCancelInstall,
  search,
  graph,
}: CoverageViewProps) {
  // Whether an index exists decides which maintenance command is applicable. When
  // the project could not even be identified there is nothing to claim, so it is
  // false rather than assumed.
  const indexed = report?.repo?.indexed === true;
  const header = h(
    Row,
    null,
    report !== null && report.repo?.indexed ? h(StateDot, { state: healthState(report) }) : null,
    h('span', { style: { fontWeight: 600 } }, 'GitNexus 索引'),
    // The project, not a picker. Shown so the reader can confirm which tree the
    // numbers describe — a path is the only unambiguous answer to that.
    projectPath === null
      ? h('span', { style: MUTED }, '未解析到工作区')
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
      maintenance === null || maintenance === undefined
        ? null
        : h(
            Section,
            {
              wide: true,
              title: '维护命令',
              meta: h('span', { style: { ...MUTED, fontSize: '12px' } }, '复制后到会话执行（沙箱与提权由 DSH 处理）'),
              scroll: 320,
            },
            h(MaintenanceSection, { maintenance, projectPath, indexed: false, run, runError, delta, deltaError, deltaRoute, now, onStartRun, onCancelRun }),
          ),
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
        now,
        onInstall,
        onCancelInstall,
      }),
      h(
        'div',
        { style: { gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'idle' }),
        h(
          'span',
          null,
          '该项目还没有 GitNexus 索引。下面是工作区扫描结果；初始化后可看到图谱、查询能力与 Git 活动对账。',
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
      languages !== null && languages.rows.length > 0 ? h(LanguageSection, { languages }) : null,
      maintenance === null || maintenance === undefined
        ? null
        : h(
            Section,
            {
              wide: true,
              title: '初始化索引',
              meta: h(
                'span',
                { style: { ...MUTED, fontSize: '11px' } },
                maintenance.supportsForce === true
                  ? '均可直接执行，也可复制到会话（沙箱与提权由 DSH 处理）'
                  : '重启 DSH 后可执行；当前仅可复制（沙箱与提权由 DSH 处理）',
              ),
            },
            h(MaintenanceSection, { maintenance, projectPath, indexed, run, runError, delta, deltaError, deltaRoute, now, onStartRun, onCancelRun }),
          ),
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
      now,
      onInstall,
      onCancelInstall,
    }),

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
    h(
      Section,
      {
        title: '索引概览',
        meta:
          report.graph === null || report.graph === undefined
            ? null
            : h('span', { style: { ...MUTED, fontSize: '11px' } }, `${fixed(report.graph.edgesPerNode, 2)} 边/符号`),
      },
      h(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'flex-start' } },
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
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '9px', minWidth: 0, flex: '1 1 auto' } },
          h('div', { style: MUTED }, summaryLine(report)),

          // Files in, graph out — the two halves sit side by side so the wide card
          // is used rather than merely filled.
          h(
            'div',
            { style: { display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' } },
            h(
              'div',
              { style: { minWidth: '200px', flex: '1 1 auto' } },
              h('div', { style: { ...MUTED, marginBottom: '5px' } }, '文件'),
              h(MetricGrid, {
                items: [
                  { label: '大小上限', value: cap.text, hint: capSourceLabel(cap.source) },
                  { label: '跳过合计', value: fileSize(totals.largeBytes) },
                  { label: '超限文件', value: compactNumber(totals.large) },
                ],
              }),
            ),
            report.graph === null || report.graph === undefined
              ? null
              : h(
                  'div',
                  { style: { minWidth: '240px', flex: '1 1 auto' } },
                  h('div', { style: { ...MUTED, marginBottom: '5px' } }, '图谱'),
                  h(MetricGrid, {
                    items: [
                      { label: '符号', value: compactNumber(report.graph.nodes) },
                      { label: '边', value: compactNumber(report.graph.edges) },
                      { label: '社区', value: compactNumber(report.graph.communities) },
                      { label: '流程', value: compactNumber(report.graph.processes) },
                      { label: '向量', value: compactNumber(report.graph.embeddings) },
                    ],
                  }),
                ),
          ),

          h(
            'div',
            { style: { borderTop: HAIRLINE, paddingTop: '8px' } },
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
      ),
    ),

    // The graph is the index's own shape, not a derived statistic: it belongs directly
    // under the overview, before the caveats that explain its omissions.
    graph === undefined || !indexed
      ? null
      : h(
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
                    : '暂无图数据'
                : `${graph.projection.view === 'communities' ? '社区聚合' : '单个社区'} · ` +
                  `上限 ${graph.projection.budget.nodes} 节点 / ${graph.projection.budget.edges} 边`,
            ),
          },
          h(GraphSection, { state: graph }),
        ),

    // Shares a row with the overview card: a bar plus its legend is a proportional
    // reading, and pairing it with the coverage figure puts the two "how much of
    // this repository" answers side by side. Order matters — it must directly
    // follow the overview for the grid to place them in the same row.
    languages !== null && languages.rows.length > 0 ? h(LanguageSection, { languages }) : null,

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

    // Shares the row above. Resolver confidence is what makes the counts above it
    // lower bounds, so it belongs beside the caveats rather than after the charts.
    h(
      Section,
      {
        title: '解析质量与溯源',
        meta: h('span', { style: { ...MUTED, fontSize: '11px' } }, provenanceCollapsed(report.graphQuality ?? null)),
      },
      h(ProvenanceBlock, {
        quality: report.graphQuality ?? null,
        provenance: report.provenance ?? null,
      }),
    ),

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
            title: `Git 活动 · ${activityView(report.activity)?.window ?? ''}`,
            meta: h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', ...MUTED, fontSize: '11px' } },
              h(StateDot, {
                state:
                  activityView(report.activity)?.verdicts.find((v) => v.key === 'missing')?.tone ?? 'done',
              }),
              activityCollapsed(report.activity),
            ),
            // Timeline + cross-tab + baseline is the longest card in the panel.
            scroll: 560,
          },
          h(GitActivitySection, { activity: report.activity, projectPath }),
        ),

    // Wide, and always open: the commands are the action this panel offers.
    maintenance === null || maintenance === undefined
      ? null
      : h(
          Section,
          {
            wide: true,
            title: '维护命令',
            meta: h(
              'span',
              { style: { ...MUTED, fontSize: '12px' } },
              `${maintenance.commands?.length ?? 0} 条 · ` +
                (maintenance.supportsForce === true
                  ? '均可直接执行，也可复制到会话'
                  : '重启 DSH 后可执行；当前仅可复制') +
                '（沙箱与提权由 DSH 处理）',
            ),
            scroll: 360,
          },
          h(MaintenanceSection, { maintenance, projectPath, indexed, run, runError, delta, deltaError, deltaRoute, now, onStartRun, onCancelRun }),
        ),
  );
}

/**
 * Stateful wrapper: resolves the current project, loads its coverage.
 *
 * No repository list and no picker. The panel answers for the project the operator
 * is in; a project with no index is a normal state that leads with the command to
 * create one, not an error.
 *
 * @param {{params?: {repo?: string}, sessionId?: string, useWorkspaces?: Function}} props
 */
export function CoveragePanel(props: SlotProps) {
  const projectPath = useProjectPath(props);
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
  const [report, setReport] = React.useState<ClientReport | null>(null);
  const [maintenance, setMaintenance] = React.useState<ClientMaintenance | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<LoadingProgress | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  // When the report on screen was read. Without it a refresh of an unchanged
  // repository produces a byte-identical panel, so the control looks inert even
  // when it did precisely what it was asked to do.
  const [readAt, setReadAt] = React.useState<string | null>(null);
  // Only a manual refresh bypasses the host's cache; the initial load does not.
  const wantsFresh = reloadToken > 0;

  // Keyword search. Its own state because it is an on-demand action, not part of
  // the report the panel loads: an idle panel makes no search requests at all.
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<ClientSearchHit[] | null>(null);
  const [searchMode, setSearchMode] = React.useState<'graph' | 'text' | null>(null);
  const [searchTotal, setSearchTotal] = React.useState(0);
  const [searchTruncated, setSearchTruncated] = React.useState(false);
  const [searchWarning, setSearchWarning] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [searchCopied, setSearchCopied] = React.useState<string | null>(null);
  // Monotonic request id: a slower earlier search must not overwrite a newer one.
  const searchSeq = React.useRef(0);

  // The refresh run, and the tick that makes its elapsed time advance. `run` is null
  // until something is started in this host's lifetime — a state the card renders as
  // "not run yet" rather than as a failure.
  const [run, setRun] = React.useState<ClientAnalyzeRun | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  /** The Tier 0 verdict, or null while unknown (no route on this host, or not read yet). */
  const [delta, setDelta] = React.useState<ClientDelta | null>(null);
  const [deltaError, setDeltaError] = React.useState<string | null>(null);
  /**
   * Whether the host serves `/api/gitnexus/delta`.
   *
   * A 404 here used to be silently swallowed, so an operator on an older host saw no
   * gate and no explanation. Same lesson as the graph card: absent is a state to name.
   */
  const [deltaRoute, setDeltaRoute] = React.useState<'unknown' | 'ready' | 'missing'>('unknown');
  /** The bounded graph projection, its scope, and the load state around it. */
  const [graphProjection, setGraphProjection] = React.useState<ClientGraphProjection | null>(null);
  const [graphLoading, setGraphLoading] = React.useState(false);
  const [graphError, setGraphError] = React.useState<string | null>(null);
  /**
   * Whether the host serves `/api/gitnexus/graph`.
   *
   * Kept as state rather than inferred from a null projection: the client can reload
   * ahead of the host, and "the route is not mounted" must read as "restart DSH", not as
   * "still loading".
   */
  const [graphRoute, setGraphRoute] = React.useState<'unknown' | 'ready' | 'missing'>('unknown');
  const [graphScope, setGraphScope] = React.useState<string | null>(null);
  const [graphReload, setGraphReload] = React.useState(0);
  const [tick, setTick] = React.useState(0);
  const running = run?.state === 'running';

  /**
   * Poll while a run is in flight.
   *
   * Deliberately not an always-on interval: a panel left open on an idle project should
   * make no requests at all, and the host keeps one run per repository, so a missed
   * poll costs nothing but a second.
   */
  React.useEffect(() => {
    if (projectPath === null || !running) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}`));
        const body = await res.json().catch(() => null);
        if (cancelled || !body?.ok) return;
        const next: ClientAnalyzeRun | null = body.run ?? null;
        setRun(next);
        // A finished run changed the index, so the report on screen is now a reading of
        // the previous one. This is the whole reason the run was started.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing; the next one reports the state */
      }
    };
    const id = setInterval(() => {
      setTick((n) => n + 1);
      void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectPath, running]);

  const startRun = React.useCallback(async (mode: MaintenanceStartMode = 'refresh'): Promise<void> => {
    if (projectPath === null) return;
    setRunError(null);
    try {
      // One request, three modes. Sending them as flags rather than a body keeps the
      // operation visible in the URL the host logs alongside the command it ran.
      const suffix =
        mode === 'force' ? '&force=1' : mode === 'repair-fts' ? '&mode=repair-fts' : '';
      const res = await fetch(
        routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}${suffix}`),
        { method: 'POST' },
      );
      const body = await res.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${res.status})`);
      setRun(body.run ?? null);
      setTick(0);
    } catch (cause) {
      setRunError(String((cause as Error)?.message ?? cause));
    }
  }, [projectPath]);

  const cancelRun = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    try {
      const res = await fetch(routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}`), {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => null);
      if (body?.ok) setRun(body.run ?? null);
    } catch (cause) {
      setRunError(String((cause as Error)?.message ?? cause));
    }
  }, [projectPath]);

  /**
   * Run one keyword search.
   *
   * No request on mount and no request per keystroke: a graph query is cheap but not
   * free, and the operator's typing is not a search intent until Enter or the button.
   * `searchSeq` makes an older in-flight response a no-op, which is the difference
   * between "the last search wins" and a result list that flickers backwards.
   */
  const runSearch = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    const query = searchQuery.trim();
    if (query === '') {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    setSearchCopied(null);
    try {
      const res = await fetch(
        routeUrl(
          `/api/gitnexus/search?repo=${encodeURIComponent(projectPath)}` +
            `&q=${encodeURIComponent(query)}&limit=20`,
        ),
      );
      const body = await res.json().catch(() => null);
      if (seq !== searchSeq.current) return;
      if (!body?.ok) {
        // A 404 without the route's own code means the host predates the search
        // route, not that the project is wrong: the panel's own project path is a
        // project root by construction.
        if (res.status === 404 && body?.code !== 'not-a-project') {
          throw new Error('当前宿主没有搜索路由；重启 DSH 后再试。');
        }
        throw new Error(
          typeof body?.message === 'string' ? body.message : `请求失败 (${res.status})`,
        );
      }
      const results: ClientSearchHit[] = Array.isArray(body.results)
        ? (body.results as ClientSearchHit[]).filter(
            (hit): hit is ClientSearchHit =>
              hit !== null &&
              typeof hit === 'object' &&
              typeof hit.kind === 'string' &&
              typeof hit.name === 'string' &&
              typeof hit.filePath === 'string',
          )
        : [];
      setSearchResults(results);
      setSearchMode(body.mode === 'text' ? 'text' : body.mode === 'graph' ? 'graph' : null);
      setSearchTotal(typeof body.total === 'number' ? body.total : results.length);
      setSearchTruncated(body.truncated === true);
      setSearchWarning(typeof body.warning === 'string' ? body.warning : null);
    } catch (cause) {
      if (seq !== searchSeq.current) return;
      setSearchResults(null);
      setSearchError(String((cause as Error)?.message ?? cause));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [projectPath, searchQuery]);

  const clearSearch = React.useCallback((): void => {
    searchSeq.current += 1;
    setSearchQuery('');
    setSearchResults(null);
    setSearchMode(null);
    setSearchTotal(0);
    setSearchTruncated(false);
    setSearchWarning(null);
    setSearchError(null);
    setSearching(false);
    setSearchCopied(null);
  }, []);

  const copySearchHit = React.useCallback((hit: ClientSearchHit): void => {
    const text = `${hit.filePath}${hit.startLine !== null ? `:${hit.startLine}` : ''}`;
    const key = `${hit.kind}:${hit.filePath}:${hit.startLine ?? ''}:${hit.name}`;
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (value: string) => navigator.clipboard?.writeText(value);
    try {
      const outcome = write(text);
      if (outcome && typeof outcome.then === 'function') {
        outcome
          .then(() => {
            setSearchCopied(key);
            setTimeout(() => setSearchCopied(null), 1500);
          })
          .catch(() => setSearchCopied(null));
      } else {
        setSearchCopied(key);
        setTimeout(() => setSearchCopied(null), 1500);
      }
    } catch {
      setSearchCopied(null);
    }
  }, []);

  /**
   * Open a hit in the platform's file viewer at its line.
   *
   * The resource address is the same `dsh-resource://file/session/...` the built-in
   * file strip uses; `params.line` is what the chat's file links pass. If the
   * deployment has no right-sidebar controller (a headless profile, or a host older
   * than the service), opening is impossible — copy the `path:line` instead of
   * silently doing nothing, and say why.
   */
  const openSearchHit = React.useCallback(
    (hit: ClientSearchHit): void => {
      setSearchError(null);
      if (sessionId === null) {
        setSearchError('未能定位当前会话，已复制路径。');
        copySearchHit(hit);
        return;
      }
      const address = fileResourceAddress(sessionId, hit.filePath);
      const options =
        hit.startLine === null
          ? undefined
          : { params: { line: hit.startLine } };
      try {
        if (openResourceIn !== null) {
          openResourceIn(sessionId, address, options);
          return;
        }
        if (openResource !== null) {
          openResource(address, options);
          return;
        }
      } catch {
        /* fall through to the copy path */
      }
      setSearchError('当前宿主没有可用的文件打开能力，已复制路径。');
      copySearchHit(hit);
    },
    [sessionId, copySearchHit],
  );

  // A different project means the previous hits are another repository's symbols.
  React.useEffect(() => {
    clearSearch();
  }, [projectPath, clearSearch]);

  // The GitNexus install. Its own state because it is not tied to a repository: the
  // install target is one directory per machine, and the operator may have several
  // projects open across a session.
  const [installRun, setInstallRun] = React.useState<ClientInstallRun | null>(null);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const installing = installRun?.state === 'running';
  // Only an install the operator authorised *in this panel* may chain into an
  // analyze. A successful install from an earlier session is still visible in the
  // host's run state, and starting a write from that would be acting on consent the
  // operator gave for a different action.
  const autoInitArmed = React.useRef(false);
  const autoInitDone = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!installing) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl('/api/gitnexus/install'));
        const body = await res.json().catch(() => null);
        if (cancelled || !body?.ok) return;
        const next: ClientInstallRun | null = body.run ?? null;
        setInstallRun(next);
        // A finished install changes what this machine can do, so re-read the report:
        // the toolchain verdict is computed per read, so this is what clears the notice.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing */
      }
    };
    const id = setInterval(() => {
      setTick((n) => n + 1);
      void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [installing]);

  const startInstall = React.useCallback(async (): Promise<void> => {
    setInstallError(null);
    autoInitArmed.current = true;
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${res.status})`);
      setInstallRun(body.run ?? null);
      setTick(0);
    } catch (cause) {
      autoInitArmed.current = false;
      setInstallError(String((cause as Error)?.message ?? cause));
    }
  }, []);

  const cancelInstall = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'DELETE' });
      const body = await res.json().catch(() => null);
      if (body?.ok) setInstallRun(body.run ?? null);
    } catch (cause) {
      setInstallError(String((cause as Error)?.message ?? cause));
    }
  }, []);

  /**
   * Install → initialize, in one authorised step.
   *
   * The install is machine-wide; the index is per-project. Chaining them is the
   * difference between "you now have a CLI" and "you can see the index", which is
   * what the operator asked for. Three conditions keep it honest: the install must
   * have finished successfully, the project must still have no index (otherwise
   * this would silently refresh an index nobody asked to refresh), and the operator
   * must have started *this* install from this panel.
   *
   * The key includes the install's start time, so a retry after a cancellation is a
   * new run and may chain again, while the poll ticks of one run cannot start two
   * analyses.
   */
  React.useEffect(() => {
    if (!autoInitArmed.current) return;
    if (installRun?.state !== 'done') return;
    // Wait for a report rather than treating "not loaded" as "not indexed".
    if (report === null || projectPath === null || report.repo?.indexed === true) return;
    const key = `${projectPath}:${installRun.startedAt}`;
    if (autoInitDone.current === key) return;
    autoInitDone.current = key;
    autoInitArmed.current = false;
    void startRun('refresh');
  }, [installRun, projectPath, report, startRun]);

  React.useEffect(() => {
    if (projectPath === null) return undefined;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setProgress({ percent: 0, label: '连接索引服务…' });
    const query =
      `/api/gitnexus/coverage?repo=${encodeURIComponent(projectPath)}` +
      (wantsFresh ? '&refresh=1' : '') +
      '&stream=1';

    const load = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl(query), { signal: controller.signal });
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('application/x-ndjson') && res.body !== null) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const reports: StreamReportPayload[] = [];
          let buffer = '';
          const consume = (line: string): void => {
            if (line.trim() === '' || controller.signal.aborted) return;
            let message: Record<string, unknown>;
            try {
              message = JSON.parse(line) as Record<string, unknown>;
            } catch {
              return;
            }
            if (message.type === 'progress') {
              const raw = typeof message.percent === 'number' ? message.percent : 0;
              const percent = Math.max(0, Math.min(100, Math.round(raw)));
              const label = typeof message.label === 'string' ? message.label : '读取索引…';
              setProgress({ percent, label });
              return;
            }
            if (message.type === 'report') {
              reports.push(message as unknown as StreamReportPayload);
              return;
            }
            if (message.type === 'error') {
              throw new Error(
                typeof message.message === 'string' ? message.message : '读取索引失败。',
              );
            }
          };

          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              consume(line);
              newline = buffer.indexOf('\n');
            }
          }
          buffer += decoder.decode();
          if (buffer.trim() !== '') consume(buffer);

          const payload = reports[0];
          if (payload === undefined) throw new Error('读取中断：没有收到完整报告。');
          if (controller.signal.aborted) return;
          setReport(payload.report);
          setMaintenance(payload.maintenance ?? null);
          setReadAt(
            typeof payload.readAt === 'string' ? payload.readAt : new Date().toISOString(),
          );
          return;
        }

        // An older host ignores `stream=1` and answers plain JSON. Drop the numeric
        // channel and let the native progress element go indeterminate rather than
        // leaving a frozen 0%.
        setProgress(null);
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          code?: string;
          message?: string;
          report?: ClientReport;
          maintenance?: ClientMaintenance | null;
          readAt?: string;
        } | null;
        // `not-indexed` is a state the panel renders, not a failure: the whole
        // point of leading with the initialize command is that reaching it is
        // expected on a project that has never been analysed.
        if (res.status === 404 && body?.code === 'not-indexed') {
          setReport({ repo: { indexed: false, path: projectPath } });
          setMaintenance(null);
          setReadAt(body?.readAt ?? new Date().toISOString());
          return;
        }
        if (!body?.ok || body.report === undefined) {
          throw new Error(body?.message ?? `请求失败 (${res.status})`);
        }
        setReport(body.report);
        setMaintenance(body.maintenance ?? null);
        setReadAt(typeof body.readAt === 'string' ? body.readAt : new Date().toISOString());
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = cause as { name?: string; message?: string };
        if (error?.name === 'AbortError') return;
        setError(String(error?.message ?? cause));
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          setProgress(null);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [projectPath, reloadToken]);

  /**
   * Read the Tier 0 verdict whenever the project or the index changes.
   *
   * Deliberately a second effect rather than part of the report load: this route is
   * new, and a host that does not serve it must not make the panel look broken. A 404
   * means "no gate on this deployment", not a failure — the maintenance controls keep
   * their old always-enabled behaviour.
   *
   * `reloadToken` is bumped when a run finishes, which is exactly when the verdict has
   * changed; there is no polling here for the same reason the run poll is conditional.
   */
  React.useEffect(() => {
    if (projectPath === null) {
      setDelta(null);
      setDeltaError(null);
      setDeltaRoute('unknown');
      return undefined;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(routeUrl(`/api/gitnexus/delta?repo=${encodeURIComponent(projectPath)}`), {
          signal: controller.signal,
        });
        if (res.status === 404) {
          if (!controller.signal.aborted) {
            setDelta(null);
            setDeltaError(null);
            setDeltaRoute('missing');
          }
          return;
        }
        setDeltaRoute('ready');
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; delta?: ClientDelta; message?: string }
          | null;
        if (controller.signal.aborted) return;
        if (!body?.ok || body.delta === undefined) {
          setDelta(null);
          setDeltaError(typeof body?.message === 'string' ? body.message : `差量检查失败 (${res.status})`);
          return;
        }
        setDelta(body.delta);
        setDeltaError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setDelta(null);
        setDeltaError(String((cause as Error)?.message ?? cause));
      }
    })();
    return () => controller.abort();
  }, [projectPath, reloadToken]);

  // A different project means the previous drill-down is another repository's
  // community: keeping the scope would ask the new project for an id that cannot exist.
  React.useEffect(() => {
    setGraphScope(null);
  }, [projectPath]);

  /**
   * Read the graph projection for the current scope.
   *
   * Two views, one endpoint: the overview is the default, and a scope switches to the
   * member list. The host applies the budgets, so this never asks for "everything" —
   * there is no such request to make.
   *
   * A 404 means the host predates this route. The card then says so through its own
   * empty state instead of showing a fetch error for a feature that is simply absent.
   */
  React.useEffect(() => {
    if (projectPath === null) {
      setGraphProjection(null);
      setGraphError(null);
      return undefined;
    }
    const controller = new AbortController();
    setGraphLoading(true);
    const view = graphScope === null ? 'communities' : 'community';
    const suffix = graphScope === null ? '' : `&id=${encodeURIComponent(graphScope)}`;
    void (async () => {
      try {
        const res = await fetch(
          routeUrl(`/api/gitnexus/graph?repo=${encodeURIComponent(projectPath)}&view=${view}${suffix}`),
          { signal: controller.signal },
        );
        if (res.status === 404) {
          if (!controller.signal.aborted) {
            setGraphProjection(null);
            setGraphError(null);
            // A 404 from a route that is not mounted is the old-host case, not an empty
            // graph. Saying which one it is is the whole point of this state.
            setGraphRoute('missing');
          }
          return;
        }
        setGraphRoute('ready');
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; projection?: ClientGraphProjection; message?: string }
          | null;
        if (controller.signal.aborted) return;
        if (!body?.ok || body.projection === undefined) {
          setGraphProjection(null);
          setGraphError(typeof body?.message === 'string' ? body.message : `读取图失败 (${res.status})`);
          return;
        }
        setGraphProjection(body.projection);
        setGraphError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setGraphProjection(null);
        setGraphError(String((cause as Error)?.message ?? cause));
      } finally {
        if (!controller.signal.aborted) setGraphLoading(false);
      }
    })();
    return () => controller.abort();
  }, [projectPath, reloadToken, graphScope, graphReload]);

  /**
   * Open a symbol node, with the same fallbacks the search hits use.
   *
   * A graph node carries `path:line` exactly like a search hit, so the behaviour must
   * match: open in the platform viewer when the profile has one, copy the location when
   * it does not. Silently doing nothing on click is the failure this avoids.
   */
  const openGraphNode = React.useCallback(
    (node: ClientGraphNode): void => {
      if (node.filePath === null) return;
      setGraphError(null);
      const address = sessionId === null ? null : fileResourceAddress(sessionId, node.filePath);
      const options = node.startLine === null ? undefined : { params: { line: node.startLine } };
      try {
        if (sessionId !== null && address !== null && openResourceIn !== null) {
          openResourceIn(sessionId, address, options);
          return;
        }
        if (address !== null && openResource !== null) {
          openResource(address, options);
          return;
        }
      } catch {
        /* fall through to copying the location */
      }
      const text = `${node.filePath}${node.startLine === null ? '' : `:${node.startLine}`}`;
      try {
        const write =
          typeof primitives.writeClipboard === 'function'
            ? primitives.writeClipboard
            : (value: string) => navigator.clipboard?.writeText(value);
        void write(text);
        setGraphError(`当前宿主没有可用的文件打开能力，已复制 ${text}`);
      } catch {
        setGraphError(`当前宿主没有可用的文件打开能力；位置：${text}`);
      }
    },
    [sessionId],
  );

  const fallbackMaintenance = React.useMemo(
    () => (maintenance === null && projectPath !== null ? { commands: [], rationale: [] } : maintenance),
    [maintenance, projectPath],
  );

  return h(CoverageView, {
    report,
    maintenance: fallbackMaintenance,
    projectPath,
    context: projectPath === null ? contextDiagnostic(props) : null,
    busy,
    progress,
    error,
    readAt,
    run,
    runError,
    delta,
    deltaError,
    deltaRoute,
    // `tick` is read here rather than inside the card, so elapsed seconds re-render
    // even when the host reports nothing new — a run with no output for a minute
    // otherwise looks frozen.
    now: Date.now() + tick * 0,
    onRefresh: () => setReloadToken((n) => n + 1),
    onStartRun: (mode?: MaintenanceStartMode) => void startRun(mode),
    onCancelRun: () => void cancelRun(),
    installRun,
    installError,
    onInstall: () => void startInstall(),
    onCancelInstall: () => void cancelInstall(),
    search: {
      query: searchQuery,
      onQueryChange: (value: string) => {
        // Invalidate an in-flight search for the previous text: otherwise its
        // response can land after the edit and repopulate a list that no longer
        // matches the box. The sequence bump also makes its `finally` a no-op, so
        // the spinner is cleared here.
        searchSeq.current += 1;
        setSearching(false);
        setSearchQuery(value);
        setSearchError(null);
        setSearchResults(null);
        setSearchMode(null);
      },
      onSubmit: () => void runSearch(),
      onClear: clearSearch,
      searching,
      error: searchError,
      mode: searchMode,
      results: searchResults,
      total: searchTotal,
      truncated: searchTruncated,
      warning: searchWarning,
      copied: searchCopied,
      onOpen: openSearchHit,
      onCopy: copySearchHit,
    },
    graph: {
      projection: graphProjection,
      loading: graphLoading,
      error: graphError,
      routeState: graphRoute,
      scope: graphScope,
      onOpenCommunity: (id: string) => setGraphScope(id),
      onBack: () => setGraphScope(null),
      onReload: () => setGraphReload((n) => n + 1),
      onOpenSymbol: openGraphNode,
    },
  });
}

/** The tab chip's live title. */
export function CoverageTitle() {
  return h('span', null, 'GitNexus');
}
