import * as React from 'react';
import { routeUrl } from '../navigation';
import { Button, HAIRLINE, MUTED, SOFT_BG, Section, StateDot, h, styles } from '../primitives';
import { ClientWebViewStatus } from '../types';

/**
 * The 3D view, as a door to GitNexus's own web UI.
 *
 * WHY THERE IS NO RENDERER HERE
 * -----------------------------
 * 0.1.6 drew the community overview on a canvas, in this file's predecessor: a few
 * hundred lines of perspective projection with no depth buffer, no meaningful picking
 * and no way to load a graph that did not fit in a sidebar column. GitNexus ships a web
 * client that does exactly this job with a real graph renderer, and it is already on the
 * machine that owns the index. So the panel starts that server and embeds it, and the
 * effort goes into the two things a canvas could not do: saying why the view is not
 * available, and getting out of the way once it is.
 *
 * The SPA lives on a different origin (`127.0.0.1:<port>`), so this component can only
 * size and frame it — never inspect it. That is why every failure is a sentence the
 * operator can act on rather than a blank rectangle, and why "在新标签页打开" exists:
 * when embedding is the thing that broke, the view still works as a normal tab.
 */

const POLL_MS = 1200;

const OVERLAY_BACKDROP: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '18px',
};

const OVERLAY_DIALOG: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(96vw, 1280px)',
  height: '86vh',
  border: HAIRLINE,
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-base, #11111b)',
  boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
  overflow: 'hidden',
};

interface WebViewBody {
  ok?: boolean;
  view?: ClientWebViewStatus;
  message?: string;
}

/**
 * One line about the AI settings the page was seeded with.
 *
 * There is nothing to redact: the status carries the provider, model and endpoint, never
 * the key. When injection did not happen the host's own sentence is shown, because it
 * already distinguishes "no variables set" from "the variables are wrong" from "an
 * external server owns this page".
 */
export function webViewAiLine(view: ClientWebViewStatus): string {
  // A host that predates this field sends no `ai` at all — that is a host that cannot
  // inject anything, so the honest line is the same as "not injected".
  const ai = view.ai;
  if (ai === undefined || ai === null) return '未注入 AI 设置。';
  if (!ai.injected) return ai.reason ?? '未注入 AI 设置。';
  const endpoint = ai.baseUrl === null ? '' : ` · ${ai.baseUrl}`;
  return `已注入：${ai.provider ?? '?'} · ${ai.model ?? '?'}${endpoint}`;
}

/**
 * The card's own status line, in the panel's vocabulary.
 *
 * `adopted` is called out rather than folded into "running": the operator started that
 * server themselves, and a plugin that silently claims ownership of it would be lying
 * about what 停止服务 will do (nothing — see `stop` in the runner).
 */
export function webViewSummary(view: ClientWebViewStatus | null, route: 'unknown' | 'present' | 'missing'): {
  dot: 'done' | 'ongoing' | 'idle' | 'warning' | 'error';
  text: string;
} {
  if (route === 'missing') return { dot: 'warning', text: '宿主未挂载' };
  if (view === null) return { dot: 'idle', text: '未知' };
  switch (view.state) {
    case 'starting':
      return { dot: 'ongoing', text: '启动中' };
    case 'ready':
      if (!view.repoResolvable) return { dot: 'warning', text: '服务在跑，但索引对不上' };
      return { dot: 'done', text: view.owner === 'adopted' ? '外部服务已就绪' : '已就绪' };
    case 'failed':
      return { dot: 'error', text: '启动失败' };
    case 'unavailable':
      return { dot: 'warning', text: '不可用' };
    default:
      return { dot: 'idle', text: '未启动' };
  }
}

