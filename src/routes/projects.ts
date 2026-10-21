/**
 * `GET /api/gitnexus/projects?root=<workspace>` — which projects live under a workspace.
 *
 * The panel's workspace is often a container rather than one project. This route is the
 * read-only resolve step: it reports the workspace itself, every GitNexus index at or
 * below it, and git repositories that have no index yet, with enough metadata for a
 * switcher. It never describes an arbitrary directory outside the one the caller named.
 * The client chooses one and asks the existing coverage/delta/graph/search routes for
 * that exact path.
 *
 * Keeping resolution out of `coverage` matters: a project switch must not re-read the
 * project list, a refresh must not silently change which project is described, and an
 * older client keeps the old coverage contract. The walk is bounded by
 * `findIndexProjects`; its `truncated` flag is forwarded rather than hidden.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { findIndexProjects } from '../gitnexus/discover.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';

const PROJECT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * @returns disposer that unregisters the route
 */
export function mountProjectsRoute(webServer: WebServerService): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, PROJECT_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const root = url.searchParams.get('root');
    if (root === null || root.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-root',
        message: 'root query parameter is required',
      });
      return;
    }

    const absRoot = path.resolve(root);
    if (!(await isExistingDirectory(absRoot)) || isFilesystemRoot(absRoot)) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-directory',
        message: `目录不存在、不是文件夹，或是文件系统根目录：${absRoot}`,
      });
      return;
    }

    if (answerHead(req, res)) return;

    const result = await findIndexProjects(absRoot);
    sendJson(res, 200, {
      ok: true,
      root: result.root,
      projects: result.projects,
      visited: result.visited,
      truncated: result.truncated,
      readAt: new Date().toISOString(),
    });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/projects', handler });
}
