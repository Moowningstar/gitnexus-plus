/**
 * `GET /api/gitnexus/delta?repo=<project>` — "is a refresh worth running?"
 *
 * Read-only on purpose, and separated from the analyze route for the same reason that
 * one is separate from coverage: the two halves have different method policies. This
 * route answers a question about the working tree; it never starts, cancels or writes
 * anything, so it takes only the read guard.
 *
 * The panel calls it before offering the refresh control, which is why it has to be
 * fast. It is: on a clean working tree the candidate set is empty and no file is read.
 * The engine's own bound is a candidate cap, not a time budget — see `gitnexus/delta.ts`.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { DeltaReport } from '../gitnexus/delta.js';

const DELTA_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface DeltaRouteDeps {
  read: (repoPath: string) => Promise<DeltaReport>;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountDeltaRoute(webServer: WebServerService, deps: DeltaRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, DELTA_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }

    const absRepo = path.resolve(repo);
    // Same bound as the coverage route: the directory the caller named, not a project
    // marker. A folder with no index and no `.git` is answered by the engine with
    // `comparable: false` and an explanation — which is a state the panel renders,
    // and more useful than a 404.
    if (!(await isExistingDirectory(absRepo)) || isFilesystemRoot(absRepo)) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-directory',
        message: `目录不存在、不是文件夹，或是文件系统根目录：${absRepo}`,
      });
      return;
    }

    if (answerHead(req, res)) return;

    const report = await deps.read(absRepo);
    sendJson(res, 200, { ok: true, delta: report, readAt: new Date().toISOString() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/delta', handler });
}
