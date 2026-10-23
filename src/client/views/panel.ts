import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { contextDiagnostic, fileResourceAddress, openResource, openResourceIn, routeUrl, useProjectPath } from '../navigation';
import { h } from '../primitives';
import { type MaintenanceStartMode } from '../sections/maintenance';
import { ClientAnalyzeRun, ClientDelta, ClientGraphNode, ClientGraphProjection, ClientInstallRun, ClientMaintenance, ClientProject, ClientProjectList, ClientReport, ClientSearchHit, SlotProps } from '../types';
import { CoverageView } from './coverage-view';
import type { LoadingProgress, StreamReportPayload } from './coverage-view';

export { CoverageView, LoadingBar } from './coverage-view';
export type { CoverageViewProps, LoadingProgress, StreamReportPayload } from './coverage-view';

/**
 * Pick the project a workspace opens on.
 *
 * An explicit remembered choice wins while it still exists. Otherwise an indexed
 * project is preferred over an unindexed git repository, and the workspace's own index
 * wins over a descendant. A workspace with no indexes opens on the workspace itself —
 * the scan-only state, with the unindexed git projects available in the switcher.
 */
export function chooseProject(
  projects: ClientProject[],
  workspace: string,
  remembered: string | null,
): string {
  if (remembered !== null) {
    const hit = projects.find((project) => project.path === remembered);
    if (hit !== undefined) return hit.path;
  }
  const selfIndex = projects.find(
    (project) => project.direction === 'self' && project.kind === 'index',
  );
  if (selfIndex !== undefined) return selfIndex.path;
  const indexed = projects.find((project) => project.kind === 'index');
  if (indexed !== undefined) return indexed.path;
  const self = projects.find((project) => project.direction === 'self');
  if (self !== undefined) return self.path;
  return projects[0]?.path ?? workspace;
}

const ACTIVE_PROJECT_KEY = 'dsh-gitnexus-plus:active-project:';

function readRememberedProject(workspace: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(`${ACTIVE_PROJECT_KEY}${workspace}`);
  } catch {
    return null;
  }
}

