/**
 * The endpoint that starts and stops the GitNexus web server.
 *
 * Its own route rather than a branch in `graph.ts` because it is the only other
 * process-owning endpoint this plugin has, and the two existing ones (`analyze`,
 * `install`) established the shape: `POST` starts, `GET` reports, `DELETE` stops. The
 * panel polls the URL it started, so no run id has to be booked anywhere.
 *
 * WHAT IT REFUSES
 * ---------------
 * The repository must exist, must not be a filesystem root, and must already be
 * registered with GitNexus (the runner checks its registries). Starting a server for a
 * directory with no index would produce a SPA that silently shows a *different*
 * repository — the failure this plugin exists to make visible — so the runner reports
 * it instead, and the panel says which registry it looked in.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, passWriteGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { WebViewStatus } from '../gitnexus/webview.js';

const WEB_VIEW_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

export interface WebViewRouteDeps {
  status: (repoPath: string) => Promise<WebViewStatus>;
  start: (repoPath: string) => Promise<WebViewStatus>;
  restart: (repoPath: string) => Promise<WebViewStatus>;
  stop: () => Promise<WebViewStatus>;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountWebViewRoute(webServer: WebServerService, deps: WebViewRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, WEB_VIEW_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'DELETE') {
      // Stopping a process is a state change like any other, so it takes the same
      // cross-origin write guard the analyze route uses.
      if (!passWriteGuard(req, res)) return;
      sendJson(res, 200, { ok: true, view: await deps.stop() });
      return;
    }

    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }
    const absRepo = path.resolve(repo);

    if (answerHead(req, res)) return;

    if (req.method === 'POST') {
      if (!passWriteGuard(req, res)) return;
      if (!(await isExistingDirectory(absRepo)) || isFilesystemRoot(absRepo)) {
        sendJson(res, 404, {
          ok: false,
          code: 'not-a-directory',
          message: `目录不存在、不是文件夹，或是文件系统根目录：${absRepo}`,
        });
        return;
      }
      // `restart=1` forces a fresh process. Without it POST is idempotent: the panel
      // calls it on every click, and answering "already running" is what makes that
      // button safe to press twice.
      const view =
        url.searchParams.get('restart') === '1'
          ? await deps.restart(absRepo)
          : await deps.start(absRepo);
      sendJson(res, 200, { ok: view.state === 'ready', view });
      return;
    }

    const view = await deps.status(absRepo);
    sendJson(res, 200, { ok: true, view });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/webview', handler });
}
