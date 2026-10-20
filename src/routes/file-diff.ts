/**
 * `GET /api/gitnexus/file-diff?repo=<project>&path=<file>&sha=<commit>`
 *
 * The patch behind one commit's effect on one file. Split from file-history because the
 * two cost differently: the timeline is a `git log`, and the patch is a `git show` that
 * can carry a whole minified file. The client asks for it only when the reader expands a
 * commit.
 *
 * Read-only. The path is resolved inside the project root and the sha is checked against
 * a hash shape before it reaches git.
 */

import path from 'node:path';
import { isProjectRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { CommitDiff } from '../gitnexus/git-activity.js';

export interface FileDiffRouteDeps {
  read: (repoPath: string, filePath: string, sha: string) => Promise<CommitDiff>;
}

/** @returns disposer that unregisters the route */
export function mountFileDiffRoute(
  webServer: WebServerService,
  deps: FileDiffRouteDeps,
): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    const file = url.searchParams.get('path');
    const sha = url.searchParams.get('sha');
    if (
      repo === null ||
      repo.trim() === '' ||
      file === null ||
      file.trim() === '' ||
      sha === null ||
      !/^[0-9a-fA-F]{7,40}$/.test(sha.trim())
    ) {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-params',
        message: 'repo, path and a 7–40 character hex sha are required',
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

    const diff = await deps.read(absRepo, relative, sha.trim());
    sendJson(res, 200, { ok: true, ...diff, readAt: new Date().toISOString() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/file-diff', handler });
}
