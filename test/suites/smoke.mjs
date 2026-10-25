/**
 * Real-repository smoke test.
 *
 * Extracted from `run.mjs` unchanged — the checks, their messages and their order
 * inside each suite are as they were; only the file they live in changed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { captureGit, provideGitSeams } from '../../lib/gitnexus/git-capture.js';
import { runGraphTool } from '../../lib/gitnexus/graph-query.js';
import { renderTool } from '../../lib/gitnexus/graph-query-render.js';
import { createRunner } from '../../lib/subprocess.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

export async function realRepoSmoke() {
  section('smoke: report shape on a real indexed repository');
  // Default to this checkout: it has an index locally, and a CI checkout simply
  // skips the smoke instead of failing on a hard-coded Windows path.
  const repo = process.env.GITNEXUS_SMOKE_REPO ?? process.cwd();
  try {
    await fs.access(path.join(repo, '.gitnexus', 'gitnexus.json'));
  } catch {
    check('real repository indexed (skipped otherwise)', true, 'not present on this machine —skipped');
    return;
  }
  const started = Date.now();
  const report = await analyzeCoverage(repo, {});
  const elapsed = Date.now() - started;

  check('report has languages', report.languages !== null && report.languages.rows.length > 0);
  check('language percentages sum to ~100%', (() => {
    const total = report.languages.totalBytes || 1;
    const sum = report.languages.rows.reduce((s, r) => s + r.bytes / total, 0);
    return Math.abs(sum - 1) < 0.001;
  })());
  check('every language row has a colour', report.languages.rows.every((r) => /^#[0-9a-f]{6}$/i.test(r.color)));
  check('every language row has a class', report.languages.rows.every((r) => ['parsed', 'recognized', 'other'].includes(r.klass)));
  check('cap came from the index record', report.cap.source === 'index', `source=${report.cap.source}`);
  check('completes under 3s', elapsed < 3000, `${elapsed}ms`);
  // `data-screen` can be an index without a usable git history; use this checkout,
  // which has both the index and the commits the activity table needs.
  const localReport = await analyzeCoverage(process.cwd(), {});
  const localActivity = localReport.activity;
  if (localActivity === null || localActivity === undefined) {
    // The agent's test sandbox denies child processes, so `git` cannot be spawned
    // here. The client fixture still asserts the rendering; the data path is
    // exercised on a normal checkout.
    check('activity data (skipped: git unavailable in this sandbox)', true);
  } else {
    check(
      'activity exposes the three-way cross-tab',
      Array.isArray(localActivity?.cross?.rows) && localActivity.cross.rows.length === 3,
      JSON.stringify(localActivity?.cross),
    );
    // `''` is how the index reports "no commit recorded" — 0.1.3's null/undefined check
    // missed it, and an index rebuilt from a dirty tree hits exactly that case. The
    // engine then falls back to the activity-window baseline, which is the honest
    // behaviour this branch asserts.
    const recordedCommit = localReport.repo?.lastCommit;
    if (typeof recordedCommit !== 'string' || recordedCommit === '') {
      check(
        'baseline review falls back to the activity window',
        localActivity?.baseline?.source === 'window' &&
          localActivity.baseline.available === true,
        JSON.stringify(localActivity?.baseline),
      );
    } else {
      check(
        'activity reviews changes against the indexed commit',
        localActivity?.baseline?.ref === recordedCommit &&
          localActivity.baseline.available === true,
        JSON.stringify(localActivity?.baseline),
      );
    }
    check(
      'activity exposes a commit timeline',
      Array.isArray(localActivity?.timeline) &&
        localActivity.timeline.length > 0 &&
        typeof localActivity.timeline[0].subject === 'string',
      JSON.stringify(localActivity?.timeline?.slice(0, 1)),
    );
  }

  // Progress is real work, not a timer: the scan event carries the actual file
  // counter, and every event's percentage is monotonic up to the final assembly.
  const progressEvents = [];
  await analyzeCoverage(repo, {
    includeActivity: false,
    onProgress: (event) => progressEvents.push(event),
  });
  check(
    'progress reports the real scan counter',
    progressEvents.some(
      (event) => event.phase === 'scan' && event.total > 0 && event.current === event.total,
    ),
    JSON.stringify(progressEvents.slice(0, 6)),
  );
  check(
    'progress percentages never go backwards',
    progressEvents.every(
      (event, index) => index === 0 || event.percent >= progressEvents[index - 1].percent,
    ),
    JSON.stringify(progressEvents),
  );
  check(
    'progress ends at the assembly phase',
    progressEvents[progressEvents.length - 1]?.phase === 'assemble' &&
      progressEvents[progressEvents.length - 1]?.percent === 99,
    JSON.stringify(progressEvents.slice(-2)),
  );
  console.log(
    `      ${report.languages.rows.length} languages, ${report.totals.selected} selected, ` +
      `${report.totals.large} large, ${formatBytes(report.languages.totalBytes)} total, ${elapsed}ms`,
  );
}

/**
 * The embedded GitNexus web UI: `gitnexus serve` plus the URL the panel embeds.
 *
 * Every failure this module can report is one that would otherwise reach the operator
 * as a blank iframe — an index written by another GitNexus version, a registry that does
 * not hold this repository, a port already taken by someone else's server. So the tests
 * drive the state machine with a stubbed executor and a stubbed `fetch`: what is being
 * asserted is which decision gets taken, not that node can spawn a process.
 *
 * The CLI is faked through `GITNEXUS_CLI`, which `findGitnexusCli` treats as the
 * override, so these tests do not need GitNexus installed (CI does not install it).
 */

