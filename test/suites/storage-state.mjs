/**
 * The storage state: which claim about `.gitnexus` the plugin is entitled to make.
 *
 * Five of the seven states are upstream's own vocabulary (`missing`, `empty`, `owned`,
 * `unowned`, `foreign`, `invalid_storage`), and the sixth is ours (`unknown`, for a
 * directory that could not be read — an absence of information, not a malformed store).
 * Before this existed, the plugin asked "is there a `gitnexus.json`?", which answered
 * `foreign` as owned and `unowned` as "no index" — so the panel offered 「初始化索引」,
 * the one operation GitNexus refuses in that state.
 *
 * The decision is split from the inspection so every branch is a literal. The disk half
 * below builds each shape with `mkdir`/`writeFile` only: no git, no index, no LadybugDB.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, section } from '../harness.mjs';
import {
  decideStorageState,
  inspectStorage,
  readStorageState,
  storageIsUsable,
} from '../../lib/gitnexus/storage-state.js';
import { formatReport } from '../../lib/gitnexus/format.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** A manifest probe in the shape `probeManifest` returns. */
function probe(patch = {}) {
  return { state: 'absent', repoPath: null, storagePath: null, reason: null, ...patch };
}

/** An inspection with the two absolute paths this machine would use. */
function inspection(patch = {}) {
  const repoPath = path.resolve('C:\\probe\\repo');
  return {
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
    directory: 'present',
    entries: [],
    hasCodeIndexDB: false,
    primary: probe(),
    legacy: probe(),
    repositoryLocal: true,
    ...patch,
  };
}

/** A coverage report with only the fields `formatReport` reads on the header path. */
function report(patch = {}) {
  return {
    repo: {
      path: 'C:\\probe\\repo',
      name: 'repo',
      storagePath: 'C:\\probe\\repo\\.gitnexus',
      indexed: false,
      hasGit: true,
      registered: false,
      metaFile: null,
      indexedAt: null,
      lastCommit: null,
      branch: null,
      remoteUrl: null,
      stats: null,
      graphEmbeddings: null,
    },
    cap: { text: '512 KB', source: 'default' },
    totals: {
      scanned: 1,
      selected: 1,
      indexedInGraph: 1,
      large: 0,
      suppressedDeclarations: 0,
      largeBytes: 0,
    },
    analyzer: { gitnexusVersion: '1.6.13' },
    staleness: null,
    graph: null,
    capabilities: {},
    largeFiles: [],
    languages: null,
    warnings: [],
    ...patch,
  };
}

