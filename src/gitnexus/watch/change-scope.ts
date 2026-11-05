/**
 * The one line the system prompt carries about the change set.
 *
 * This used to be assembled inline in `src/index.ts` from whichever tracker had a non-empty
 * change set first, with no subject. Measured consequence: an agent working in a clean
 * checkout was told "8 改、92 增、90 删；3 处确定断裂" about a different project that happened
 * to be tracked, and had no way to tell which repository the sentence described.
 *
 * The plugin cannot know the session's directory — the plugin config has no workspace root,
 * and the sandbox resolves `process.cwd()`, which is the DSH install — so the sentence does
 * not claim "this is / isn't your project". It names the repository instead, and picks the
 * tracker whose change set was read most recently when several are dirty.
 *
 * Kept pure and separate from the registry so the selection and the wording can be tested
 * without a filesystem: the interesting rules are "newest deltaAt wins" and "a clean
 * tracker contributes nothing".
 */

import path from 'node:path';
import type { DeltaReport } from '../delta.js';
import type { RiskReport } from '../risk.js';

/** The fields of a tracker snapshot this line reads. */
export interface ChangeScopeSnapshot {
  repoPath: string;
  delta: DeltaReport | null;
  deltaAt: string | null;
  risk: RiskReport | null;
}

/**
 * @returns one line naming the repository whose change set is described, or `''` when no
 * tracker has an actionable change set. An empty string is the normal answer on a clean
 * tree: repeating "no changes" on every turn trains the model to ignore the line.
 */
export function describeChangeScope(snapshots: readonly ChangeScopeSnapshot[]): string {
  let chosen: ChangeScopeSnapshot | null = null;
  let chosenAt = '';
  for (const snapshot of snapshots) {
    const delta = snapshot.delta;
    if (delta === null || delta.comparable !== true) continue;
    const counts = delta.counts;
    if (counts.modified + counts.added + counts.deleted === 0) continue;
    const at = typeof snapshot.deltaAt === 'string' ? snapshot.deltaAt : '';
    if (chosen === null || at > chosenAt) {
      chosen = snapshot;
      chosenAt = at;
    }
  }
  if (chosen === null) return '';

  const delta = chosen.delta;
  if (delta === null) return '';
  const counts = delta.counts;
  const risk = chosen.risk;
  const tail =
    risk !== null && risk.evaluated
      ? `；结构上 ${risk.counts.broken} 处确定断裂、${risk.counts.exposed} 处暴露（不是编译结论）`
      : '；依赖影响还没有评估';
  const name = path.basename(chosen.repoPath) || chosen.repoPath;
  return (
    `改动集（${name}）：${counts.modified} 改、${counts.added} 增、${counts.deleted} 删${tail}。` +
    '改被多处引用的文件之前，先用 gitnexus_risk 看辐射范围。'
  );
}