export function WebViewSection({ projectPath }: { projectPath: string }) {
  const [view, setView] = React.useState<ClientWebViewStatus | null>(null);
  const [route, setRoute] = React.useState<'unknown' | 'present' | 'missing'>('unknown');
  const [busy, setBusy] = React.useState<null | 'start' | 'stop' | 'restart'>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [started, setStarted] = React.useState(false);
  const mounted = React.useRef(true);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, []);

  const settle = React.useCallback((body: WebViewBody | null, status: number): void => {
    if (!mounted.current) return;
    if (status === 404) {
      setRoute('missing');
      setView(null);
      return;
    }
    setRoute('present');
    if (body?.view) setView(body.view);
    if (body?.ok === false && typeof body.message === 'string') setError(body.message);
  }, []);

  const load = React.useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const res = await fetch(
          routeUrl(`/api/gitnexus/webview?repo=${encodeURIComponent(projectPath)}`),
          signal ? { signal } : undefined,
        );
        const body = (await res.json().catch(() => null)) as WebViewBody | null;
        settle(body, res.status);
      } catch (cause) {
        if (!mounted.current) return;
        if ((cause as { name?: string })?.name === 'AbortError') return;
        setError(String((cause as Error)?.message ?? cause));
      }
    },
    [projectPath, settle],
  );

  // The status is read once, on mount. The server is deliberately not started here: a
  // panel that spawns a node process as soon as a sidebar is opened would cost the
  // operator a background process they never asked for. 打开 3D 视图 is the request.
  React.useEffect(() => {
    if (started) return;
    setStarted(true);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, started]);

  /**
   * A start request resolves only when the host has finished waiting for the server, so
   * it can take most of half a minute. Polling alongside it turns that silence into a
   * progress line instead of a button that looks dead.
   */
  const act = React.useCallback(
    async (action: 'start' | 'stop' | 'restart'): Promise<ClientWebViewStatus | null> => {
      setBusy(action);
      setError(null);
      if (timer.current !== null) clearInterval(timer.current);
      if (action !== 'stop') {
        timer.current = setInterval(() => void load(), POLL_MS);
      }
      try {
        const url =
          action === 'stop'
            ? routeUrl('/api/gitnexus/webview')
            : routeUrl(
                `/api/gitnexus/webview?repo=${encodeURIComponent(projectPath)}${action === 'restart' ? '&restart=1' : ''}`,
              );
        const res = await fetch(url, { method: action === 'stop' ? 'DELETE' : 'POST' });
        const body = (await res.json().catch(() => null)) as WebViewBody | null;
        settle(body, res.status);
        if (!body?.ok && body?.message) setError(body.message);
        return body?.view ?? null;
      } catch (cause) {
        if (mounted.current) setError(String((cause as Error)?.message ?? cause));
        return null;
      } finally {
        if (timer.current !== null) {
          clearInterval(timer.current);
          timer.current = null;
        }
        if (mounted.current) setBusy(null);
      }
    },
    [load, projectPath, settle],
  );

  return h(
    Section,
    {
      wide: true,
      title: '3D 视图',
      meta: webViewSummary(view, route).text,
    },
    h(WebViewCard, { view, route, busy, error, onAct: act }),
  );
}

/**
 * The overlay is a sibling of the card rather than a portal: the panel is already inside
 * the scroll container this plugin was given, and a `position: fixed` child escapes it
 * without needing an event portal.
 */