export async function storageStateTests() {
  section('storage state: the pure decision table');

  check(
    'no directory is missing, not empty',
    decideStorageState(inspection({ directory: 'missing' })).state === 'missing',
    decideStorageState(inspection({ directory: 'missing' })).state,
  );

  check(
    'an unreadable directory is unknown, not malformed',
    decideStorageState(inspection({ directory: 'unreadable' })).state === 'unknown',
    decideStorageState(inspection({ directory: 'unreadable' })).reason,
  );

  // The distinction the whole module exists for: lock artifacts only is a clean slate,
  // anything else without a manifest is the state analyze refuses.
  const empty = decideStorageState(inspection({ entries: ['.gitignore', 'analyze.lock'] }));
  check('lock artifacts only, no manifest: empty', empty.state === 'empty', `${empty.state} / ${empty.reason}`);
  check('empty is not usable', empty.usable === false, String(empty.usable));

  const unowned = decideStorageState(inspection({ entries: ['lbug', 'plugin-home'], hasCodeIndexDB: true }));
  check(
    'data without a manifest is unowned, not unindexed',
    unowned.state === 'unowned' && unowned.reason === 'Storage directory contains data but no valid ownership metadata.',
    `${unowned.state} / ${unowned.reason}`,
  );
  check('unowned is not usable', unowned.usable === false, String(unowned.usable));

  const ownRepo = path.resolve('C:\\probe\\repo');
  const owned = decideStorageState(
    inspection({ primary: probe({ state: 'valid', repoPath: ownRepo }) }),
  );
  check('a manifest naming this repository is owned', owned.state === 'owned' && owned.usable, owned.state);
  check('owned reports which manifest proved it', owned.manifest === 'gitnexus.json', String(owned.manifest));

  const ownedStorage = decideStorageState(
    inspection({
      primary: probe({ state: 'valid', repoPath: ownRepo, storagePath: path.join(ownRepo, '.gitnexus') }),
    }),
  );
  check('a manifest naming this storage directory too is still owned', ownedStorage.state === 'owned', ownedStorage.state);

  // A moved checkout leaves a manifest that names the old path. Reading as owned meant
  // the write guards happily wrote into a store belonging to somebody else.
  const moved = decideStorageState(
    inspection({ primary: probe({ state: 'valid', repoPath: path.resolve('C:\\probe\\old-checkout') }) }),
  );
  check(
    'a manifest naming another checkout is foreign',
    moved.state === 'foreign' && moved.foreignRepoPath === path.resolve('C:\\probe\\old-checkout'),
    `${moved.state} / ${moved.foreignRepoPath}`,
  );
  check('foreign is not usable', moved.usable === false, String(moved.usable));

  const movedStorage = decideStorageState(
    inspection({
      primary: probe({ state: 'valid', repoPath: ownRepo, storagePath: path.resolve('C:\\probe\\shared') }),
    }),
  );
  check(
    'a manifest naming another storage directory is foreign',
    movedStorage.state === 'foreign' && movedStorage.foreignStoragePath === path.resolve('C:\\probe\\shared'),
    `${movedStorage.state} / ${movedStorage.foreignStoragePath}`,
  );

  // Order matters upstream: a malformed current manifest is reported before the legacy
  // file is consulted, so a valid `meta.json` must not mask a broken `gitnexus.json`.
  const brokenPrimary = decideStorageState(
    inspection({
      primary: probe({ state: 'invalid', reason: 'gitnexus.json is not valid JSON.' }),
      legacy: probe({ state: 'valid', repoPath: ownRepo }),
    }),
  );
  check(
    'a broken current manifest wins over a valid legacy one',
    brokenPrimary.state === 'invalid_storage' && brokenPrimary.reason === 'gitnexus.json is not valid JSON.',
    `${brokenPrimary.state} / ${brokenPrimary.reason}`,
  );

  const brokenLegacy = decideStorageState(
    inspection({ legacy: probe({ state: 'invalid', reason: 'meta.json must contain a JSON object.' }) }),
  );
  check('a broken legacy manifest is invalid_storage too', brokenLegacy.state === 'invalid_storage', brokenLegacy.state);

  const legacyOwned = decideStorageState(
    inspection({ legacy: probe({ state: 'valid', repoPath: ownRepo }) }),
  );
  check(
    'a legacy meta.json still proves ownership',
    legacyOwned.state === 'owned' && legacyOwned.manifest === 'meta.json',
    `${legacyOwned.state} / ${legacyOwned.manifest}`,
  );

  // A manifest that cannot be read is not a verdict about its content.
  const unreadableManifest = decideStorageState(
    inspection({ primary: probe({ state: 'unreadable', reason: 'gitnexus.json could not be read: EACCES' }) }),
  );
  check(
    'an unreadable manifest is unknown, not invalid_storage',
    unreadableManifest.state === 'unknown',
    `${unreadableManifest.state} / ${unreadableManifest.reason}`,
  );

  // Hand-written and older manifests may carry no repoPath. Upstream calls that invalid;
  // blocking a store that used to open would be a regression, so it is owned-but-unproven.
  const unbound = decideStorageState(inspection({ primary: probe({ state: 'valid' }) }));
  check(
    'a manifest with no repoPath is owned but says ownership was not verified',
    unbound.state === 'owned' && /no repoPath/.test(`${unbound.reason}`),
    `${unbound.state} / ${unbound.reason}`,
  );

  const external = decideStorageState(
    inspection({
      repositoryLocal: false,
      primary: probe({ state: 'valid', repoPath: ownRepo }),
    }),
  );
  check('a non-local store with no storagePath binding is unowned', external.state === 'unowned', external.state);

  check(
    'the graph store flag is reported with the state',
    decideStorageState(inspection({ entries: ['lbug'], hasCodeIndexDB: true })).hasCodeIndexDB === true,
    'hasCodeIndexDB survived',
  );

  section('storage state: read off a real directory');

  const root = await mkdtemp(path.join(os.tmpdir(), 'gnp-storage-state-'));
  try {
    check('a directory with no .gitnexus is missing', readStorageState(root).state === 'missing', root);

    const storage = path.join(root, '.gitnexus');
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(storage, '.gitignore'), '*\n');
    await writeFile(path.join(storage, 'analyze.lock'), '');
    const emptyState = readStorageState(root);
    check('lock artifacts only read as empty', emptyState.state === 'empty', emptyState.state);

    await mkdir(path.join(storage, 'lbug'), { recursive: true });
    check('a graph directory with no manifest reads as unowned', readStorageState(root).state === 'unowned', 'lbug only');

    await writeFile(path.join(storage, 'gitnexus.json'), JSON.stringify({ repoPath: root, lastCommit: 'abc1234' }));
    const ownedState = readStorageState(root);
    check('a manifest naming this root reads as owned', ownedState.state === 'owned' && ownedState.usable, ownedState.state);
    check('the storage guard agrees with the state', storageIsUsable(root) === true, 'usable');

    await writeFile(
      path.join(storage, 'gitnexus.json'),
      JSON.stringify({ repoPath: path.resolve(path.join(root, '..', 'somewhere-else')) }),
    );
    const movedState = readStorageState(root);
    check('a manifest naming another root reads as foreign', movedState.state === 'foreign', movedState.state);
    check('a foreign store is refused by the write guard', storageIsUsable(root) === false, 'not usable');

    await writeFile(path.join(storage, 'gitnexus.json'), '{ not json');
    check(
      'an unparseable manifest reads as invalid_storage',
      readStorageState(root).state === 'invalid_storage',
      readStorageState(root).reason,
    );

    // The inspected shape must agree with the pure decision for the same bytes.
    check(
      'inspect → decide equals readStorageState',
      decideStorageState(inspectStorage(root)).state === readStorageState(root).state,
      'same state',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  section('storage state: what the text output says');

  const missingText = formatReport(report());
  check(
    'a repo with no index still says NOT FOUND and names analyze',
    missingText.includes('NOT FOUND') && missingText.includes('gitnexus analyze'),
    missingText.split('\n')[0],
  );

  const unownedText = formatReport(
    report({ repo: { ...report().repo, storage: { state: 'unowned', manifest: null, hasCodeIndexDB: true, usable: false, foreignRepoPath: null, foreignStoragePath: null, reason: null } } }),
  );
  check(
    'an unowned store is BLOCKED and names 全量重建, not 初始化',
    unownedText.includes('BLOCKED (unowned)') && unownedText.includes('全量重建') && !unownedText.includes('初始化'),
    unownedText.split('\n')[0],
  );

  const foreignText = formatReport(
    report({
      repo: {
        ...report().repo,
        storage: {
          state: 'foreign',
          manifest: 'gitnexus.json',
          hasCodeIndexDB: true,
          usable: false,
          foreignRepoPath: 'C:\\probe\\old',
          foreignStoragePath: null,
          reason: null,
        },
      },
    }),
  );
  check(
    'a foreign store names the checkout that wrote it',
    foreignText.includes('BLOCKED (foreign)') && foreignText.includes('C:\\probe\\old'),
    foreignText.split('\n')[2],
  );

  const invalidText = formatReport(
    report({
      repo: {
        ...report().repo,
        storage: {
          state: 'invalid_storage',
          manifest: null,
          hasCodeIndexDB: false,
          usable: false,
          foreignRepoPath: null,
          foreignStoragePath: null,
          reason: 'gitnexus.json is not valid JSON.',
        },
      },
    }),
  );
  check(
    'an invalid manifest reports the parse reason',
    invalidText.includes('BLOCKED (invalid_storage)') && invalidText.includes('not valid JSON'),
    invalidText.split('\n')[2],
  );

  // Reports assembled before `storage` existed say `indexed: true`; they must keep
  // rendering as an index rather than falling into the blocked branch.
  const legacyText = formatReport(report({ repo: { ...report().repo, indexed: true, indexedAt: '2026-01-01T00:00:00Z' } }));
  check(
    'a report with no storage field but indexed:true still renders as an index',
    legacyText.includes('GitNexus coverage') && !legacyText.includes('BLOCKED'),
    legacyText.split('\n')[0],
  );
}
