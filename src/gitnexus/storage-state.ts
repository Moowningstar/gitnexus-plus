/**
 * Which state a checkout's `.gitnexus` is in.
 *
 * GitNexus 1.6.13 inspects that directory before every write. A directory that holds
 * data but no ownership manifest is `unowned`, and `analyze` refuses it without naming
 * a remedy; a manifest written for another checkout is `foreign`; one that cannot be
 * parsed is `invalid_storage`. The plugin used to flatten all of that into "is there a
 * `gitnexus.json` or `meta.json`?", which made `foreign` look owned and made `unowned`
 * look like no index at all — the panel then offered 「初始化索引」, which is the one
 * operation upstream will not run.
 *
 * So this module keeps upstream's vocabulary (`missing`, `empty`, `owned`, `unowned`,
 * `foreign`, `invalid_storage`) and adds one state of its own: `unknown`. Upstream
 * reports a permission or IO failure while inspecting the directory as
 * `invalid_storage`, but those are different claims — "the bytes we read are not a
 * valid manifest" versus "we could not read the bytes". Only the first justifies
 * telling the user their store is malformed, so `unknown` is where unreadable stores
 * land, and it stays silent in warnings while still blocking writes.
 *
 * The decision is split from the inspection on purpose: `decideStorageState` is pure,
 * so the whole state table is testable without touching a disk.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePathKey } from './index-meta.js';

export type StorageState =
  | 'missing'
  | 'empty'
  | 'owned'
  | 'unowned'
  | 'foreign'
  | 'invalid_storage'
  | 'unknown';

/** The manifest GitNexus writes today. */
export const INDEX_METADATA_FILE = 'gitnexus.json';
/** The manifest older builds wrote; still accepted as ownership proof. */
export const LEGACY_METADATA_FILE = 'meta.json';
/** The LadybugDB directory inside `.gitnexus`. */
export const CODE_INDEX_DIR = 'lbug';

/**
 * The entries that are not index data.
 *
 * Upstream calls these lock artifacts and ignores them when deciding whether a
 * manifest-less directory is empty or unowned. `lbug` is deliberately absent: a store
 * with a graph and no manifest is exactly the unowned case.
 */
export const INDEX_LOCK_ARTIFACTS: ReadonlySet<string> = new Set([
  'analyze.lock',
  'analyze.lock.guard',
  'store.json',
  '.gitignore',
  'run.cjs',
]);

/** What one manifest file turned out to be. */
export interface StorageManifestProbe {
  state: 'absent' | 'valid' | 'invalid' | 'unreadable';
  /** Present only when `state === 'valid'`. */
  repoPath: string | null;
  /** Present only when `state === 'valid'` and the manifest recorded one. */
  storagePath: string | null;
  /** English, for logs and tests. */
  reason: string | null;
}

/** Everything `decideStorageState` needs, captured from disk. */
export interface StorageInspection {
  /** Absolute repository root that was inspected. */
  repoPath: string;
  /** Where the store should be for that root. */
  storagePath: string;
  directory: 'missing' | 'unreadable' | 'present';
  /** Names directly under `.gitnexus`; empty unless the directory was listed. */
  entries: string[];
  /** Whether the LadybugDB directory is there. */
  hasCodeIndexDB: boolean;
  primary: StorageManifestProbe;
  legacy: StorageManifestProbe;
  /**
   * Whether the store is the checkout's own `.gitnexus`.
   *
   * Always true here; kept as a parameter because upstream uses it to call a shared
   * store's bindingless manifest unowned, and the pure decision should stay able to
   * express that.
   */
  repositoryLocal: boolean;
}

export interface StorageStateReport {
  state: StorageState;
  /** Which manifest established the state, when one did. */
  manifest: 'gitnexus.json' | 'meta.json' | null;
  hasCodeIndexDB: boolean;
  /** `state === 'owned'`. The only state upstream lets a write proceed in. */
  usable: boolean;
  /** The `repoPath` the manifest named, when it named a different checkout. */
  foreignRepoPath: string | null;
  /** The `storagePath` the manifest named, when it named a different directory. */
  foreignStoragePath: string | null;
  reason: string | null;
}

const ABSENT: StorageManifestProbe = { state: 'absent', repoPath: null, storagePath: null, reason: null };

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function errorDetail(error: unknown): string {
  const e = error as NodeJS.ErrnoException | null;
  return e?.code ? `${e.code}: ${e.message}` : String(error);
}

