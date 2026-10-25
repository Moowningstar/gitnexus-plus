/**
 * Index anchoring: giving a sandbox-built index the commit baseline the analyzer cannot record.
 *
 * Two groups. The predicate and "nothing safe to write" cases need no git and always run; the
 * write-back cases need a real repository, so they are skipped with the same wording the delta
 * suite uses when git cannot be spawned.
 */

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captureGit } from '../../lib/gitnexus/git-capture.js';
import { check, fixturePath, section } from '../harness.mjs';

/**
 * Build fixtures through the same file-descriptor capture the engine uses: a plain
 * `execFile` fails with `spawn EPERM` in a confined host (the pipe, not git), which would
 * silently turn every write-back case into a skip.
 */
async function gitIn(cwd, args) {
  const result = await captureGit(cwd, args, { timeoutMs: 30_000 });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.failure}`);
  return result.text;
}

/** A manifest in the shape GitNexus writes: pretty-printed, one `lastCommit` field. */
function manifestText(patch = {}) {
  return `${JSON.stringify(
    {
      repoPath: '',
      storagePath: '',
      lastCommit: '',
      indexedAt: '2026-01-01T00:00:00.000Z',
      branch: 'main',
      stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0, embeddings: 0 },
      capabilities: { graph: { engine: 'ladybugdb', status: 'available' } },
      fileHashes: { 'src/a.ts': 'deadbeef' },
      ...patch,
    },
    null,
    2,
  )}\n`;
}

async function writeManifest(root, patch = {}) {
  await fs.mkdir(path.join(root, '.gitnexus'), { recursive: true });
  const file = path.join(root, '.gitnexus', 'gitnexus.json');
  await fs.writeFile(file, manifestText(patch));
  return file;
}

/** A repository with one commit; returns the sha. */
async function initRepo(root) {
  const identity = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid'];
  const git = (args) => gitIn(root, args);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(['init', '-q']);
  await git([...identity, 'add', '-A']);
  await git([...identity, 'commit', '-q', '-m', 'fixture']);
  return (await git(['rev-parse', 'HEAD'])).trim();
}

/** Whether git can be spawned at all — a sandbox property, not an engine one. */
async function gitSpawnable() {
  try {
    return (await captureGit(process.cwd(), ['--version'], { timeoutMs: 10_000 })).ok;
  } catch {
    return false;
  }
}

export async function managedPathTests() {
  section('anchor: which paths GitNexus owns');
  const { isGitNexusManagedPath, GITNEXUS_MANAGED_PATHS } = await import(
    '../../lib/gitnexus/managed-paths.js'
  );

  check(
    'the managed list covers the six roots upstream excludes',
    GITNEXUS_MANAGED_PATHS.length === 6 &&
      ['.gitnexus', '.claude', '.cursor', '.agents', 'AGENTS.md', 'CLAUDE.md'].every((name) =>
        GITNEXUS_MANAGED_PATHS.includes(name),
      ),
    GITNEXUS_MANAGED_PATHS.join(', '),
  );
  check('AGENTS.md itself is managed', isGitNexusManagedPath('AGENTS.md'));
  check('a file beneath a managed directory is managed', isGitNexusManagedPath('.claude/skills/x.md'));
  check(
    'Windows separators are normalized before matching',
    isGitNexusManagedPath('.cursor\\rules\\a.mdc') === true,
  );
  check(
    'a sibling sharing the prefix is not managed',
    isGitNexusManagedPath('AGENTS.md.bak') === false &&
      isGitNexusManagedPath('.clauderc') === false,
  );
  check(
    'the name only counts at the repository root',
    isGitNexusManagedPath('src/AGENTS.md') === false,
  );
  check(
    'paths are matched as data, not handed to git as pathspecs',
    // A pathspec string would have to go through `git` again; the callers filter the
    // output instead, so a `.claude` root and a `.claude/x` child both land here.
    isGitNexusManagedPath('.claude') === true && isGitNexusManagedPath('.claude/x') === true,
  );
}

export async function anchorTests() {
  const { anchorIndex } = await import('../../lib/gitnexus/anchor.js');

  // Nothing to anchor, and every one of these must leave the manifest byte-identical: the
  // only failure mode that matters is writing a commit that is not true.
  {
    const root = fixturePath('anchor-no-git');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });

    const missing = await anchorIndex(root);
    check(
      'no manifest is reported, not treated as an error',
      missing.verdict === 'skipped' && missing.message.includes('没有找到索引清单'),
      missing.message,
    );

    const file = await writeManifest(root);
    const before = await fs.readFile(file, 'utf8');
    const noGit = await anchorIndex(root);
    check(
      'a folder without git is not told it is missing a baseline',
      noGit.verdict === 'no-git' && noGit.message.includes('没有 git 仓库'),
      noGit.message,
    );
    check('nothing was written for the no-git case', (await fs.readFile(file, 'utf8')) === before);

    // Even a repository that does have `.git` must not be anchored when the run indexed it
    // with `--skip-git`: GitNexus itself disabled commit tracking for that index.
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const skipGit = await anchorIndex(root, { skipGit: true });
    check(
      '--skip-git wins over the presence of .git',
      skipGit.verdict === 'no-git' && skipGit.message.includes('--skip-git'),
      skipGit.message,
    );

    const already = await anchorIndex(root, { skipGit: true });
    await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
    await fs.writeFile(file, manifestText({ lastCommit: 'A'.repeat(40) }));
    const recorded = await anchorIndex(root);
    check(
      'a manifest that already records a commit is left alone',
      recorded.verdict === 'already' && recorded.commit === 'A'.repeat(40),
      JSON.stringify(recorded),
    );
    check(
      'and it says so without claiming to have written anything',
      recorded.message.includes('无需改动') && recorded.targets.length === 0,
      recorded.message,
    );
    check('the skip-git check did not write anything either', already.targets.length === 0);

    await fs.rm(root, { recursive: true, force: true });
  }

  if (!(await gitSpawnable())) {
    check(
      'anchor write-back tests run (skipped: git cannot be spawned in this sandbox)',
      true,
      'covered by the unconfined run',
    );
    return;
  }

  // The main path: a clean repository, a manifest with an empty baseline, and a commit that
  // belongs in it. The write is byte-level, so the rest of the file must survive verbatim.
  {
    const root = path.join(fixturePath('anchor-clean'), '');
    await fs.rm(root, { recursive: true, force: true });
    const head = await initRepo(root);
    const file = await writeManifest(root);
    const before = await fs.readFile(file, 'utf8');

    // The registry home lives beside the repository, not inside it: an uncommitted
    // `home/registry.json` in the tree would make every fixture dirty and blur what the
    // test is actually proving.
    const home = fixturePath('anchor-clean-home');
    await fs.rm(home, { recursive: true, force: true });
    await fs.mkdir(home, { recursive: true });
    // Deliberately ugly formatting: four-space entries, a field order upstream does not
    // use, and one field upstream never writes. Re-serializing this file would be
    // visible, and "we do not own the registry, we only fill one blank in it" is the
    // property being asserted.
    const registryFile = path.join(home, 'registry.json');
    const registryText = [
      '[',
      `    {"name": "this", "path": ${JSON.stringify(root)}, "storagePath": ${JSON.stringify(path.join(root, '.gitnexus'))}, "lastCommit": "", "indexedAt": "x", "stats": {}, "extra": {"note": "kept"}},`,
      `    {"name": "other", "path": ${JSON.stringify(path.join(root, '..', 'elsewhere'))}, "storagePath": "y", "lastCommit": "", "indexedAt": "x", "stats": {}}`,
      ']',
      '',
    ].join('\n');
    await fs.writeFile(registryFile, registryText);

    const anchored = await anchorIndex(root, { gitnexusHome: home });
    const after = await fs.readFile(file, 'utf8');
    check(
      'a clean repository gets its commit written into the manifest',
      anchored.verdict === 'anchored' && anchored.commit === head,
      JSON.stringify(anchored),
    );
    check(
      'the manifest changed in exactly one place',
      after === before.replace('"lastCommit": ""', `"lastCommit": "${head}"`),
      after.slice(0, 200),
    );
    check('the rewritten manifest still parses', (() => {
      try {
        return JSON.parse(after).lastCommit === head;
      } catch {
        return false;
      }
    })());
    check(
      'the registry entry for this repository is updated and other entries are not',
      (() => {
        const entries = JSON.parse(readFileSync(registryFile, 'utf8'));
        return entries[0].lastCommit === head && entries[1].lastCommit === '' && entries[1].name === 'other';
      })(),
      registryFile,
    );
    check(
      'the registry keeps every byte it did not have to change',
      // One blank filled, everything else — indentation, field order, the unknown field —
      // exactly as its author left it.
      (await fs.readFile(registryFile, 'utf8')) ===
        registryText.replace('"lastCommit": ""', `"lastCommit": "${head}"`),
      (await fs.readFile(registryFile, 'utf8')).slice(0, 240),
    );
    check(
      'no temporary file is left behind',
      (await fs.readdir(path.join(root, '.gitnexus'))).every((name) => !name.includes('.anchor-')),
      (await fs.readdir(path.join(root, '.gitnexus'))).join(','),
    );

    // A second run must be a no-op rather than a rewrite of the commit it just recorded.
    const again = await anchorIndex(root, { gitnexusHome: home });
    check(
      'anchoring is idempotent',
      again.verdict === 'already' && (await fs.readFile(file, 'utf8')) === after,
      again.message,
    );

    await fs.rm(root, { recursive: true, force: true });
  }

  // Dirtiness is the reason the field exists: an index built from a modified tree contains
  // content that is not in HEAD, so recording HEAD would make the gate lie.
  {
    const root = path.join(fixturePath('anchor-dirty'), '');
    await fs.rm(root, { recursive: true, force: true });
    const head = await initRepo(root);
    const file = await writeManifest(root);
    const before = await fs.readFile(file, 'utf8');
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');

    const dirty = await anchorIndex(root);
    check(
      'a modified tracked file blocks the write',
      dirty.verdict === 'dirty' && dirty.dirtyCount === 1 && dirty.dirtyPaths[0] === 'src/a.ts',
      JSON.stringify(dirty),
    );
    check('the manifest is untouched when the tree is dirty', (await fs.readFile(file, 'utf8')) === before);
    check(
      'and the message says why, in terms of the gate',
      dirty.message.includes('没有写入提交基线') && dirty.message.includes('误报'),
      dirty.message,
    );

    // An untracked file is content HEAD does not have — and GitNexus indexes it.
    await fs.rm(path.join(root, 'src', 'a.ts'));
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    await fs.writeFile(path.join(root, 'src', 'new.ts'), 'export const n = 1;\n');
    const untracked = await anchorIndex(root);
    check(
      'an untracked file counts as dirty too',
      untracked.verdict === 'dirty' && untracked.dirtyPaths.includes('src/new.ts'),
      JSON.stringify(untracked.dirtyPaths),
    );

    // The refresh loop this plugin used to have: analyze regenerates AGENTS.md and the
    // `.claude` tree, so the tree looks dirty immediately after every refresh. Those are
    // written *by* the analyzer, so they must not block the baseline.
    const clean = path.join(fixturePath('anchor-managed'), '');
    await fs.rm(clean, { recursive: true, force: true });
    const cleanHead = await initRepo(clean);
    await writeManifest(clean);
    await fs.writeFile(path.join(clean, 'AGENTS.md'), '# regenerated\n');
    await fs.mkdir(path.join(clean, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(path.join(clean, '.claude', 'skills', 'x.md'), 'skill\n');
    const managedOnly = await anchorIndex(clean);
    check(
      'files GitNexus generates do not count as uncommitted changes',
      managedOnly.verdict === 'anchored' && managedOnly.commit === cleanHead,
      JSON.stringify(managedOnly),
    );

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(clean, { recursive: true, force: true });
  }

  // A manifest whose shape we do not recognize. Two blank `lastCommit` fields mean we
  // cannot tell which one the index wrote, and guessing would rewrite the wrong one — the
  // one field whose value has to be true for the gate to mean anything.
  {
    const root = path.join(fixturePath('anchor-ambiguous'), '');
    await fs.rm(root, { recursive: true, force: true });
    await initRepo(root);
    const file = await writeManifest(root, {
      nested: { lastCommit: '', note: 'looks like ours, is not' },
    });
    const before = await fs.readFile(file, 'utf8');
    const ambiguous = await anchorIndex(root);
    check(
      'two blank lastCommit fields are refused rather than guessed at',
      ambiguous.verdict === 'skipped' && ambiguous.message.includes('多处空白 lastCommit'),
      ambiguous.message,
    );
    check('the ambiguous manifest is left alone', (await fs.readFile(file, 'utf8')) === before);
    await fs.rm(root, { recursive: true, force: true });
  }

  // A repository with no commit at all: HEAD does not resolve, and there is nothing honest
  // to write.
  {
    const root = path.join(fixturePath('anchor-empty'), '');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await gitIn(root, ['init', '-q']);
    const file = await writeManifest(root);
    const before = await fs.readFile(file, 'utf8');
    const unborn = await anchorIndex(root);
    check(
      'a repository with no commits reports that, rather than anchoring',
      unborn.verdict === 'no-git' && unborn.message.includes('还没有提交'),
      unborn.message,
    );
    check('the unborn repository manifest is untouched', (await fs.readFile(file, 'utf8')) === before);
    await fs.rm(root, { recursive: true, force: true });
  }
}
