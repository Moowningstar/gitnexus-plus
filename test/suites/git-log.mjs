/**
 * The two numstat parsers, driven by literal git output.
 *
 * These are the only functions that read git's text, so they are tested with text
 * rather than with a repository: the shapes below are copied from real `git log
 * --numstat` and `git diff --numstat` output, including the `-` a binary file gets.
 */

import {
  COMMIT_FILE_LIMIT,
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
  parseDecorations,
  parseLogWindow,
  parseNumstatLines,
} from '../../lib/gitnexus/git-log.js';
import { check, section } from '../harness.mjs';

const US = LOG_FIELD_SEPARATOR;
const RS = LOG_RECORD_SEPARATOR;

/** One log record: header line, then its numstat body. */
function record(sha, author, email, date, subject, rows, parents = '', decorations = '') {
  const header = `${sha}${US}${author}${US}${email}${US}${date}${US}${subject}${US}${parents}${US}${decorations}`;
  return `${RS}${header}\n${rows.map((r) => r.join('\t')).join('\n')}\n`;
}

export async function gitLogTests() {
  section('git log parsing: numstat rows, tallies, and the exact truncation flag');

  const rows = parseNumstatLines('10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n');
  check(
    'numstat rows carry path and both deltas',
    rows.length === 2 && rows[0].path === 'src/a.ts' && rows[0].insertions === 10 && rows[0].deletions === 2,
    JSON.stringify(rows),
  );

  const binary = parseNumstatLines('-\t-\tassets/logo.png\n');
  check(
    'a binary file is a change with no line delta',
    binary.length === 1 && binary[0].path === 'assets/logo.png' && binary[0].insertions === 0 && binary[0].deletions === 0,
    JSON.stringify(binary),
  );

  const tabbed = parseNumstatLines('1\t2\tdir/with\ttab.ts\n');
  check(
    'a path containing a tab keeps the whole path',
    tabbed.length === 1 && tabbed[0].path === 'dir/with\ttab.ts',
    JSON.stringify(tabbed),
  );

  check(
    'blank and short lines are skipped',
    parseNumstatLines('\n\n50\tsrc/x.ts\n\t\n').length === 0,
    JSON.stringify(parseNumstatLines('\n\n50\tsrc/x.ts\n\t\n')),
  );

  const raw = `${record('a1', 'Ada', 'ada@example.com', '2026-10-01T10:00:00+08:00', 'first', [
    ['10', '0', 'src/a.ts'],
    ['2', '1', 'src/b.ts'],
  ])}${record('b2', 'Ada', 'ada@example.com', '2026-10-02T10:00:00+08:00', 'second', [['3', '4', 'src/a.ts']])}`;

  const window = parseLogWindow(raw, 10);
  check('both commits are counted', window.commitCount === 2 && window.commits.length === 2);
  check(
    'commit metadata survives the header split',
    window.commits[1].sha === 'b2' && window.commits[1].author === 'Ada' && window.commits[1].subject === 'second',
    JSON.stringify(window.commits[1]),
  );
  check(
    'per-file tallies accumulate across commits',
    window.files.get('src/a.ts')?.changes === 2 &&
      window.files.get('src/a.ts')?.insertions === 13 &&
      window.files.get('src/a.ts')?.deletions === 4,
    JSON.stringify(window.files.get('src/a.ts')),
  );
  check(
    'one author row aggregates their commits',
    window.authorMap.size === 1 && window.authorMap.get('Ada <ada@example.com>')?.commits === 2,
    JSON.stringify([...window.authorMap.keys()]),
  );
  check(
    'each commit contributes one stamp',
    window.stamps.length === 2 && window.stamps[0].insertions === 12 && window.stamps[1].deletions === 4,
    JSON.stringify(window.stamps),
  );
  check(
    'totals sum every file row',
    window.totalInsertions === 15 && window.totalDeletions === 5,
    JSON.stringify({ ins: window.totalInsertions, del: window.totalDeletions }),
  );
  check(
    'newest and oldest are the window edges',
    window.newestCommit === '2026-10-02T10:00:00+08:00' && window.oldestCommit === '2026-10-01T10:00:00+08:00',
    JSON.stringify([window.oldestCommit, window.newestCommit]),
  );
  check('a window that fits is not called truncated', window.capped === false);

  const capped = parseLogWindow(raw, 1);
  check(
    'the commit past the cap sets the flag instead of being counted',
    capped.capped === true && capped.commitCount === 1 && capped.commits.length === 1,
    JSON.stringify({ capped: capped.capped, count: capped.commitCount }),
  );
  check(
    'exactly the cap is not truncation',
    parseLogWindow(raw, 2).capped === false,
    JSON.stringify(parseLogWindow(raw, 2).commitCount),
  );

  const shortHeader = `${RS}onlysha\n1\t1\tsrc/a.ts\n`;
  check('a header without a date is skipped', parseLogWindow(shortHeader, 10).commitCount === 0);

  const empty = parseLogWindow('', 10);
  check(
    'an empty log yields empty tallies',
    empty.commitCount === 0 && empty.files.size === 0 && empty.stamps.length === 0 && empty.capped === false,
  );

  section('each commit carries its parents and its own file list');
  const shaped = parseLogWindow(
    `${record('c1', 'Ada', 'ada@example.com', '2026-10-03T10:00:00+08:00', 'merge', [['1', '0', 'src/a.ts']], 'p1 p2')}` +
      `${record('p1', 'Ada', 'ada@example.com', '2026-10-02T10:00:00+08:00', 'root', [['2', '3', 'src/b.ts']])}`,
    10,
  );
  check(
    'a merge commit lists both parents in order',
    JSON.stringify(shaped.commits[0].parents) === '["p1","p2"]',
    JSON.stringify(shaped.commits[0].parents),
  );
  check(
    'a root commit has no parents, not one empty string',
    Array.isArray(shaped.commits[1].parents) && shaped.commits[1].parents.length === 0,
    JSON.stringify(shaped.commits[1].parents),
  );
  check(
    'each commit carries its own file deltas, not the window total',
    shaped.commits[0].changed.length === 1 &&
      shaped.commits[0].changed[0].path === 'src/a.ts' &&
      shaped.commits[0].changed[0].insertions === 1 &&
      shaped.commits[1].changed[0].path === 'src/b.ts' &&
      shaped.commits[1].changed[0].deletions === 3,
    JSON.stringify(shaped.commits.map((commit) => commit.changed)),
  );
  check(
    'a commit under the file limit is not called truncated',
    shaped.commits[0].filesTruncated === false,
    JSON.stringify(shaped.commits[0].filesTruncated),
  );

  const manyRows = Array.from({ length: COMMIT_FILE_LIMIT + 5 }, (_, index) => ['1', '0', `src/f${index}.ts`]);
  const wide = parseLogWindow(
    `${record('w1', 'Ada', 'ada@example.com', '2026-10-04T10:00:00+08:00', 'sweep', manyRows)}`,
    10,
  );
  check(
    'the per-commit file list stops at the limit and says so',
    wide.commits[0].changed.length === COMMIT_FILE_LIMIT && wide.commits[0].filesTruncated === true,
    JSON.stringify({ kept: wide.commits[0].changed.length, truncated: wide.commits[0].filesTruncated }),
  );
  check(
    'a commit with exactly the limit is not truncation',
    parseLogWindow(`${record('w2', 'Ada', 'ada@example.com', '2026-10-04T10:00:00+08:00', 'exact', manyRows.slice(0, COMMIT_FILE_LIMIT))}`, 10)
      .commits[0].filesTruncated === false,
  );

  section('a branch reaches git log only as a plain ref');
  const { normalizeActivityRef } = await import('../../lib/gitnexus/git-activity.js');
  check(
    'a branch name passes through',
    normalizeActivityRef('feat/gitnexus-1.6.13-rc') === 'feat/gitnexus-1.6.13-rc',
    String(normalizeActivityRef('feat/gitnexus-1.6.13-rc')),
  );
  check('surrounding whitespace is trimmed', normalizeActivityRef('  main  ') === 'main');
  check(
    'empty means "the current branch"',
    normalizeActivityRef('') === null && normalizeActivityRef('   ') === null && normalizeActivityRef(null) === null,
  );
  check('a flag-shaped value is refused', normalizeActivityRef('--all') === null);
  check('a ref containing whitespace is refused', normalizeActivityRef('a b') === null);
  check('a revision range is refused', normalizeActivityRef('main..other') === null);
  check('a non-string is refused', normalizeActivityRef(7) === null && normalizeActivityRef(undefined) === null);

  section('git log parsing: decorations, the labels a lane needs');
  // `%D` is the only place git names the branches a commit belongs to, and the graph
  // cannot say which column is the trunk without it.
  check(
    'HEAD is peeled off so the row names the branch, not the symbolic ref',
    JSON.stringify(parseDecorations('HEAD -> main, origin/main')) === JSON.stringify(['main', 'origin/main']),
    JSON.stringify(parseDecorations('HEAD -> main, origin/main')),
  );
  check(
    'a tag keeps its prefix, because a tag is not a branch',
    JSON.stringify(parseDecorations('HEAD -> main, tag: v0.1.9, origin/main')) ===
      JSON.stringify(['main', 'tag: v0.1.9', 'origin/main']),
    JSON.stringify(parseDecorations('HEAD -> main, tag: v0.1.9, origin/main')),
  );
  check(
    'no decorations is an empty list, not a list holding nothing',
    parseDecorations('').length === 0 && parseDecorations(undefined).length === 0 && parseDecorations('HEAD').length === 0,
    JSON.stringify([parseDecorations(''), parseDecorations(undefined), parseDecorations('HEAD')]),
  );
  check(
    'a detached HEAD does not turn into a label',
    JSON.stringify(parseDecorations('HEAD, tag: v0.1.9')) === JSON.stringify(['tag: v0.1.9']),
    JSON.stringify(parseDecorations('HEAD, tag: v0.1.9')),
  );
  check(
    'a commit parsed from a log carries its refs',
    JSON.stringify(
      parseLogWindow(
        `${record('r1', 'Ada', 'ada@example.com', '2026-10-04T10:00:00+08:00', 'tagged', [['1', '0', 'src/a.ts']], '', 'HEAD -> main, tag: v0.1.9')}`,
        10,
      ).commits[0].refs,
    ) === JSON.stringify(['main', 'tag: v0.1.9']),
    JSON.stringify(
      parseLogWindow(
        `${record('r1', 'Ada', 'ada@example.com', '2026-10-04T10:00:00+08:00', 'tagged', [['1', '0', 'src/a.ts']], '', 'HEAD -> main, tag: v0.1.9')}`,
        10,
      ).commits[0].refs,
    ),
  );
}
