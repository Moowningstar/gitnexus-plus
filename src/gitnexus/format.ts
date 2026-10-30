/**
 * Plain-text rendering of a coverage report.
 *
 * Kept free of any DSH import so it can be tested — and reused — without a host
 * running. Tool output is read by a model as often as by a person, so there is no
 * ANSI here; `bin/gitnexus-coverage.mjs` owns the colourised terminal variant.
 */

import {
  formatBytes,
  type ActivityAuthor,
  type ActivityFile,
  type CoverageReport,
  type ReportWarning,
} from './coverage.js';

/**
 * Render a coverage report as plain text.
 *
 * @param report the report to render
 * @param withLanguages include the per-language breakdown
 */
export function formatReport(report: CoverageReport, withLanguages = true): string {
  const lines: string[] = [];
  const { repo, cap, totals } = report;

  // A missing manifest and a store GitNexus refuses are two different answers, and
  // they have two different remedies. Collapsing them into "NOT FOUND, run analyze"
  // told an unowned or foreign store to run the one operation upstream declines.
  // Reports assembled before `storage` existed still say `indexed: true`; that is the
  // one legacy shape that must keep rendering as an index.
  const storageState = repo.storage?.state ?? (repo.indexed ? 'owned' : 'missing');

  if (!repo.indexed) {
    if (storageState === 'missing' || storageState === 'empty') {
      return (
        `GitNexus index: NOT FOUND\n${repo.path}\n` +
        'No .gitnexus/gitnexus.json or .gitnexus/meta.json — run `gitnexus analyze` first.'
      );
    }

    const detail =
      storageState === 'foreign'
        ? `归属元数据记录的是另一个检出：${repo.storage?.foreignRepoPath ?? '(未记录)'}`
        : storageState === 'unowned'
          ? '.gitnexus 里有数据但没有归属元数据，GitNexus 会拒绝写入'
          : storageState === 'invalid_storage'
            ? `归属元数据无法解析：${repo.storage?.reason ?? '内容无效'}`
            : `无法读取 .gitnexus：${repo.storage?.reason ?? '权限或 IO 失败'}；状态未知，写操作不会执行`;

    return (
      `GitNexus index: BLOCKED (${storageState})\n${repo.path}\n` +
      `${detail}\n` +
      '唯一可用的操作是全量重建：`gitnexus analyze --force`（面板里是「全量重建」）。'
    );
  }

  lines.push(`GitNexus coverage · ${repo.name}`);
  lines.push(`  ${repo.path}`);
  lines.push(
    `  indexed ${repo.indexedAt} · ${repo.branch ?? 'unknown'}@${(repo.lastCommit || 'unknown').slice(0, 8)}` +
      ` · manifest ${repo.metaFile ?? 'unknown'} · GitNexus ${report.analyzer.gitnexusVersion}`,
  );
  lines.push(
    `  scanned ${totals.scanned} · selected ${totals.selected} · in graph ${totals.indexedInGraph}` +
      ` · skipped ${totals.large} · declarations suppressed ${totals.suppressedDeclarations}`,
  );
  lines.push(`  size cap ${cap.text} (${cap.source})`);

  // Freshness. The commit above is the *indexed* one; without this line a reader
  // takes it for HEAD, which on a real repository it was not.
  if (report.staleness !== undefined && report.staleness !== null) {
    const s = report.staleness;
    const short = (sha: string | null): string => (typeof sha === 'string' && sha !== '' ? sha.slice(0, 8) : '?');
    // `dirtyCount` is null when git could not be asked at all — which must not render
    // as "0 uncommitted", because that is a claim about the tree, not an absence of
    // information.
    const dirtyCount = s.dirtyCount;
    const dirty = dirtyCount !== null && dirtyCount > 0 ? `, ${dirtyCount} uncommitted` : '';
    if (s.gitAvailable !== true) {
      lines.push('  freshness unknown (git unavailable)');
    } else if (s.state === 'current') {
      lines.push(`  freshness current — HEAD ${short(s.headCommit)} matches the index${dirty}`);
    } else if (s.state === 'behind') {
      // `ahead`, not `behind`. `rev-list --left-right --count <indexed>...<HEAD>`
      // reports the index side first, so a linear fast-forward is `behind: 0` — the
      // distance the index lags is `ahead`. Reading `.behind` here printed
      // "index is 0 commit(s) behind" for an index that was one commit behind, which
      // is how this was caught: the deployed plugin's own tool output said it.
      const lag = s.aheadBehind?.ahead ?? '?';
      lines.push(
        `  freshness BEHIND — index is ${lag} commit(s) behind ` +
          `(${short(s.indexedCommit)} -> ${short(s.headCommit)})${dirty}`,
      );
    } else if (s.state === 'diverged') {
      lines.push(
        `  freshness DIVERGED — HEAD ${short(s.headCommit)} is not on the indexed commit ` +
          `${short(s.indexedCommit)}; the gap is not countable${dirty}`,
      );
    } else {
      lines.push(`  freshness unknown — cannot compare ${short(s.indexedCommit)} with ${short(s.headCommit)}${dirty}`);
    }
  }

  // What the graph holds, and which query surfaces are live. Both were already in
  // the manifest and previously went unreported.
  if (report.graph !== null && report.graph !== undefined) {
    const g = report.graph;
    lines.push(
      `  graph: ${g.nodes} nodes, ${g.edges} edges, ${g.communities} communities, ` +
        `${g.processes} processes, ${g.embeddings} embeddings (${g.edgesPerNode.toFixed(2)} edges/node)`,
    );
    // The count without the budgets reads as "this is all there is". 1.6.13's own
    // stderr says whole flows are missing when the branching / entry-point budgets
    // bite, and the manifest is the only place that survives the terminal scroll.
    if (g.processCoverage !== null && g.processCoverage !== undefined && g.processCoverage.state !== 'complete') {
      lines.push(`  process budgets: ${g.processCoverage.note}`);
    }
  }
  const caps = report.capabilities ?? {};
  const capNames = ['graph', 'fts', 'vectorSearch'];
  if (capNames.some((n) => caps[n] !== undefined)) {
    lines.push(
      `  query surfaces: ${capNames
        .map((n) => {
          const entry = caps[n];
          if (entry === undefined) return `${n}=absent`;
          return entry.status === 'available'
            ? `${n}=available`
            : `${n}=UNAVAILABLE (${entry.skipReason ?? entry.status})`;
        })
        .join(', ')}`,
    );
  }

  if (report.largeFiles.length > 0) {
    lines.push('');
    lines.push(`Skipped large files (${report.largeFiles.length}, ${formatBytes(totals.largeBytes)}):`);
    for (const file of report.largeFiles.slice(0, 30)) {
      const flags = [];
      if (file.minified?.binary) flags.push('binary asset — cannot hold symbols');
      else if (file.minified?.suspect) {
        flags.push(`single-line ~${Math.round(file.minified.avgLineLength)} chars`);
      }
      if (file.generatedHint) flags.push('generated-output path');
      const share =
        file.shareOfLanguage > 0
          ? ` (${(file.shareOfLanguage * 100).toFixed(0)}% of ${file.language.label})`
          : '';
      lines.push(
        `  ${file.sizeText.padStart(9)}  ${file.path}${share}` +
          `${flags.length > 0 ? `  [${flags.join('; ')}]` : ''}`,
      );
    }
    if (report.largeFiles.length > 30) lines.push(`  …and ${report.largeFiles.length - 30} more`);
  }

  if (withLanguages && report.languages !== null) {
    lines.push('');
    lines.push(`Languages (${report.languages.rows.length}, by bytes):`);
    const total = report.languages.totalBytes || 1;
    for (const row of report.languages.rows.slice(0, 15)) {
      lines.push(
        `  ${row.label.padEnd(14)} ${((row.bytes / total) * 100).toFixed(1).padStart(5)}%` +
          `  ${row.files} files  ${row.klass}`,
      );
    }
    if (report.languages.rows.length > 15) {
      lines.push(`  …and ${report.languages.rows.length - 15} more`);
    }
  }

  const notable = report.warnings.filter((w: ReportWarning) => w.level === 'warn');
  if (notable.length > 0) {
    lines.push('');
    for (const w of notable) lines.push(`  ! ${w.message}`);
  }
  const info = report.warnings.filter((w: ReportWarning) => w.level === 'info');
  if (info.length > 0) {
    lines.push('');
    for (const w of info) lines.push(`  - ${w.message}`);
  }

  // Git activity crossed with the index. The three-way verdict is the point: a
  // bare "not indexed" count reads as a defect, when most of it is files no scan
  // would select either (lockfiles, dotfiles, binary assets).
  const activity = report.activity;
  if (activity !== null && activity !== undefined) {
    const v = activity.totals.verdicts;
    lines.push('');
    lines.push(
      `Git activity, last ${activity.window.sinceDays} days` +
        `${activity.window.truncated ? ` (capped at ${activity.window.maxCommits} commits)` : ''}: ` +
        `${activity.totals.commits} commits by ${activity.totals.authors} author(s)` +
        `${activity.totals.bots > 0 ? ` (${activity.totals.bots} bot)` : ''}, ` +
        `+${activity.totals.insertions}/-${activity.totals.deletions} lines across ${activity.totals.files} file(s)`,
    );
    lines.push(
      `  touched files: ${v.indexed} indexed, ${v.missing} MISSING from the index, ${v.excluded} excluded by design`,
    );
    if (v.missing > 0) {
      lines.push('  files that should be indexed but are not:');
      const missing = activity.missingFiles ?? activity.byChanges.filter((f: ActivityFile) => f.verdict === 'missing');
      for (const file of missing.slice(0, 10)) {
        lines.push(`    ${String(file.changes).padStart(3)}x  ${file.path}`);
      }
      if (missing.length < v.missing) lines.push(`    …and ${v.missing - missing.length} more`);
    }
    if (activity.byChanges.some((f: ActivityFile) => f.verdict === 'indexed')) {
      lines.push('  most-changed indexed files:');
      for (const file of activity.byChanges.filter((f: ActivityFile) => f.verdict === 'indexed').slice(0, 5)) {
        lines.push(`    ${String(file.changes).padStart(3)}x  ${file.path}`);
      }
    }
    if (activity.authors.length > 0) {
      lines.push(
        `  authors: ${activity.authors
          .slice(0, 5)
          .map((a: ActivityAuthor) => `${a.name}${a.bot ? ' [bot]' : ''} (${a.commits})`)
          .join(', ')}`,
      );
    }
  }

  const quality = report.graphQuality;
  if (quality !== null && quality !== undefined && quality.counts !== undefined) {
    const names = Object.entries(quality.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => `${name} ${count}`);
    lines.push('');
    lines.push(
      `  resolver: ${quality.totalSites ?? 0} untyped receiver site(s) — while these exist, ` +
        `impact/context results are a LOWER BOUND, not exact`,
    );
    if (names.length > 0) lines.push(`    ${names.join(', ')}`);
  }
  return lines.join('\n');
}
