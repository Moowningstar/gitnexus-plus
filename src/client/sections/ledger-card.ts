import { MUTED, SOFT_BG, StateDot, Tag, h } from '../primitives';
import type { ClientLedgerPayload } from '../types';

/**
 * The session ledger card: what changed in this dirty window, and how often.
 *
 * Three empty states, and the card must not blur them — the same rule the risk card was
 * built under. "No window yet" is a clean tree; "not watching" is a tracker that could
 * not start, usually because the index is unusable; "route missing" is a host older than
 * this feature. Only the first one is about the code. Writing all three as 「暂无改动」
 * would let a broken tracker look like a clean tree, which is the one claim this card
 * must never fake.
 *
 * The window is frozen when it closes, and the card keeps showing it: "what did this
 * session change" is asked after the work stops, which is exactly when a dropped window
 * would be most missed.
 */
export function LedgerSection({
  payload,
  route,
  error,
}: {
  payload: ClientLedgerPayload | null;
  /** Whether the host mounted `/api/gitnexus/ledger`; `missing` is named, not swallowed. */
  route: 'unknown' | 'ready' | 'missing';
  error: string | null;
}) {
  const ledger = payload?.ledger ?? null;
  const counts = ledger?.counts ?? null;
  const live = ledger !== null && ledger.closedAt === null;

  const headline =
    route === 'missing'
      ? '宿主未挂载账本路由'
      : payload === null
        ? '读取中…'
        : payload.tracking === false
          ? '未在监听'
          : ledger === null
            ? '本窗还没有改动'
            : live
              ? '本窗进行中'
              : closeLabel(ledger.closeReason);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
      h(StateDot, {
        state: route === 'missing' || payload?.tracking === false ? 'idle' : counts === null ? 'idle' : 'done',
      }),
      h('span', { style: { fontWeight: 600 } }, headline),
      payload === null ? null : h(Tag, { tone: 'outline' }, payload.tracking ? '追踪中' : '未追踪'),
      ledger === null || ledger.evidence === 'hash'
        ? null
        : h(Tag, { tone: 'outline' }, '尚未核对'),
      ledger !== null && ledger.truncated ? h(Tag, { tone: 'outline' }, '已截断') : null,
    ),

    route === 'missing'
      ? h(
          'div',
          { style: MUTED },
          '当前宿主没有 GET /api/gitnexus/ledger，会话账本不可用。重启 DSH 后加载新版本即可；工具与文本输出不受影响。',
        )
      : null,

    error === null
      ? null
      : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, error),

    payload?.degraded !== null && payload?.degraded !== undefined
      ? h('div', { style: MUTED }, payload.degraded)
      : null,

    // `tracking: false` with no window is not a clean tree: say which it is.
    payload !== null && payload.tracking === false && ledger === null
      ? h('div', { style: MUTED }, '没有窗口可以显示，因为追踪器没有起来——这不是“没有改动”。')
      : null,

    payload !== null && payload.tracking !== false && ledger === null
      ? h('div', { style: MUTED }, '工作树是干净的。第一次改动会开一个新窗口，提交、刷新或长时间空闲会关窗。')
      : null,

    counts === null
      ? null
      : h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', ...MUTED } },
          h('span', null, `改 ${counts.modified}`),
          h('span', null, `新增 ${counts.added}`),
          h('span', null, `删除 ${counts.deleted}`),
          counts.unindexed > 0 ? h('span', null, `不在索引 ${counts.unindexed}`) : null,
          ledger !== null && ledger.excluded > 0 ? h('span', null, `被策略排除 ${ledger.excluded}`) : null,
        ),

    ledger === null || ledger.files.length === 0 ? null : filesBlock(ledger.files),

    ledger !== null && ledger.evidence === 'pending'
      ? h('div', { style: MUTED }, '这条记录里还有没核对内容的改动：看到写入，但还没和索引比过哈希。')
      : null,

    payload !== null && payload.pending.length > 0
      ? h(
          'div',
          { style: MUTED },
          `刚写入、尚未计入：${payload.pending.slice(0, 5).join('、')}${payload.pending.length > 5 ? '…' : ''}`,
        )
      : null,

    ledger !== null && ledger.truncated
      ? h('div', { style: MUTED }, `本窗改动超过 ${ledger.files.length} 个文件，只保留最近的一部分；计数是完整的。`)
      : null,
  );
}

function closeLabel(reason: 'clean' | 'head' | 'idle' | null): string {
  switch (reason) {
    case 'clean':
      return '本窗已结束（工作树干净）';
    case 'head':
      return '本窗已结束（已提交）';
    case 'idle':
      return '本窗已冻结（长时间无改动）';
    default:
      return '本窗已结束';
  }
}

function filesBlock(files: NonNullable<ClientLedgerPayload['ledger']>['files']) {
  // The interesting file is the one edited more than once; a flat list of twenty paths
  // says less than six paths plus the repeat count.
  const ordered = [...files].sort((a, b) => (a.changes === b.changes ? 0 : a.changes < b.changes ? 1 : -1));
  const head = ordered.slice(0, 6);
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...MUTED } },
    ...head.map((file) =>
      h(
        'div',
        { key: file.path, style: { display: 'flex', gap: '8px', background: SOFT_BG } },
        h('span', { style: { fontSize: '11px' } }, kindMark(file.kind)),
        h('span', null, file.path),
        file.changes > 1 ? h('span', null, `×${file.changes}`) : null,
        file.inIndex ? null : h('span', null, '不在索引'),
      ),
    ),
    files.length > head.length
      ? h('div', null, `…还有 ${files.length - head.length} 个文件`)
      : null,
  );
}

function kindMark(kind: 'modified' | 'added' | 'deleted'): string {
  switch (kind) {
    case 'added':
      return '+';
    case 'deleted':
      return '−';
    default:
      return '~';
  }
}
