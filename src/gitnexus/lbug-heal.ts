/**
 * The one store defect the plugin repairs on its own: a stale `.shadow` sidecar.
 *
 * LadybugDB writes `<db>.shadow` while a checkpoint is being applied. A process
 * killed mid-checkpoint leaves that file behind, and from then on *every* open —
 * read-only or read-write, in this process or a child — fails inside the native
 * engine with
 *
 *   Found shadow file <path>.shadow but no corresponding database file
 *
 * before the engine's own recovery can classify it. The engine's writable
 * preflight only quarantines sidecars it can reach, and its read-only path runs
 * with `allowQuarantine: false` on purpose, so a read path cannot clean this up
 * by itself: the card stays broken until someone either deletes the sidecar or
 * runs `gitnexus analyze --force`.
 *
 * Moving the sidecar aside is enough. Once it is gone, GitNexus' own
 * `quarantineWalForMissingShadow` recovery takes over, parks the orphan WAL and
 * resumes from the last checkpoint — measured on 1.6.13-rc.159: the store then
 * answers normally and recreates nothing.
 */

import { renameSync } from 'node:fs';

/** Native text for "there is a shadow file whose database is gone". */
const SHADOW_PATTERN = /Found shadow file/i;
const ORPHAN_PATTERN = /no corresponding database file/i;

/**
 * Whether a failure message is the stale-shadow refusal.
 *
 * Both halves are required: "Found shadow file" alone also appears in the message
 * that explains how to remove a *live* shadow, which must not be touched.
 */
export function isOrphanShadowError(message: string): boolean {
  return SHADOW_PATTERN.test(message) && ORPHAN_PATTERN.test(message);
}

/**
 * Park `dbPath + '.shadow'` next to itself so the next open can proceed.
 *
 * Renamed rather than deleted: the file is the only record of an interrupted
 * checkpoint, and keeping it costs one ~1 MB file that the operator can throw away.
 *
 * @returns the parked path, or `null` when there was nothing to move (no sidecar,
 *   or a rename the platform refused) — callers must only retry on a non-null result.
 */
export function quarantineOrphanShadow(dbPath: string, stamp: number = Date.now()): string | null {
  const shadow = `${dbPath}.shadow`;
  const parked = `${shadow}.orphan-${stamp}`;
  try {
    renameSync(shadow, parked);
    return parked;
  } catch {
    return null;
  }
}
