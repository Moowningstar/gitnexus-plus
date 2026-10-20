import * as React from 'react';
import { compactNumber } from '../format';
import { routeUrl } from '../navigation';
import { Button, HAIRLINE, MUTED, PathLabel, h, styles } from '../primitives';
import { ClientCommitDiff, ClientFileHistory } from '../types';

const ADDED = 'var(--dsw-alias-state-success-primary, #3fb950)';
const REMOVED = 'var(--dsw-alias-state-error-primary, #f85149)';
const HUNK = 'var(--dsw-alias-label-secondary, inherit)';

/**
 * One commit's patch, as unified diff lines.
 *
 * `+++`/`---` are file headers, not changed lines, so they are excluded from the colour
 * rule; colouring them would make every patch open with a false green and red.
 */
function DiffView({
  diff,
  busy,
  error,
}: {
  diff: ClientCommitDiff | null;
  busy: boolean;
  error: string | null;
}) {
  if (busy) return h('div', { style: { ...MUTED, marginTop: '3px' } }, '读取改动…');
  if (error !== null) {
    return h('div', { style: { ...MUTED, marginTop: '3px', color: REMOVED } }, error);
  }
  if (diff === null) return null;
  if (diff.available === false) {
    return h('div', { style: { ...MUTED, marginTop: '3px' } }, diff.reason ?? '该提交的改动不可用');
  }
  if (diff.patch.trim() === '') {
    return h('div', { style: { ...MUTED, marginTop: '3px' } }, '该提交没有改动这个文件。');
  }
  const lines = diff.patch.replace(/\n$/, '').split('\n');
  return h(
    'div',
    { style: { marginTop: '3px' } },
    h(
      'pre',
      {
        style: {
          ...styles.mono,
          margin: 0,
          fontSize: '11px',
          lineHeight: 1.45,
          maxHeight: '14em',
          overflow: 'auto',
          whiteSpace: 'pre',
          background: 'var(--dsw-alias-bg-layer-2, transparent)',
          borderRadius: '4px',
          padding: '4px 6px',
        },
      },
      lines.map((line, index) => {
        const added = line.startsWith('+') && !line.startsWith('+++');
        const removed = line.startsWith('-') && !line.startsWith('---');
        return h(
          'div',
          {
            key: index,
            style: {
              color: added ? ADDED : removed ? REMOVED : line.startsWith('@@') ? HUNK : undefined,
            },
          },
          line === '' ? ' ' : line,
        );
      }),
    ),
    diff.truncated
      ? h('div', { style: { ...MUTED, fontSize: '10px', marginTop: '2px' } }, '改动过大，已截断显示。')
      : null,
  );
}

