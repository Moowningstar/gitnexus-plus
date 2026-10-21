/**
 * The one endpoint that changes something.
 *
 * Everything else this plugin serves is a reading of the working tree; this route
 * starts `gitnexus analyze --index-only` through the host's shell executor. It is a
 * separate module from `coverage.ts` rather than another branch inside it, so the
 * read-only half keeps a guard set that cannot mutate and this half can be reviewed
 * on its own.
 *
 * THREE METHODS, THREE MEANINGS
 * -----------------------------
 * `POST` starts a run, `GET` reports where it got to, `DELETE` asks it to stop. They
 * are one endpoint because the run is one resource and the panel polls the same URL it
 * started, which removes the id bookkeeping a separate status route would need.
 *
 * WHAT THIS ROUTE DOES NOT DO
 * ---------------------------
 * It does not escalate. The runner never chooses a mode or widens one; it only
 * forwards the policy the host resolved (rooted at the repository), so an agentless
 * route does not fall back to the DSH application directory. A refusal comes back as
 * `denied` and is not retried wider — see `gitnexus/analyze.ts`, which is where that
 * decision lives and is tested.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, passWriteGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { AnalyzeStatus } from '../gitnexus/analyze.js';

/**
 * The methods this route answers. A wider set than the coverage route's on purpose:
 * the difference between the two routes *is* their method policy.
 */
const ANALYZE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

export interface AnalyzeRouteDeps {
  /**
   * Begin a run, or return the one already in flight for this repository.
   * `force` selects the destructive full rebuild and `repairFts` the FTS-only repair;
   * both are passed through, never inferred from the method or the route.
   */
  start: (repoPath: string, options?: { force?: boolean; repairFts?: boolean }) => AnalyzeStatus;
  status: (repoPath: string) => AnalyzeStatus | null;
  cancel: (repoPath: string) => boolean;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountAnalyzeRoute(webServer: WebServerService, deps: AnalyzeRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, ANALYZE_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }
    const absRepo = path.resolve(repo);

    if (answerHead(req, res)) return;

    if (req.method === 'POST') {
      // The only mutating verb here, so the only one that takes the write guard. A
      // cross-origin page can reach loopback; `Origin` is what separates it from the
      // desktop shell's own fetch.
      if (!passWriteGuard(req, res)) return;
      // Indexing a missing path or a whole filesystem root is never what the panel
      // means, and the runner would hand `C:\` to `analyze --skip-git` before it
      // failed. Validate the same boundary the read-only routes use.
      if (!(await isExistingDirectory(absRepo)) || isFilesystemRoot(absRepo)) {
        sendJson(res, 404, {
          ok: false,
          code: 'not-a-directory',
          message: `目录不存在、不是文件夹，或是文件系统根目录：${absRepo}`,
        });
        return;
      }
      // `force=1` is the full rebuild. It is an explicit query flag rather than a
      // body field because the panel's only other POST parameter is the repo, and a
      // flag in the URL is visible in the run's own command and in a log.
      //
      // `mode=repair-fts` is the narrower write: rebuild the search indexes only.
      // Expressed as a mode rather than a second boolean so the two cannot both be
      // true — the runner resolves that precedence too, but the route should not
      // produce an ambiguous request in the first place.
      const repairFts = url.searchParams.get('mode') === 'repair-fts';
      const force = !repairFts && url.searchParams.get('force') === '1';
      sendJson(res, 200, { ok: true, run: deps.start(absRepo, { force, repairFts }) });
      return;
    }

    if (req.method === 'DELETE') {
      if (!passWriteGuard(req, res)) return;
      const cancelled = deps.cancel(absRepo);
      // Cancelling nothing is not an error worth a 404: the caller's intent — "this
      // repository should not be analysing" — already holds.
      sendJson(res, 200, { ok: true, cancelled, run: deps.status(absRepo) });
      return;
    }

    const run = deps.status(absRepo);
    // `null` means nothing has run here in this host's lifetime, which is a state the
    // panel renders ("尚未运行"), not a failure.
    sendJson(res, 200, { ok: true, run });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/analyze', handler });
}
