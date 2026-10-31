/**
 * `GET /api/gitnexus/risk?repo=<project>` — what the changes did to the dependency graph.
 *
 * Read-only by construction: the tracker it reads was started by an earlier tool call or by
 * the panel itself, and this route never starts a query on its own. That matters for the
 * panel's refresh loop — a poll every few seconds must not spawn a child process every few
 * seconds. When an evaluation is in flight the answer says `busy`, and the panel shows the
 * previous verdict with that caveat instead of waiting.
 *
 * The sentence and the report ship together for the same reason the delta route ships its
 * notice: a second copy of the wording in the client is a second thing to drift.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { RiskReport } from '../gitnexus/risk.js';
import type { TrackerRecentChange } from '../gitnexus/watch/registry.js';

const RISK_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface RiskRoutePayload {
  risk: RiskReport | null;
  /** `formatRisk` output for the current report, or `null` before the first evaluation. */
  text: string | null;
  /** The one-line form a graph tool would append. */
  line: string | null;
  watching: boolean;
  live: boolean;
  degraded: string | null;
  busy: boolean;
  delta: {
    comparable: boolean;
    certain: boolean;
    needsRefresh: boolean;
    counts: { modified: number; added: number; deleted: number; excluded: number };
    /**
     * Files that differ from the index, capped for the wire.
     *
     * The counts above are the whole truth; this is the readable head of the same list, so
     * the panel can name files without shipping four thousand paths on every poll.
     */
    files: Array<{ path: string; kind: 'modified' | 'added' | 'deleted' | 'excluded' }>;
  } | null;
  /**
   * Paths the watcher saw change, newest first — "what is being written right now".
   *
   * Distinct from `delta.files`: this is event-level, so it includes a file that was saved
   * without changing a byte, and it updates before any evaluation runs.
   */
  recent: TrackerRecentChange[];
  /** ISO time of the last coalesced change. */
  lastChangeAt: string | null;
  /** Bumped whenever the tracker observes a change; the panel skips identical values. */
  version: number;
}

export interface RiskRouteDeps {
  /** Start watching if needed, and answer from whatever is known right now. */
  read: (repoPath: string) => RiskRoutePayload;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountRiskRoute(webServer: WebServerService, deps: RiskRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, RISK_METHODS)) return;

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

    sendJson(res, 200, { ok: true, ...deps.read(absRepo), readAt: new Date().toISOString() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/risk', handler });
}
