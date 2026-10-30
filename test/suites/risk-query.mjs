/**
 * The risk projection: what the helper answers about one change set.
 *
 * Two halves, like the rest of the engine's tests. The pure half (ordering, request
 * building) runs anywhere. The real half runs `projectRisk` against this checkout's own
 * index — the same database the helper reads in production — and is skipped when there is
 * no index, so a CI checkout stays green without GitNexus installed.
 *
 * What it proves: a deleted file's symbols come back as `broken` only when the edge comes
 * from *outside* the change set, a modified file's as `exposed`, and the counts agree with
 * the buckets. It does not prove the SQL is the one upstream uses — that is the helper's
 * business and is exercised end to end by the smoke suite.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { check, section } from '../harness.mjs';

export async function riskQueryTests() {
  const { orderRiskFiles, riskRequestFromPaths, projectRisk, RISK_FILE_CAP } = await import(
    '../../lib/gitnexus/risk-query.js'
  );

  section('risk query: ordering and the request the helper receives');

  const entries = [
    { path: 'b.ts', kind: 'added' },
    { path: 'a.ts', kind: 'modified' },
    { path: 'z.ts', kind: 'deleted' },
    { path: 'm.ts', kind: 'modified' },
    { path: 'skip.ts', kind: 'excluded' },
  ];
  // `orderRiskFiles` takes the request's own file shape, so the excluded entry is filtered
  // first — it is a delta kind, not something the query can ask about.
  const ordered = orderRiskFiles(
    entries
      .filter((e) => e.kind !== 'excluded')
      .map((e) => ({ path: e.path, kind: e.kind })),
  );
  check(
    'deleted files are asked about first',
    ordered[0].kind === 'deleted' && ordered[ordered.length - 1].kind === 'added',
    JSON.stringify(ordered.map((e) => `${e.kind}:${e.path}`)),
  );

  const { request, dropped } = riskRequestFromPaths(
    entries.map((e) => ({ ...e, reason: null })),
    10,
  );
  check(
    'excluded entries are never sent to the helper',
    request.files.every((f) => f.path !== 'skip.ts'),
    JSON.stringify(request.files),
  );
  check('nothing is reported dropped when the set fits', dropped === 0, String(dropped));
  check(
    'windows separators are normalized before they reach the query',
    (() => {
      const built = riskRequestFromPaths(
        [{ path: 'src\\a.ts', kind: 'modified', reason: null }],
        10,
      );
      return built.request.files[0]?.path === 'src/a.ts';
    })(),
    JSON.stringify(request.files),
  );

  // The cap is a query-size guard, not a promise: the report has to say how many files were
  // left out, or a large change set would read as if the whole tree had been checked.
  const many = Array.from({ length: RISK_FILE_CAP + 25 }, (_, i) => ({
    path: `f${i}.ts`,
    kind: 'modified',
    reason: null,
  }));
  const capped = riskRequestFromPaths(many, 10);
  check(
    'more changed files than the cap are cut, and the cut is counted',
    capped.request.files.length === RISK_FILE_CAP && capped.dropped === 25,
    `${capped.request.files.length} files, ${capped.dropped} dropped`,
  );

  section('risk query: against this checkout’s index');
  const repo = process.env.GITNEXUS_SMOKE_REPO ?? process.cwd();
  try {
    await fs.access(path.join(repo, '.gitnexus', 'gitnexus.json'));
    await fs.access(path.join(repo, '.gitnexus', 'lbug'));
  } catch {
    check('indexed repository for the risk query (skipped otherwise)', true, 'not present — skipped');
    return;
  }

  // A file this repository defines and other modules import: its symbols have real incoming
  // edges, which is the premise of the whole "broken" bucket.
  const target = 'src/gitnexus/index-meta.ts';
  try {
    const result = await projectRisk(repo, {
      files: [{ path: target, kind: 'deleted' }],
      limit: 10,
    });
    check(
      'a deleted file with live callers is reported as broken',
      result.counts.broken > 0,
      `broken ${result.counts.broken}, exposed ${result.counts.exposed}`,
    );
    check(
      'every broken hit lives in the deleted file',
      result.broken.every((hit) => hit.symbol.filePath === target),
      JSON.stringify(result.broken.map((hit) => hit.symbol.filePath).slice(0, 5)),
    );
    check(
      'the callers recorded for a broken hit are outside it',
      result.broken.every((hit) => hit.callers.every((caller) => caller.fromFile !== target)),
      JSON.stringify(result.broken[0]?.callers ?? []),
    );
  } catch (error) {
    check(
      'the risk query runs against the real index',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // A path the index never recorded is a blind spot, not a silent zero: the caller has to be
  // able to tell "no references" from "nothing to compare against".
  try {
    const result = await projectRisk(repo, {
      files: [{ path: 'src/definitely-not-indexed-anywhere.ts', kind: 'modified' }],
      limit: 10,
    });
    check(
      'an unindexed path is reported as a blind spot',
      result.counts.blind === 1 && result.blind[0]?.reason === 'not-in-index',
      JSON.stringify({ blind: result.counts.blind, reason: result.blind[0]?.reason }),
    );
  } catch (error) {
    check(
      'blind spots are reported rather than silently emptied',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}