export function WebViewCard({
  view,
  route,
  busy,
  error,
  onAct,
}: {
  view: ClientWebViewStatus | null;
  route: 'unknown' | 'present' | 'missing';
  busy: null | 'start' | 'stop' | 'restart';
  error: string | null;
  onAct: (action: 'start' | 'stop' | 'restart') => Promise<ClientWebViewStatus | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [src, setSrc] = React.useState<string | null>(null);

  // Escape closes from anywhere; the listener only exists while the overlay is open.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const summary = webViewSummary(view, route);
  // One const rather than a boolean plus casts: everything below either has a URL to
  // open or does not, and `view.url` is the only thing worth narrowing on.
  const readyUrl =
    view !== null && view.state === 'ready' && typeof view.url === 'string' && view.url !== '' ? view.url : null;
  const adoptable = view?.owner === 'adopted';
  const canStop = view?.owner === 'managed';

  // A stopped (or restarted) server leaves the iframe pointing at a dead port, so the
  // dialog would sit on a browser error page that says nothing about what happened. The
  // card behind it already explains; closing is the honest move.
  React.useEffect(() => {
    if (open && readyUrl === null) setOpen(false);
  }, [open, readyUrl]);

  const openView = async (): Promise<void> => {
    if (readyUrl !== null) {
      setSrc(readyUrl);
      setOpen(true);
      return;
    }
    const next = await onAct('start');
    if (next !== null && next.state === 'ready' && typeof next.url === 'string' && next.url !== '') {
      setSrc(next.url);
      setOpen(true);
    }
  };

  if (route === 'missing') {
    return h(
      'div',
      { style: { display: 'flex', gap: '6px', alignItems: 'flex-start', ...MUTED } },
      h(StateDot, { state: 'warning' }),
      h(
        'span',
        null,
        '这个宿主没有挂载 3D 视图的服务端（需要 0.1.7 及以上的 gitnexus-plus）。面板其余部分照常可用。',
      ),
    );
  }

  const detail = view?.message ?? error ?? null;

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
      h(
        'div',
        { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h(StateDot, { state: summary.dot }),
        h('span', { style: { flex: '1 1 auto' } }, '用 GitNexus 自带的 Web 端渲染整张图，本面板负责启动与嵌入。'),
      ),

      detail === null
        ? null
        : h(
            'div',
            { style: { ...MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            detail,
          ),

      view === null
        ? null
        : h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'flex-start', ...MUTED, fontSize: '12px' } },
            h('span', { style: { whiteSpace: 'nowrap' } }, 'AI 设置'),
            h('span', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, webViewAiLine(view)),
          ),

      readyUrl !== null && view !== null
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            h(
              'code',
              {
                style: {
                  ...styles.mono,
                  flex: '1 1 220px',
                  padding: '6px 8px',
                  border: HAIRLINE,
                  borderRadius: '6px',
                  background: SOFT_BG,
                  wordBreak: 'break-all',
                  userSelect: 'all',
                },
              },
              readyUrl,
            ),
            adoptable
              ? h('span', { style: { ...MUTED, fontSize: '11px' } }, '外部启动的服务，停止请在那边操作')
              : null,
          )
        : null,

      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h(
          Button,
          {
            variant: 'primary',
            disabled: busy !== null || view?.state === 'unavailable',
            onClick: () => void openView(),
          },
          readyUrl !== null ? '打开 3D 视图' : busy === 'start' ? '正在启动…' : '启动并打开 3D 视图',
        ),
        readyUrl !== null
          ? h(
              Button,
              {
                variant: 'ghost',
                onClick: () => window.open(readyUrl, '_blank', 'noopener'),
              },
              '在新标签页打开',
            )
          : null,
        canStop
          ? h(
              Button,
              { variant: 'ghost', disabled: busy !== null, onClick: () => void onAct('stop') },
              busy === 'stop' ? '正在停止…' : '停止服务',
            )
          : null,
        view !== null && view.state !== 'unavailable' && view.state !== 'starting'
          ? h(
              Button,
              { variant: 'ghost', disabled: busy !== null, onClick: () => void onAct('restart') },
              busy === 'restart' ? '正在重启…' : '重新启动',
            )
          : null,
      ),

      view !== null && view.output !== ''
        ? h(
            'details',
            null,
            h('summary', { style: { cursor: 'pointer', ...MUTED } }, '服务输出'),
            h(
              'pre',
              {
                style: {
                  ...styles.mono,
                  margin: '6px 0 0',
                  padding: '8px',
                  border: HAIRLINE,
                  borderRadius: '6px',
                  background: SOFT_BG,
                  maxHeight: '220px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  fontSize: '11px',
                },
              },
              view.output,
            ),
          )
        : null,
    ),

    open && src !== null
      ? h(
          'div',
          {
            style: OVERLAY_BACKDROP,
            onClick: () => setOpen(false),
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              onClick: (event: React.MouseEvent) => event.stopPropagation(),
              style: OVERLAY_DIALOG,
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderBottom: HAIRLINE,
                },
              },
              h('span', { style: { fontWeight: 600, flex: '1 1 auto' } }, 'GitNexus Web'),
              h(
                Button,
                { variant: 'ghost', onClick: () => window.open(src, '_blank', 'noopener') },
                '新标签页',
              ),
              h(Button, { variant: 'ghost', onClick: () => setOpen(false) }, '关闭'),
            ),
            h('iframe', {
              src,
              title: 'GitNexus Web',
              // Same-origin is required: the SPA fetches its own /api endpoints and
              // stores its session in localStorage. It is a distinct origin from this
              // panel, so that grant does not reach the panel's own origin.
              sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
              style: { flex: '1 1 auto', width: '100%', border: 'none', background: '#11111b' },
            }),
          ),
        )
      : null,
  );
}