/**
 * Read one manifest and decide whether it is a usable ownership proof.
 *
 * Mirrors upstream's validity ladder: JSON object, string `repoPath`, absolute paths,
 * string `storagePath` when present. A store whose manifest fails any of these is
 * `invalid_storage` — the file exists and we read it, the content is wrong.
 */
export function probeManifest(storagePath: string, name: string): StorageManifestProbe {
  const file = path.join(storagePath, name);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return isMissingError(error)
      ? ABSENT
      : {
          state: 'unreadable',
          repoPath: null,
          storagePath: null,
          reason: `${name} could not be read: ${errorDetail(error)}`,
        };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', repoPath: null, storagePath: null, reason: `${name} is not valid JSON.` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'invalid',
      repoPath: null,
      storagePath: null,
      reason: `${name} must contain a JSON object.`,
    };
  }

  const record = parsed as Record<string, unknown>;
  // A manifest without a usable `repoPath` is old or hand-written, not garbage: 1.6.12
  // wrote `meta.json` without one in some builds, and a store built then still opens.
  // Upstream's own resolver calls this `invalid_storage`, but its next step is a refusal
  // we do not have to copy — an unverifiable store is reported as owned-and-unverified
  // instead, which is what keeps an older checkout working rather than newly blocked.
  const rawRepoPath = typeof record.repoPath === 'string' && record.repoPath.trim() !== '' ? record.repoPath : null;
  if (rawRepoPath !== null && !path.isAbsolute(rawRepoPath)) {
    return {
      state: 'invalid',
      repoPath: null,
      storagePath: null,
      reason: `${name} contains a non-absolute repoPath.`,
    };
  }

  let storagePathValue: string | null = null;
  if (record.storagePath !== undefined) {
    if (typeof record.storagePath !== 'string') {
      return {
        state: 'invalid',
        repoPath: null,
        storagePath: null,
        reason: `${name} contains an invalid storagePath.`,
      };
    }
    if (!path.isAbsolute(record.storagePath)) {
      return {
        state: 'invalid',
        repoPath: null,
        storagePath: null,
        reason: `${name} contains a non-absolute storagePath.`,
      };
    }
    storagePathValue = record.storagePath;
  }

  return { state: 'valid', repoPath: rawRepoPath, storagePath: storagePathValue, reason: null };
}

/** Capture the directory and both manifests. Synchronous: the write guards are. */
export function inspectStorage(repoPath: string): StorageInspection {
  const root = path.resolve(repoPath);
  const storagePath = path.join(root, '.gitnexus');

  let entries: string[] = [];
  let directory: StorageInspection['directory'] = 'present';
  try {
    entries = readdirSync(storagePath);
  } catch (error) {
    directory = isMissingError(error) ? 'missing' : 'unreadable';
  }

  const inspectable = directory === 'present';
  return {
    repoPath: root,
    storagePath,
    directory,
    entries,
    hasCodeIndexDB: inspectable && entries.includes(CODE_INDEX_DIR),
    primary: inspectable ? probeManifest(storagePath, INDEX_METADATA_FILE) : ABSENT,
    legacy: inspectable ? probeManifest(storagePath, LEGACY_METADATA_FILE) : ABSENT,
    repositoryLocal: true,
  };
}

function report(
  state: StorageState,
  manifest: 'gitnexus.json' | 'meta.json' | null,
  hasCodeIndexDB: boolean,
  reason: string | null,
): StorageStateReport {
  return {
    state,
    manifest,
    hasCodeIndexDB,
    usable: state === 'owned',
    foreignRepoPath: null,
    foreignStoragePath: null,
    reason,
  };
}

/**
 * The pure decision.
 *
 * Order matters and matches upstream: a malformed current manifest is reported before
 * the legacy one is even consulted, and a missing pair of manifests is resolved by
 * whether the directory holds anything that is not a lock artifact.
 */
