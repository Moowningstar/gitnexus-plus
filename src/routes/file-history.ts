/**
 * `GET /api/gitnexus/file-history?repo=<project>&path=<file>&days=7`
 *
 * The file timeline is read on demand. It is deliberately a separate route from
 * coverage: a report already crosses every file in the activity window, while
 * "show me this one file's commits" is a single bounded `git log --follow`.
 *
 * Read-only like coverage/search. The path is resolved inside the project root, and
 * the engine clamps `days` to 1–30, so a hand-written URL cannot walk the filesystem
 * or request an unbounded history.
 */

import path from 'node:path';
import { isProjectRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { FileHistory } from '../gitnexus/git-activity.js';

export interface FileHistoryRouteDeps {
  read: (
    repoPath: string,
    filePath: string,
    options?: { days?: number },
  ) => Promise<FileHistory>;
}

/** @returns disposer that unregisters the route */
export function mountFileHistoryRoute(
  webServer: WebServerService,
  deps: FileHistoryRouteDeps,
): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    const file = url.searchParams.get('path');
    if (repo === null || repo.trim() === '' || file === null || file.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-params',
        message: 'repo and path query parameters are required',
      });
      return;
    }

    const absRepo = path.resolve(repo);
    if (!(await isProjectRoot(absRepo))) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-project',
        message: 'directory is neither a GitNexus index nor a git repository root',
      });
      return;
    }

    const relative = file.trim();
    const prefix = absRepo.endsWith(path.sep) ? absRepo : `${absRepo}${path.sep}`;
    const absolute = path.resolve(absRepo, relative);
    // Windows paths compare case-insensitively; normalising both sides avoids a
    // false "outside project" for a path the caller spelled with another drive case.
    const inside =
      process.platform === 'win32'
        ? absolute.toLowerCase().startsWith(prefix.toLowerCase())
        : absolute.startsWith(prefix);
    if (!inside) {
      sendJson(res, 400, {
        ok: false,
        code: 'invalid-path',
        message: 'path must resolve inside the project root',
      });
      return;
    }

    if (answerHead(req, res)) return;

    const parsedDays = Number.parseInt(url.searchParams.get('days') ?? '7', 10);
    const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, parsedDays)) : 7;
    const history = await deps.read(absRepo, relative, { days });
    sendJson(res, 200, {
      ok: true,
      ...history,
      readAt: new Date().toISOString(),
    });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/file-history', handler });
}
