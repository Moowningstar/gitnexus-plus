/**
 * The freshness sentence: what a caller is told about an index before trusting it.
 *
 * This suite needs no git and no repository. `describeStaleness` takes the delta report as
 * its input — the same object the gate and the route already produce — so every branch is
 * a pure function of a literal. That is the point of the split: the wording rules are the
 * contract, and they should not be testable only on a machine with a dirty tree.
 */

import { check, section } from '../harness.mjs';

/** A report in the shape the engine emits, with only the fields this module reads. */
function report(patch) {
  return {
    indexed: true,
    comparable: true,
    basis: 'index',
    indexedCommit: 'abcdef0123456789',
    headCommit: 'abcdef0123456789',
    counts: { modified: 0, added: 0, deleted: 0 },
    needsRefresh: false,
    certain: true,
    truncated: false,
    notes: [],
    advice: { tier: 'none', label: '', reason: '' },
    ...patch,
  };
}

export async function freshnessTests() {
  section('freshness: one sentence a graph tool can prepend');
  const { describeStaleness } = await import('../../lib/gitnexus/freshness.js');

  check('a clean index says nothing at all', describeStaleness(report({})) === null);
  check(
    'a repository with no index says nothing either (the tool already does)',
    describeStaleness(report({ indexed: false, comparable: false })) === null,
  );
  check(
    'a report the engine could not compare is "unknown", never "stale"',
    (() => {
      const text = describeStaleness(
        report({ comparable: false, notes: ['索引没有记录可用的提交基线：只比较了工作区相对 HEAD 的改动。'] }),
      );
      return (
        text !== null &&
        text.includes('索引新鲜度无法确认') &&
        text.includes('基线') &&
        !text.includes('索引落后')
      );
    })(),
  );

  const stale = describeStaleness(
    report({
      needsRefresh: true,
      counts: { modified: 2, added: 1, deleted: 0 },
      advice: { tier: 'incremental', label: '增量刷新', reason: '只有改动过的文件需要重新读' },
    }),
  );
  check(
    'a stale index names the commit, the count and the breakdown',
    stale !== null &&
      stale.includes('索引落后') &&
      stale.includes('abcdef0') &&
      stale.includes('3 个文件已改') &&
      stale.includes('2 改 / 1 增 / 0 删'),
    String(stale),
  );
  check('the engine advice becomes a suggestion', stale !== null && stale.includes('建议增量刷新'), String(stale));
  check('the sentence ends like a sentence', stale !== null && stale.endsWith('。'), String(stale));

  check(
    'a capped candidate set says the count is a floor',
    (() => {
      const text = describeStaleness(
        report({ needsRefresh: true, truncated: true, counts: { modified: 4000, added: 0, deleted: 0 } }),
      );
      return text !== null && text.includes('候选文件已截断');
    })(),
  );

  check(
    'with no advice label there is no dangling 建议',
    (() => {
      const text = describeStaleness(report({ needsRefresh: true, counts: { modified: 1, added: 0, deleted: 0 } }));
      return text !== null && !text.includes('建议') && text.includes('以下结果可能过期');
    })(),
  );

  check(
    'a worktree-only comparison does not name a commit it never used',
    (() => {
      const text = describeStaleness(
        report({
          basis: 'worktree',
          indexedCommit: null,
          needsRefresh: true,
          counts: { modified: 1, added: 0, deleted: 0 },
        }),
      );
      return text !== null && text.includes('没有可记录的提交基线') && !text.includes('自 未知提交');
    })(),
  );

  check(
    'a clean verdict from a partial walk is not a clean verdict',
    (() => {
      const text = describeStaleness(report({ certain: false, notes: ['比较在 4000 个候选处停下。'] }));
      return text !== null && text.includes('索引新鲜度无法确认') && text.includes('停下');
    })(),
  );

  check(
    'a report missing the fields entirely falls back to silence',
    describeStaleness({ comparable: true, needsRefresh: false, counts: { checked: 0 }, notes: [] }) === null,
  );
  check('a null report falls back to silence', describeStaleness(null) === null);
}
