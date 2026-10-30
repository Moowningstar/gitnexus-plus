import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { contextDiagnostic, fileResourceAddress, openResource, openResourceIn, routeUrl, useProjectPath } from '../navigation';
import { h } from '../primitives';
import { type MaintenanceStartMode } from '../sections/maintenance';
import { ClientAnalyzeRun, ClientDelta, ClientGraphNode, ClientGraphProjection, ClientMaintenance, ClientProject, ClientProjectList, ClientReport, ClientRisk, SlotProps } from '../types';
import { CoverageView } from './coverage-view';
import { useGitnexusInstall } from './panel-install';
import { useKeywordSearch } from './panel-search';
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
  /**
   * The activity card's window selector, held here rather than in the view: the
   * coverage request is what reads that window, and when the view owned the number the
   * card printed "近 7 天" above a ninety-day report.
   */
  const [activityDays, setActivityDays] = React.useState(7);
  /** The top-bar branch switch: a real `git checkout`, then a full reload. */
  const [branchBusy, setBranchBusy] = React.useState(false);
  const [branchError, setBranchError] = React.useState<string | null>(null);
  // Only a manual refresh bypasses the host's cache; the initial load does not.
  const wantsFresh = reloadToken > 0;

  const switchBranch = React.useCallback(
    async (branch: string): Promise<void> => {
      if (projectPath === null) return;
      setBranchBusy(true);
      setBranchError(null);
      try {
        const res = await fetch(routeUrl(`/api/gitnexus/checkout?repo=${encodeURIComponent(projectPath)}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ branch }),
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        // A 404 from an unmounted route is the old host, not a branch that vanished.
        if (res.status === 404) {
          setBranchError('当前宿主没有切换分支的路由；重启 DSH 后再试。');
          return;
        }
        if (!body?.ok) {
          // git's refusal (usually a dirty tree) is the message a human needs; 409 is
          // the route's "well-formed, working tree said no".
          setBranchError(typeof body?.message === 'string' ? body.message : `切换分支失败 (${res.status})`);
          return;
        }
        // The index still describes the old branch; the reloaded report says so. Rebuild
        // stays a separate, explicit action — a switch must not start a long analyze.
        setReloadToken((n) => n + 1);
      } catch (cause) {
        setBranchError(String((cause as Error)?.message ?? cause));
      } finally {
        setBranchBusy(false);
      }
    },
    [projectPath],
  );

  const search = useKeywordSearch({ projectPath, sessionId });

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
   * The host's own sentence about the gate, shown on the graph card.
   *
   * Read from the delta response rather than rebuilt here: the wording depends on the
   * verdict (`stale` and `unknown` must not read alike), and a client-side copy of that
   * rule is a second implementation that drifts the first time the engine adds a tier.
   */
  const [deltaNotice, setDeltaNotice] = React.useState<string | null>(null);
  /**
   * Whether the host serves `/api/gitnexus/delta`.
   *
   * A 404 here used to be silently swallowed, so an operator on an older host saw no
   * gate and no explanation. Same lesson as the graph card: absent is a state to name.
   */
  const [deltaRoute, setDeltaRoute] = React.useState<'unknown' | 'ready' | 'missing'>('unknown');
  /** Which project the current gate reading belongs to, so a switch can clear it. */
  const deltaRepoRef = React.useRef<string | null>(null);
  /**
   * The resident tracker's verdict about the current change set.
   *
   * Read on an interval rather than only on load: the tracker itself notices file and commit
   * movement, and the whole point of the card is that it updates without a button. The poll is
   * cheap by construction — the route answers from the tracker's snapshot and never starts a
   * query on its own.
   */
  const [risk, setRisk] = React.useState<ClientRisk | null>(null);
  const [riskError, setRiskError] = React.useState<string | null>(null);
  /**
   * Whether the host serves `/api/gitnexus/risk`.
   *
   * Same lesson as the delta and graph routes: a 404 from an older host is a state to name,
   * not a fetch error to swallow.
   */
  const [riskRoute, setRiskRoute] = React.useState<'unknown' | 'ready' | 'missing'>('unknown');
  /** Which project the current risk reading belongs to, so a switch can clear it. */
  const riskRepoRef = React.useRef<string | null>(null);
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
  // `anchoring` keeps the poll alive past `done`: the host asks git about the index's
  // commit baseline after the run finishes, and that answer is a separate status. An
  // older host never sets the flag, so nothing is waited for that will not arrive.
  const running =
    (run?.state === 'running' || run?.anchoring === true) && runProject === projectPath;

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
        // the previous one. This is the whole reason the run was started. Deferred while
        // the baseline is still being written, so the reload sees the final status.
        if (next !== null && next.state !== 'running' && next.anchoring !== true) {
          setReloadToken((n) => n + 1);
        }
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


  const install = useGitnexusInstall({
    projectPath,
    report,
    startRun,
    onChanged: () => setReloadToken((n) => n + 1),
  });

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
      `&days=${activityDays}` +
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
  }, [activeProject, projectListFor, workspacePath, loadToken, resolving, activityDays]);

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
      setDeltaNotice(null);
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
            setDeltaNotice(null);
            setDeltaRoute('missing');
          }
          return;
        }
        setDeltaRoute('ready');
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; delta?: ClientDelta; notice?: string | null; message?: string }
          | null;
        if (controller.signal.aborted) return;
        if (!body?.ok || body.delta === undefined) {
          setDelta(null);
          setDeltaNotice(null);
          setDeltaError(typeof body?.message === 'string' ? body.message : `差量检查失败 (${res.status})`);
          return;
        }
        setDelta(body.delta);
        // `null` is the normal case for a fresh index: silence is the signal, and the
        // graph card then renders without a banner at all.
        setDeltaNotice(typeof body.notice === 'string' ? body.notice : null);
        setDeltaError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setDelta(null);
        setDeltaNotice(null);
        setDeltaError(String((cause as Error)?.message ?? cause));
      }
    })();
    return () => controller.abort();
  }, [projectPath, reloadToken]);

  /**
   * Poll the tracker's verdict.
   *
   * Four seconds: the tracker's own debounce is 800 ms and its minimum gap 5 s, so a faster
   * poll would only re-read the same version. The interval stops for good on a 404 — an older
   * host is not going to grow the route while the panel is open, and a request every four
   * seconds to be told that is noise in someone's log.
   */
  React.useEffect(() => {
    if (projectPath === null) return undefined;
    if (riskRoute === 'missing') return undefined;
    if (riskRepoRef.current !== projectPath) {
      riskRepoRef.current = projectPath;
      setRisk(null);
      setRiskError(null);
    }
    const controller = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl(`/api/gitnexus/risk?repo=${encodeURIComponent(projectPath)}`), {
          signal: controller.signal,
        });
        if (res.status === 404) {
          if (!controller.signal.aborted) {
            setRisk(null);
            setRiskError(null);
            setRiskRoute('missing');
          }
          return;
        }
        setRiskRoute('ready');
        const body = (await res.json().catch(() => null)) as
          | ({ ok?: boolean; message?: string } & Partial<ClientRisk>)
          | null;
        if (controller.signal.aborted) return;
        if (!body?.ok || body.version === undefined) {
          setRiskError(typeof body?.message === 'string' ? body.message : `改动追踪读取失败 (${res.status})`);
          return;
        }
        const next: ClientRisk = {
          risk: body.risk ?? null,
          text: body.text ?? null,
          line: body.line ?? null,
          watching: body.watching === true,
          live: body.live === true,
          degraded: body.degraded ?? null,
          busy: body.busy === true,
          delta: body.delta ?? null,
          version: body.version,
        };
        // The route answers every four seconds; only a moved version, a moved sentence or a
        // change in the busy flag is worth a re-render.
        setRisk((previous) =>
          previous !== null && previous.version === next.version && previous.line === next.line && previous.busy === next.busy
            ? previous
            : next,
        );
        setRiskError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setRiskError(String((cause as Error)?.message ?? cause));
      }
    };
    void read();
    const id = setInterval(() => {
      void read();
    }, 4000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [projectPath, riskRoute]);

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
      setBranchError(null);
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
    activityDays,
    onActivityDaysChange: setActivityDays,
    branches: (report?.activity?.branches ?? []).map((branch) => ({
      name: branch.name,
      current: branch.current === true,
    })),
    currentBranch: report?.activity?.currentBranch ?? null,
    branchBusy,
    branchError,
    onSwitchBranch: (branch: string) => void switchBranch(branch),
    run: visibleRun,
    runError: visibleRunError,
    delta,
    deltaError,
    deltaRoute,
    risk,
    riskError,
    riskRoute,
    // `tick` is read here rather than inside the card, so elapsed seconds re-render
    // even when the host reports nothing new — a run with no output for a minute
    // otherwise looks frozen.
    onRefresh: () => setReloadToken((n) => n + 1),
    onStartRun: (mode?: MaintenanceStartMode) => void startRun(mode),
    onCancelRun: () => void cancelRun(),
    installRun: install.run,
    installError: install.error,
    onInstall: install.start,
    onCancelInstall: install.cancel,
    search,
    graph: {
      projection: graphProjection,
      loading: graphLoading,
      error: graphError,
      routeState: graphRoute,
      scope: graphScope,
      staleNotice: deltaNotice,
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