export function decideStorageState(inspection: StorageInspection): StorageStateReport {
  const { directory, entries, primary, legacy, repositoryLocal, repoPath, storagePath } = inspection;

  if (directory === 'missing') return report('missing', null, false, null);
  if (directory === 'unreadable') {
    return report('unknown', null, false, 'Storage directory could not be inspected.');
  }

  let manifest: 'gitnexus.json' | 'meta.json' | null = null;
  let source: StorageManifestProbe;

  if (primary.state === 'invalid') return report('invalid_storage', null, inspection.hasCodeIndexDB, primary.reason);
  if (primary.state === 'unreadable') {
    return report('unknown', null, inspection.hasCodeIndexDB, primary.reason);
  }
  if (primary.state === 'valid') {
    manifest = INDEX_METADATA_FILE;
    source = primary;
  } else {
    if (legacy.state === 'invalid') {
      return report('invalid_storage', null, inspection.hasCodeIndexDB, legacy.reason);
    }
    if (legacy.state === 'unreadable') {
      return report('unknown', null, inspection.hasCodeIndexDB, legacy.reason);
    }
    if (legacy.state === 'absent') {
      const hasNonLockEntries = entries.some((name) => !INDEX_LOCK_ARTIFACTS.has(name));
      return report(
        hasNonLockEntries ? 'unowned' : 'empty',
        null,
        inspection.hasCodeIndexDB,
        hasNonLockEntries
          ? 'Storage directory contains data but no valid ownership metadata.'
          : null,
      );
    }
    manifest = LEGACY_METADATA_FILE;
    source = legacy;
  }

  // A store whose manifest names another checkout — or another storage directory — is
  // another checkout's store. Compared before the unverifiable case, because a mismatch
  // is a positive statement and "no repoPath" is the absence of one.
  const repoMatches = source.repoPath !== null && normalizePathKey(source.repoPath) === normalizePathKey(repoPath);
  const storageMatches =
    source.storagePath !== null && normalizePathKey(source.storagePath) === normalizePathKey(storagePath);

  if ((source.repoPath !== null && !repoMatches) || (source.storagePath !== null && !storageMatches)) {
    const foreign = report(
      'foreign',
      manifest,
      inspection.hasCodeIndexDB,
      'Storage metadata identifies a different repository or storage directory.',
    );
    foreign.foreignRepoPath = source.repoPath !== null && !repoMatches ? source.repoPath : null;
    foreign.foreignStoragePath = source.storagePath !== null && !storageMatches ? source.storagePath : null;
    return foreign;
  }

  if (source.repoPath === null) {
    return report(
      'owned',
      manifest,
      inspection.hasCodeIndexDB,
      `${manifest} records no repoPath; ownership could not be verified.`,
    );
  }

  if (!repositoryLocal && source.storagePath === null) {
    return report(
      'unowned',
      manifest,
      inspection.hasCodeIndexDB,
      'External storage metadata does not bind the index to this storage directory.',
    );
  }

  return report('owned', manifest, inspection.hasCodeIndexDB, null);
}

/** Inspect a checkout and decide its storage state. */
export function readStorageState(repoPath: string): StorageStateReport {
  return decideStorageState(inspectStorage(repoPath));
}

/**
 * May this process write into the checkout's `.gitnexus`?
 *
 * Only `owned` qualifies. `foreign` is another checkout's store, `unowned` is the state
 * upstream refuses, and the rest leave nothing to write into.
 */
export function storageIsUsable(repoPath: string): boolean {
  return readStorageState(repoPath).usable;
}

/**
 * One sentence for a store nobody may build on.
 *
 * Named after `state` on purpose: the five states have four different remedy sentences
 * and merging them is how the panel ended up recommending 「初始化索引」 for a directory
 * that already contained data.
 */
export function describeBlockedStorage(storage: StorageStateReport): string {
  switch (storage.state) {
    case 'foreign':
      return (
        '索引存储不可用（foreign）：归属元数据记录的是另一个检出' +
        `${storage.foreignRepoPath ? `（${storage.foreignRepoPath}）` : ''}。` +
        '按当前检出使用前需要全量重建（--force）。'
      );
    case 'unowned':
      return (
        '索引存储不可用（unowned）：.gitnexus 里有数据但没有归属元数据，' +
        'GitNexus 会拒绝写入。只能全量重建（--force）。'
      );
    case 'invalid_storage':
      return (
        `索引存储不可用（invalid_storage）：归属元数据无法解析（${storage.reason ?? '内容无效'}）。` +
        '需要全量重建（--force）。'
      );
    case 'unknown':
      return (
        `索引存储状态未知：无法读取 .gitnexus（${storage.reason ?? '权限或 IO 失败'}）。` +
        '在能确认归属之前不会读图。'
      );
    case 'missing':
    case 'empty':
      return '该项目还没有 GitNexus 索引；初始化后才能看图。';
    case 'owned':
      return '索引存储可用。';
  }
}