function rememberProject(workspace: string, project: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${ACTIVE_PROJECT_KEY}${workspace}`, project);
  } catch {
    /* storage may be unavailable in a hardened webview; selection stays in memory */
  }
}

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
function sameRun(a: ClientAnalyzeRun | null, b: ClientAnalyzeRun | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.state === b.state &&
    a.exitCode === b.exitCode &&
    a.message === b.message &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.output === b.output
  );
}

function sameInstallRun(a: ClientInstallRun | null, b: ClientInstallRun | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.state === b.state &&
    a.exitCode === b.exitCode &&
    a.message === b.message &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.output === b.output
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
  // The path the operator opened. It is the search root for the project list; the
  // active project may be the workspace itself or one of its descendants.
  const workspacePath = useProjectPath(props);
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
  const [rawReport, setRawReport] = React.useState<ClientReport | null>(null);
  const [rawMaintenance, setRawMaintenance] = React.useState<ClientMaintenance | null>(null);
  const [rawError, setRawError] = React.useState<string | null>(null);
  /** The project the current report belongs to. */
  const [reportProject, setReportProject] = React.useState<string | null>(null);
  const [projectList, setProjectList] = React.useState<ClientProjectList | null>(null);
  /** The workspace `projectList` was resolved for. Guards against a workspace switch. */
  const [projectListFor, setProjectListFor] = React.useState<string | null>(null);
  const [activeProject, setActiveProject] = React.useState<string | null>(null);
  const [projectsError, setProjectsError] = React.useState<string | null>(null);
  const [resolving, setResolving] = React.useState(false);
  /**
   * Bumped after the project list resolves, so the coverage effect waits for it.
   * Without this, a manual refresh would read coverage for the old active project
   * while the resolve was still deciding whether that project still exists.
   */
  const [loadToken, setLoadToken] = React.useState(0);
  const projectsReady = projectListFor === workspacePath;
  const visibleProjects = projectsReady ? projectList?.projects ?? [] : undefined;
  const projectPath = activeProject ?? workspacePath;
  const reportVisible = reportProject === projectPath;
  const report = reportVisible ? rawReport : null;
  const maintenance = reportVisible ? rawMaintenance : null;
  const error = reportVisible ? rawError : null;
  /** The graph is only meaningful for an index; a scan-only project has no projection. */
  const graphAvailable = report?.repo?.indexed === true;
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
  const [searchContentSearch, setSearchContentSearch] = React.useState(false);
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
  /** Which project the run status belongs to; a switch must not show it elsewhere. */
  const [runProject, setRunProject] = React.useState<string | null>(null);
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
  /** Which project the current gate reading belongs to, so a switch can clear it. */
  const deltaRepoRef = React.useRef<string | null>(null);
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
  const [graphMode, setGraphMode] = React.useState<'communities' | 'symbols'>('communities');
  const [graphReload, setGraphReload] = React.useState(0);
  /** Set once the graph card has entered the viewport; keeps the first fetch lazy. */
  const [graphVisible, setGraphVisible] = React.useState(false);
  const onGraphNear = React.useCallback(() => setGraphVisible(true), []);
  /** Which project the current projection belongs to, so a switch can clear it. */
  const graphRepoRef = React.useRef<string | null>(null);
  const running = run?.state === 'running' && runProject === projectPath;

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
        // Polls fire every second; only a changed verdict should re-render the report.
        setRun((previous) => (sameRun(previous, next) ? previous : next));
        setRunProject(projectPath);
        // A finished run changed the index, so the report on screen is now a reading of
        // the previous one. This is the whole reason the run was started.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing; the next one reports the state */
      }
    };
    const id = setInterval(() => {
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
    setRunProject(projectPath);
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
      setRunProject(projectPath);
    } catch (cause) {
      setRunError(String((cause as Error)?.message ?? cause));
    }
  }, [projectPath]);

  const cancelRun = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    setRunProject(projectPath);
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
      setSearchContentSearch(body.contentSearch === true);
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
    setSearchContentSearch(false);
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
        setInstallRun((previous) => (sameInstallRun(previous, next) ? previous : next));
        // A finished install changes what this machine can do, so re-read the report:
        // the toolchain verdict is computed per read, so this is what clears the notice.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing */
      }
    };
    const id = setInterval(() => {
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
    if (workspacePath === null) return undefined;
    const controller = new AbortController();
    setResolving(true);
    setProjectsError(null);
    // A workspace switch must not leave the previous project's report on screen. A
    // refresh of the same workspace keeps it readable while the list is re-read.
    if (projectListFor !== workspacePath) {
      setRawReport(null);
      setRawMaintenance(null);
      setRawError(null);
      setReadAt(null);
      setReportProject(null);
      setActiveProject(null);
    }
    void (async () => {
      try {
        const res = await fetch(
          routeUrl(`/api/gitnexus/projects?root=${encodeURIComponent(workspacePath)}`),
          { signal: controller.signal },
        );
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          projects?: ClientProject[];
          visited?: number;
          truncated?: boolean;
          message?: string;
        } | null;
        if (!res.ok || body?.ok !== true || !Array.isArray(body.projects)) {
          throw new Error(body?.message ?? `读取项目列表失败 (${res.status})`);
        }
        if (controller.signal.aborted) return;
        const list: ClientProjectList = {
          root: workspacePath,
          projects: body.projects,
          visited: typeof body.visited === 'number' ? body.visited : 0,
          truncated: body.truncated === true,
        };
        setProjectList(list);
        setProjectListFor(workspacePath);
        const remembered = readRememberedProject(workspacePath);
        const next = chooseProject(list.projects, workspacePath, remembered);
        setActiveProject(next);
        if (remembered !== null && next !== remembered && list.truncated !== true) {
          // The remembered project disappeared; persist the fallback so the next open
          // does not look for it again. A truncated walk never proves it disappeared:
          // it may simply not have reached it before the bound, so keep the preference
          // and let a later complete resolve restore it.
          rememberProject(workspacePath, next);
        }
        setLoadToken((n) => n + 1);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setProjectsError(String((cause as Error)?.message ?? cause));
        // First load: fall back to scanning the workspace. A refresh keeps the list
        // already on screen; a transient resolve failure should not remove it.
        if (projectListFor !== workspacePath) {
          setProjectList({ root: workspacePath, projects: [], visited: 0, truncated: false });
          setProjectListFor(workspacePath);
          setActiveProject(workspacePath);
        }
        setLoadToken((n) => n + 1);
      } finally {
        if (!controller.signal.aborted) setResolving(false);
      }
    })();
    return () => controller.abort();
  }, [workspacePath, reloadToken]);

  React.useEffect(() => {
    if (activeProject === null || workspacePath === null) return undefined;
    // Wait until the resolve has produced the list for this workspace. A manual
    // refresh bumps loadToken after the resolve, so coverage never reads the old
    // active project while the list is still being decided.
    if (projectListFor !== workspacePath || resolving) return undefined;
    const controller = new AbortController();
    // A project switch must not leave the previous report, maintenance payload or
    // read time under the new path. A refresh of the same project keeps them readable
    // while the new reading is fetched.
    if (reportProject !== activeProject) {
      setRawReport(null);
      setRawMaintenance(null);
      setRawError(null);
      setReadAt(null);
    }
    setBusy(true);
    setRawError(null);
    setReportProject(activeProject);
    setProgress({ percent: 0, label: '连接索引服务…' });
    const query =
      `/api/gitnexus/coverage?repo=${encodeURIComponent(activeProject)}` +
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
          setRawReport(payload.report);
          setRawMaintenance(payload.maintenance ?? null);
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
          setRawReport({ repo: { indexed: false, path: activeProject } });
          setRawMaintenance(null);
          setReadAt(body?.readAt ?? new Date().toISOString());
          return;
        }
        if (!body?.ok || body.report === undefined) {
          throw new Error(body?.message ?? `请求失败 (${res.status})`);
        }
        setRawReport(body.report);
        setRawMaintenance(body.maintenance ?? null);
        setReadAt(typeof body.readAt === 'string' ? body.readAt : new Date().toISOString());
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = cause as { name?: string; message?: string };
        if (error?.name === 'AbortError') return;
        setRawError(String(error?.message ?? cause));
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          setProgress(null);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [activeProject, projectListFor, workspacePath, loadToken, resolving]);

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
    // A gate read for the previous project must not be shown under the new one. A
    // refresh of the same project keeps the readable verdict while it is re-read.
    if (deltaRepoRef.current !== projectPath) {
      deltaRepoRef.current = projectPath;
      setDelta(null);
      setDeltaError(null);
      setDeltaRoute('unknown');
    }
    if (projectPath === null) {
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
      graphRepoRef.current = null;
      setGraphProjection(null);
      setGraphError(null);
      setGraphLoading(false);
      setGraphScope(null);
      setGraphMode('communities');
      return undefined;
    }
    const projectChanged = graphRepoRef.current !== projectPath;
    if (projectChanged) {
      graphRepoRef.current = projectPath;
      setGraphProjection(null);
      setGraphError(null);
      // The previous scope is another repository's community. Clearing it makes the
      // next render fetch the overview instead of asking the new project for an id it
      // cannot have.
      setGraphScope(null);
      setGraphMode('communities');
    }
    if (!graphAvailable) {
      setGraphProjection(null);
      setGraphError(null);
      setGraphLoading(false);
      return undefined;
    }
    // The visibility effect flips this once the card is near the viewport; until
    // then the card keeps its empty state instead of issuing a request.
    if (!graphVisible) return undefined;
    if (projectChanged && graphScope !== null) {
      // The setGraphScope(null) above re-runs this effect; do not also fire a request
      // for the old scope against the new project.
      return undefined;
    }
    const controller = new AbortController();
    setGraphLoading(true);
    setGraphError(null);
    const effectiveScope = projectChanged ? null : graphScope;
    const view = effectiveScope === null ? graphMode : 'community';
    const suffix = effectiveScope === null ? '' : `&id=${encodeURIComponent(effectiveScope)}`;
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
  }, [projectPath, reloadToken, graphScope, graphMode, graphReload, graphAvailable, graphVisible]);

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

  const selectProject = React.useCallback(
    (path: string): void => {
      if (workspacePath === null) return;
      setActiveProject(path);
      setProjectsError(null);
      rememberProject(workspacePath, path);
    },
    [workspacePath],
  );

  const visibleRun = runProject === projectPath ? run : null;
  const visibleRunError = runProject === projectPath ? runError : null;

  return h(CoverageView, {
    report,
    maintenance,
    projectPath,
    workspacePath,
    projects: visibleProjects,
    projectsVisited: projectsReady ? projectList?.visited ?? 0 : undefined,
    projectsTruncated: projectsReady ? projectList?.truncated === true : undefined,
    projectsError: projectsReady ? projectsError : null,
    onSelectProject: selectProject,
    context: workspacePath === null ? contextDiagnostic(props) : null,
    busy: busy || resolving,
    progress: resolving ? { percent: 0, label: '正在查找项目索引…' } : progress,
    error,
    readAt,
    run: visibleRun,
    runError: visibleRunError,
    delta,
    deltaError,
    deltaRoute,
    // `tick` is read here rather than inside the card, so elapsed seconds re-render
    // even when the host reports nothing new — a run with no output for a minute
    // otherwise looks frozen.
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
      contentSearch: searchContentSearch,
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
      onOpenCommunity: (id: string) => {
        setGraphScope(id);
        setGraphMode('communities');
      },
      onOpenSymbols: () => {
        setGraphScope(null);
        setGraphMode('symbols');
      },
      onBack: () => {
        setGraphScope(null);
        setGraphMode('communities');
      },
      onReload: () => setGraphReload((n) => n + 1),
      onOpenSymbol: openGraphNode,
    },
    onGraphNear,
    graphVisible,
  });
}

/** The tab chip's live title. */
export function CoverageTitle() {
  return h('span', null, 'GitNexus');
}
