// The GitNexus CLI install: its own run state, its poll, and the one chain that
// follows a successful install with an index build.
//
// Split out of `CoveragePanel` because it is not tied to a repository: the install
// target is one directory per machine, and the operator may have several projects open
// across a session. The panel only supplies the project to chain into and a way to ask
// for a re-read.
import * as React from 'react';
import { routeUrl } from '../navigation';
import { type MaintenanceStartMode } from '../sections/maintenance';
import { ClientInstallRun, ClientReport } from '../types';

/** Poll ticks of one run must not re-render the panel: compare the parts that matter. */
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

export interface GitnexusInstallOptions {
  /** The project an install may chain into an index build for. */
  projectPath: string | null;
  /** The report on screen; a successful install only chains when it is still unindexed. */
  report: ClientReport | null;
  /** Starts an index build for `projectPath`. */
  startRun: (mode?: MaintenanceStartMode) => Promise<void>;
  /** Called when a run finished, so the panel re-reads what it just changed. */
  onChanged: () => void;
}

export interface GitnexusInstallState {
  run: ClientInstallRun | null;
  error: string | null;
  installing: boolean;
  start: () => void;
  cancel: () => void;
}

export function useGitnexusInstall(options: GitnexusInstallOptions): GitnexusInstallState {
  const { projectPath, report, startRun, onChanged } = options;
  const [run, setRun] = React.useState<ClientInstallRun | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const installing = run?.state === 'running';
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
        setRun((previous) => (sameInstallRun(previous, next) ? previous : next));
        // A finished install changes what this machine can do, so re-read the report:
        // the toolchain verdict is computed per read, so this is what clears the notice.
        if (next !== null && next.state !== 'running') onChanged();
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
  }, [installing, onChanged]);

  const start = React.useCallback(async (): Promise<void> => {
    setError(null);
    autoInitArmed.current = true;
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${res.status})`);
      setRun(body.run ?? null);
    } catch (cause) {
      autoInitArmed.current = false;
      setError(String((cause as Error)?.message ?? cause));
    }
  }, []);

  const cancel = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'DELETE' });
      const body = await res.json().catch(() => null);
      if (body?.ok) setRun(body.run ?? null);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
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
    if (run?.state !== 'done') return;
    // Wait for a report rather than treating "not loaded" as "not indexed".
    if (report === null || projectPath === null || report.repo?.indexed === true) return;
    const key = `${projectPath}:${run.startedAt}`;
    if (autoInitDone.current === key) return;
    autoInitDone.current = key;
    autoInitArmed.current = false;
    void startRun('refresh');
  }, [run, projectPath, report, startRun]);

  return {
    run,
    error,
    installing,
    start: () => void start(),
    cancel: () => void cancel(),
  };
}
