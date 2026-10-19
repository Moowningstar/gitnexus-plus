/**
 * `GET /api/gitnexus/search?repo=<project>&q=<keyword>` — keyword search.
 *
 * The fourth route, and the first that is neither a reading of the index manifest
 * nor a maintenance action: it queries the graph's symbol names and file paths.
 * It is read-only in the strongest sense this plugin can offer — the engine opens
 * LadybugDB with `readOnly: true` and takes no write lock — so the method policy is
 * the read-only one (GET/HEAD), not the analyze route's wider set.
 *
 * The bound is the same project-root check the coverage route uses: a directory
 * that is neither indexed nor a `.git` root is refused, so the route cannot be used
 * to enumerate a filesystem. Search itself additionally requires a complete index
 * store and returns a typed error when the graph is missing.
 */

import path from 'node:path';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import { isProjectRoot } from '../gitnexus/index-meta.js';
import { SearchError, type SearchReport } from '../gitnexus/search.js';

const SEARCH_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface SearchRouteDeps {
  /** Run one keyword search. Errors are `SearchError` instances when typed. */
  search: (repoPath: string, query: string, options?: { limit?: number }) => Promise<SearchReport>;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountSearchRoute(webServer: WebServerService, deps: SearchRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, SEARCH_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }
    const query = url.searchParams.get('q');
    if (query === null || query.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-query', message: 'q query parameter is required' });
      return;
    }

    const absRepo = path.resolve(repo);
    // The same boundary as the coverage route: a search must not become a way to
    // ask whether an arbitrary directory exists. The engine repeats this check for
    // direct callers; at the HTTP edge it saves opening a database to say no.
    if (!(await isProjectRoot(absRepo))) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-project',
        message: 'directory is neither a GitNexus index nor a git repository root',
      });
      return;
    }

    if (answerHead(req, res)) return;

    // `limit` is optional; the engine clamps it. A malformed value is treated as
    // absent rather than as an error — the search itself does not depend on it.
    const rawLimit = url.searchParams.get('limit');
    const parsed = rawLimit === null ? Number.NaN : Number.parseInt(rawLimit, 10);
    const limit = Number.isFinite(parsed) ? parsed : undefined;

    try {
      const report = await deps.search(absRepo, query, { limit });
      sendJson(res, 200, {
        ok: true,
        ...report,
        readAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof SearchError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
        return;
      }
      // `guardHandler` turns anything else into a 500; rethrow so its single error
      // path stays the only place that formats an unexpected failure.
      throw error;
    }
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/search', handler });
}