/** On-demand commit timeline for one file selected from the activity lists. */
export function FileHistorySection({
  projectPath,
  filePath,
  history,
  busy,
  error,
  onClose,
}: {
  /** Needed to fetch a commit's patch; absent in a test render disables the expansion. */
  projectPath?: string | null;
  filePath: string | null;
  history: ClientFileHistory | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [openSha, setOpenSha] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<ClientCommitDiff | null>(null);
  const [diffBusy, setDiffBusy] = React.useState(false);
  const [diffError, setDiffError] = React.useState<string | null>(null);
  const diffSeq = React.useRef(0);

  // A different file, or closing the panel, invalidates the open patch.
  React.useEffect(() => {
    setOpenSha(null);
    setDiff(null);
    setDiffError(null);
    setDiffBusy(false);
  }, [filePath]);

  React.useEffect(() => {
    if (openSha === null || filePath === null || !projectPath) {
      setDiff(null);
      setDiffError(null);
      setDiffBusy(false);
      return undefined;
    }
    const seq = diffSeq.current + 1;
    diffSeq.current = seq;
    setDiff(null);
    setDiffError(null);
    setDiffBusy(true);
    fetch(
      routeUrl(
        `/api/gitnexus/file-diff?repo=${encodeURIComponent(projectPath)}` +
          `&path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(openSha)}`,
      ),
    )
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .then(({ status, body }) => {
        if (seq !== diffSeq.current) return;
        if ((status === 404 && body?.code !== 'not-a-project') || status === 401) {
          throw new Error('当前宿主没有文件改动路由；重启 DSH 后再试。');
        }
        if (!body?.ok) {
          throw new Error(typeof body?.message === 'string' ? body.message : `请求失败 (${status})`);
        }
        setDiff(body as ClientCommitDiff);
      })
      .catch((cause) => {
        if (seq !== diffSeq.current) return;
        setDiffError(String((cause as Error)?.message ?? cause));
      })
      .finally(() => {
        if (seq === diffSeq.current) setDiffBusy(false);
      });
    return undefined;
  }, [openSha, filePath, projectPath]);

  if (filePath === null) return null;
  return h(
    'div',
    { style: { borderTop: HAIRLINE, paddingTop: '6px', marginTop: '2px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
      h('span', { style: { ...MUTED, flexShrink: 0 } }, '文件时间线'),
      h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h(PathLabel, { path: filePath })),
      h(Button, { variant: 'ghost', onClick: onClose }, '关闭'),
    ),
    busy
      ? h('div', { style: { ...MUTED, marginTop: '4px' } }, '读取文件历史…')
      : error !== null
        ? h('div', { style: { ...MUTED, color: REMOVED } }, error)
        : history === null
          ? null
          : history.available === false
            ? h('div', { style: { ...MUTED, marginTop: '4px' } }, history.reason ?? '文件历史不可用')
            : h(
                'div',
                { style: { marginTop: '4px' } },
                h(
                  'div',
                  { style: { ...MUTED, fontSize: '10px', marginBottom: '3px' } },
                  `近 ${history.days} 天 · ${history.commits} 提交 · ` +
                    `+${compactNumber(history.insertions)} / −${compactNumber(history.deletions)}`,
                ),
                history.timeline.length === 0
                  ? h('div', { style: { ...MUTED } }, '该时间范围内没有提交。')
                  : history.timeline.length > 30
                    ? h(
                        'div',
                        { style: { ...MUTED, fontSize: '10px', marginBottom: '2px' } },
                        `仅显示最近 30 个提交（共 ${history.timeline.length} 个）`,
                      )
                    : null,
                history.timeline.slice(0, 30).map((commit) => {
                  const open = openSha === commit.sha;
                  const canExpand = Boolean(projectPath);
                  return h(
                    'div',
                    { key: commit.sha },
                    h(
                      'div',
                      {
                        role: canExpand ? 'button' : undefined,
                        tabIndex: canExpand ? 0 : undefined,
                        title: canExpand ? (open ? '收起改动' : '展开这次提交对文件的改动') : undefined,
                        onClick: canExpand
                          ? () => setOpenSha(open ? null : commit.sha)
                          : undefined,
                        onKeyDown: canExpand
                          ? (event: React.KeyboardEvent<HTMLDivElement>) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setOpenSha(open ? null : commit.sha);
                              }
                            }
                          : undefined,
                        style: {
                          ...styles.fileRow,
                          alignItems: 'flex-start',
                          cursor: canExpand ? 'pointer' : undefined,
                        },
                      },
                      h(
                        'span',
                        { style: { ...styles.mono, color: 'inherit', whiteSpace: 'nowrap' } },
                        commit.shortSha ?? commit.sha.slice(0, 8),
                      ),
                      h(
                        'span',
                        {
                          style: {
                            minWidth: 0,
                            flex: '1 1 auto',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                          title: commit.subject,
                        },
                        commit.subject === '' ? '(无提交说明)' : commit.subject,
                      ),
                      h(
                        'span',
                        { style: { ...styles.fileMeta, flexWrap: 'wrap' } },
                        h(
                          'span',
                          { style: { ...MUTED, whiteSpace: 'nowrap' } },
                          commit.date.slice(0, 10),
                        ),
                        h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, commit.author),
                        h(
                          'span',
                          { style: { ...MUTED, whiteSpace: 'nowrap' } },
                          `+${compactNumber(commit.insertions)}/−${compactNumber(commit.deletions)}`,
                        ),
                      ),
                    ),
                    open ? h(DiffView, { diff, busy: diffBusy, error: diffError }) : null,
                  );
                }),
              ),
  );
}
