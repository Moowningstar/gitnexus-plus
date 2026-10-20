import { ContextDiagnostic, OpenResource, OpenResourceIn, SidebarRightApi, SlotProps } from './types';

/** Captured from `ctx.inject(['sidebarRight'])`; null when the profile has no column. */
export let openResource: OpenResource | null = null;
export let openResourceIn: OpenResourceIn | null = null;

/**
 * Build the platform's file resource address.
 *
 * The address is `dsh-resource://file/session/<session>/<path>`, exactly what the
 * built-in file strip and the chat's file links use. Relative paths resolve through
 * that session's workspace, which is the project this panel is reporting on. The
 * encoding keeps `:` literal so a Windows drive letter survives, and encodes each
 * segment separately so `/` stays a path separator.
 */
export function fileResourceAddress(sessionId: string, filePath: string): string {
  const encodeSegment = (segment: string): string =>
    encodeURIComponent(segment).replace(/%3A/gi, ':');
  const normalized = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized
    .split('/')
    .map(encodeSegment)
    .join('/')}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Resolve one of this plugin's host routes against the PAGE's own base.
 *
 * Two failures are avoided here. A leading slash pins a URL to the origin root,
 * which walks out of any reverse-proxy directory prefix. And resolving against
 * `location.host` breaks on the desktop shell, whose page origin is `dsh-app://app`
 * — a hostname that never completes a DNS lookup.
 *
 * @param {string} path
 * @returns {string}
 */
export function routeUrl(path: string): string {
  const raw =
    typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '';
  const placeholder = 'http://dsh.invalid/';
  const url = new URL(raw === '' ? placeholder : raw, placeholder);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL(path.replace(/^\/+/, ''), url.href).href;
}

/**
 * Resolve the project this panel is about.
 *
 * The panel shows the project the operator is *in*, not a global list of indexed
 * repositories. A registry-driven picker was the first design and it was wrong for
 * the job: it made `~/.gitnexus/registry.json` a hard dependency, so a fresh clone,
 * a second working tree, or an index built with `GITNEXUS_HOME` redirected simply
 * could not be shown — which is exactly when a coverage panel is most useful.
 *
 * The path comes from the session's own `cwd`, selected out of the session snapshot:
 *
 *     useSessions((sessions) => sessions.byId[sessionId]?.cwd)
 *
 * That is the shipped pattern, read off `dsh-client-ui-sidebar-files`, whose body
 * sits in this same slot and needs the same answer. An earlier revision guessed at
 * `useWorkspaces` and the panel rendered "未解析到工作区" — a hook that exists is not
 * the same as the hook that carries this value.
 *
 * @param {{ params?: {repo?: string}, sessionId?: string, useSessions?: Function, useWorkspaces?: Function }} props
 * @returns {string | null}
 */
export function useProjectPath(props: SlotProps): string | null {
  // A caller that opened the tab with an explicit repo wins, so `openTab` stays
  // usable for previewing a project other than the session's.
  const explicit = props?.params?.repo;
  const sessionId = props?.sessionId;

  // Hooks must be called unconditionally: a host that supplies neither still needs
  // the calls to happen, so a no-op of the same shape stands in rather than a
  // branch around the hook.
  const selectSession = typeof props?.useSessions === 'function' ? props.useSessions : () => null;
  const fromSession = selectSession((sessions) =>
    typeof sessionId === 'string' ? sessions?.byId?.[sessionId]?.cwd ?? null : null,
  );

  const selectWorkspace = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : () => null;
  const fromWorkspace = selectWorkspace((snapshot) => {
    const list = snapshot?.workspaces;
    if (!Array.isArray(list) || typeof sessionId !== 'string') return null;
    const mine = list.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    return typeof mine?.cwd === 'string' && mine.cwd !== '' ? mine.cwd : null;
  });

  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
  return typeof fromWorkspace === 'string' && fromWorkspace !== '' ? fromWorkspace : null;
}

/**
 * Which context props actually arrived.
 *
 * Rendered only when the project could not be resolved. Without it the panel can
 * only say "no project", which is a dead end for whoever has to fix it — with it,
 * one screenshot names the missing input.
 *
 * @param {any} props
 * @returns {string[]}
 */
export function contextDiagnostic(props: SlotProps): ContextDiagnostic {
  const present: string[] = [];
  const absent: string[] = [];
  const note = (name: string, ok: boolean): void => {
    (ok ? present : absent).push(name);
  };
  note('sessionId', typeof props?.sessionId === 'string' && props.sessionId !== '');
  note('useSessions', typeof props?.useSessions === 'function');
  note('useWorkspaces', typeof props?.useWorkspaces === 'function');
  note('useTabInfo', typeof props?.useTabInfo === 'function');
  note('params.repo', typeof props?.params?.repo === 'string');
  return { present, absent };
}
/**
 * Capture the optional right-sidebar controller.
 *
 * Called from `apply` after `ctx.inject(['sidebarRight'])`. Kept here because the
 * captured openers are this module's state: the search-result click reads them.
 */
export function bindSidebarRight(service: SidebarRightApi | undefined): void {
  if (service === undefined || typeof service.openResource !== 'function') return;
  openResource = (address, options) => service.openResource(address, options);
  if (typeof service.openResourceIn === 'function') {
    openResourceIn = (sessionId, address, options) => service.openResourceIn?.(sessionId, address, options);
  }
}
