/**
 * `GET /api/gitnexus/ledger?repo=<project>` — what changed in this dirty window.
 *
 * Read-only: the window it reads was opened and advanced by the tracker, usually because
 * a tool call or the panel asked for the change set first. Polling this route does not
 * open a window, hash a file or start a child process — it projects state that already
 * exists. That matters because the panel polls; a poll must not be an evaluation.
 *
 * The payload keeps three "nothing here" cases apart, because they mean different things:
 * no window yet (a clean tree), a tracker that is not watching (`tracking: false`, with
 * `degraded` saying why), and a host that never mounted this route (404 in the panel).
 * Collapsing them into "no changes" would be the one lie this feature could tell.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { SessionLedger } from '../gitnexus/ledger.js';
import type { TrackerSnapshot } from '../gitnexus/watch/registry.js';

const LEDGER_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface LedgerRoutePayload {
  repo: string;
  /** False when the tracker could not start (no usable storage, no watcher). */
  tracking: boolean;
  degraded: string | null;
  /** null means "no window yet"; it does not mean "nothing changed". */
  ledger: SessionLedger | null;
  /**
   * Paths the watcher saw written but the ledger has not observed yet.
   *
   * The gap is real: a save arrives before any comparison runs, and saying so is more
   * useful than showing a window that is one evaluation behind without a hint.
   */
  pending: string[];
  version: number;
}

export interface LedgerRouteDeps {
  /** Start watching if needed, and answer from state that already exists. */
  read: (repoPath: string) => TrackerSnapshot;
}

/** Recent writes that the ledger has not counted yet, newest first. */
function pendingPaths(snapshot: TrackerSnapshot): string[] {
  const seen = new Map((snapshot.ledger?.files ?? []).map((file) => [file.path, file.lastSeenAt]));
  return snapshot.recent
    .filter((change) => {
      const counted = seen.get(change.path);
      return counted === undefined || counted < change.at;
    })
    .map((change) => change.path);
}

/**
 * @returns disposer that unregisters the route
 */
export function mountLedgerRoute(webServer: WebServerService, deps: LedgerRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, LEDGER_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }

    const absRepo = path.resolve(repo);
    if (!(await isExistingDirectory(absRepo)) || isFilesystemRoot(absRepo)) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-directory',
        message: `目录不存在、不是文件夹，或是文件系统根目录：${absRepo}`,
      });
      return;
    }

    if (answerHead(req, res)) return;

    const snapshot = deps.read(absRepo);
    const payload: LedgerRoutePayload = {
      repo: snapshot.repoPath,
      tracking: snapshot.watching,
      degraded: snapshot.degraded,
      ledger: snapshot.ledger,
      pending: pendingPaths(snapshot),
      version: snapshot.version,
    };
    sendJson(res, 200, { ok: true, ...payload, readAt: new Date().toISOString() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/ledger', handler });
}
