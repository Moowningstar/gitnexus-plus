import { compactNumber } from '../format';
import { Button, HAIRLINE, MUTED, PathLabel, h, styles } from '../primitives';
import { ClientFileHistory } from '../types';

/** On-demand commit timeline for one file selected from the activity lists. */
export function FileHistorySection({
  filePath,
  history,
  busy,
  error,
  onClose,
}: {
  filePath: string | null;
  history: ClientFileHistory | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
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
        ? h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, error)
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
                history.timeline.slice(0, 30).map((commit) =>
                      h(
                        'div',
                        {
                          key: commit.sha,
                          style: { ...styles.fileRow, alignItems: 'flex-start' },
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
                    ),
              ),
  );
}