/**
 * A `SubprocessLike` that really spawns, capturing output into files.
 *
 * Named pipes are what this sandbox denies, so the seam captures through file
 * descriptors — the same shape `src/gitnexus/git-capture.ts` falls back to. The point of
 * this file is to run the production path end to end, so the seam has to be honest.
 */
function fileBackedSubprocess(scratch) {
  let counter = 0;
  return {
    resolveExecutable: (command) => command,
    spawn(spec) {
      counter += 1;
      const dir = mkdtempSync(path.join(os.tmpdir(), `smoke-sp-${process.pid}-${counter}-`));
      scratch.push(dir);
      const outFile = path.join(dir, 'stdout.txt');
      const errFile = path.join(dir, 'stderr.txt');
      const outFd = openSync(outFile, 'w');
      const errFd = openSync(errFile, 'w');
      const env = { ...process.env };
      // The spec carries environment additions as a record, not as pairs.
      if (spec.env !== undefined) Object.assign(env, spec.env);
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      });
      closeSync(outFd);
      closeSync(errFd);
      return {
        collected: {
          stdout: { readFrom: (offset) => ({ text: readFileSync(outFile, 'utf8').slice(offset) }) },
          stderr: { readFrom: (offset) => ({ text: readFileSync(errFile, 'utf8').slice(offset) }) },
        },
        result: () =>
          new Promise((resolve) => {
            child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
          }),
        kill: () => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          return true;
        },
      };
    },
  };
}

/**
 * The three graph tools, on the index this checkout actually has.
 *
 * `graph-query.mjs` covers every decision with stubs; this is the one place that runs
 * request file → helper process → real `LocalBackend` → renderer. It asks about a symbol
 * this repository defines (`guardHandler`), so a green run proves the tool answers about
 * *code*, not just about the index.
 *
 * Skipped when there is no index or no built helper, so a CI checkout stays green
 * without GitNexus installed.
 */
export async function graphToolSmoke() {
  section('smoke: a real question against the real index');
  const repo = process.env.GITNEXUS_SMOKE_REPO ?? process.cwd();
  const helperPath = path.join(import.meta.dirname, '..', '..', 'lib', 'bin', 'graph-query-helper.js');
  try {
    await fs.access(path.join(repo, '.gitnexus', 'gitnexus.json'));
    await fs.access(path.join(repo, '.gitnexus', 'lbug'));
    await fs.access(helperPath);
  } catch {
    check('indexed repository with a built helper (skipped otherwise)', true, 'not present — skipped');
    return;
  }

  const scratch = [];
  const subprocess = fileBackedSubprocess(scratch);
  const runner = createRunner({ subprocess });
  check('the argv seam is preferred when the profile mounts subprocess', runner.argvOnly === true);

  try {
    const startedAt = Date.now();
    const outcome = await runGraphTool(
      repo,
      'impact',
      { target: 'guardHandler', direction: 'upstream', summaryOnly: true },
      { shell: null, runner, helperPath, gitnexusHome: '', timeoutMs: 20_000 },
    );
    const elapsed = Date.now() - startedAt;
    check(
      'impact answers through the host seam, with no shell',
      outcome.ok === true,
      outcome.ok ? `${elapsed}ms` : `${outcome.code}: ${outcome.message}`,
    );
    if (outcome.ok) {
      const rendered = renderTool('impact', outcome.result, '');
      check(
        'the answer carries the verdict a reader acts on',
        rendered.text.startsWith('GitNexus impact') && rendered.text.includes('风险'),
        rendered.text.split('\n')[0],
      );
      check(
        'the structured result keeps the epistemic envelope',
        typeof outcome.result?.risk === 'string' && typeof outcome.result?.epistemic === 'string',
        JSON.stringify({ risk: outcome.result?.risk, epistemic: outcome.result?.epistemic }),
      );
      check('a real impact run completes under 5s', elapsed < 5000, `${elapsed}ms`);
    }

    // The same seam serves `git`: the four modules that read git have no host context of
    // their own, so they read the provider that `apply` installs.
    provideGitSeams(() => ({ subprocess }));
    try {
      const head = await captureGit(repo, ['rev-parse', 'HEAD']);
      check(
        'git is captured through the same seam',
        head.ok === true && /^[0-9a-f]{7,40}$/i.test(head.text.trim()),
        head.failure ?? head.text.trim().slice(0, 40),
      );
    } finally {
      provideGitSeams(null);
    }
  } finally {
    for (const dir of scratch) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup must never change the verdict.
      }
    }
  }
}
