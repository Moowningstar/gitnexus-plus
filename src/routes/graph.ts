/**
 * `GET /api/gitnexus/graph?repo=<project>&view=communities|community|symbols&id=<community>`
 *
 * The read-only endpoint behind the panel's graph view. Two views, both bounded on the
 * server: the browser never sends Cypher and never chooses how much of the graph to
 * load — it picks one of two projections and the budgets are applied here.
 *
 * `view` defaults to `communities` rather than erroring when absent: the overview is the
 * only sensible default, and the panel's first request has no scope yet. An unknown view
 * is a 400, not a silent fallback — a typo must not render a different graph than the
 * caller asked for.
 */

import path from 'node:path';
import { isProjectRoot } from '../gitnexus/index-meta.js';
import { GraphError, isGraphView, type GraphProjection, type GraphView } from '../gitnexus/graph.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';

const GRAPH_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface GraphRouteDeps {
  project: (repoPath: string, view: GraphView, id: string | null) => Promise<GraphProjection>;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountGraphRoute(webServer: WebServerService, deps: GraphRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, GRAPH_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, { ok: false, code: 'missing-repo', message: 'repo query parameter is required' });
      return;
    }

    const rawView = url.searchParams.get('view');
    const view: GraphView = rawView === null || rawView === '' ? 'communities' : (rawView as GraphView);
    if (!isGraphView(view)) {
      sendJson(res, 400, {
        ok: false,
        code: 'invalid-view',
        message: 'view must be one of: communities, community, symbols',
      });
      return;
    }

    const absRepo = path.resolve(repo);
    // Same bound as every other read route: a project root, so this cannot be used to
    // probe arbitrary directories.
    if (!(await isProjectRoot(absRepo))) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-project',
        message: 'directory is neither a GitNexus index nor a git repository root',
      });
      return;
    }

    if (answerHead(req, res)) return;

    const id = url.searchParams.get('id');

    try {
      const projection = await deps.project(absRepo, view, id === null || id === '' ? null : id);
      sendJson(res, 200, { ok: true, projection, readAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof GraphError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
        return;
      }
      // `guardHandler` turns anything else into a 500; rethrow so its single error
      // path stays the only place that formats an unexpected failure.
      throw error;
    }
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/graph', handler });
}
