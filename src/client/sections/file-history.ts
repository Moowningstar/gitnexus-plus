import * as React from 'react';
import { compactNumber } from '../format';
import { highlightLine, languageOf, type HighlightState, type TokenKind } from '../highlight';
import { routeUrl } from '../navigation';
import { Button, HAIRLINE, INLINE_BUTTON, MUTED, PathLabel, SOFT_BG, h, styles } from '../primitives';
import { ClientCommitDiff, ClientFileHistory } from '../types';

const ADDED = 'var(--dsw-alias-state-success-primary, #3fb950)';
const REMOVED = 'var(--dsw-alias-state-error-primary, #f85149)';

/**
 * Token colours, falling back to a dark-theme palette.
 *
 * The diff itself keeps carrying the add/remove signal in its line colour; these only
 * distinguish syntax inside a line, so a theme that does not define them still reads.
 */
const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: 'var(--dsw-alias-label-secondary, #6a9955)',
  string: 'var(--dsw-alias-code-string, #ce9178)',
  number: 'var(--dsw-alias-code-number, #b5cea8)',
  keyword: 'var(--dsw-alias-code-keyword, #c586c0)',
};

/** A diff body line, split into the marker and the code that follows it. */
function diffLineParts(line: string): { marker: string; code: string } {
  if (line.startsWith('@@')) return { marker: '', code: line };
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return { marker: '', code: line };
  }
  if (line === '') return { marker: '', code: '' };
  return { marker: line[0] as string, code: line.slice(1) };
}

/** Hunk header: `@@ -10,2 +10,3 @@` starts the old and the new line counters. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Rows rendered before the patch asks to be expanded; a 120 KB patch is otherwise a wall. */
const DIFF_ROW_CAP = 60;

const GUTTER: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '3.2em 3.2em minmax(0, 1fr)',
  columnGap: '6px',
  padding: '0 6px',
};

/** One diff row: two line numbers, then the coloured source. */
function diffRow(
  key: React.Key,
  oldNumber: string,
  newNumber: string,
  content: React.ReactNode,
  tint?: { background?: string; edge?: string },
): React.ReactNode {
  const numberStyle: React.CSSProperties = {
    textAlign: 'right',
    color: MUTED.color,
    fontSize: '10px',
    userSelect: 'none',
  };
  return h(
    'div',
    {
      key,
      style: {
        ...GUTTER,
        background: tint?.background,
        boxShadow: tint?.edge === undefined ? undefined : `inset 2px 0 0 ${tint.edge}`,
      },
    },
    h('span', { style: numberStyle }, oldNumber),
    h('span', { style: numberStyle }, newNumber),
    h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 } }, content),
  );
}

interface PatchRender {
  rows: React.ReactNode[];
  added: number;
  removed: number;
}

/**
 * One commit's patch, as unified-diff rows.
 *
 * The shape borrows from how a markdown code block presents source: a framed, monospaced
 * body with a language tag. On top of that a patch needs two things a plain coloured
 * `<pre>` cannot give — which line numbers changed, and a visible break between hunks.
 * Rows are built here, not in the component, so a 120 KB patch is tokenized once.
 */
function renderPatch(path: string, patch: string): PatchRender {
  const lines = patch.replace(/\n$/, '').split('\n');
  const language = languageOf(path);
  // Block comments span lines, so the scanner state is threaded through the patch.
  const state: HighlightState = { blockComment: false };
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  const rows: React.ReactNode[] = [];

  lines.forEach((line, index) => {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      // A hunk header carries the enclosing function after the `@@`, which is the one
      // piece of context that tells a reader which part of a long file they are in.
      rows.push(
        diffRow(index, '', '', h('span', null, line), { background: SOFT_BG }),
      );
      return;
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      // File headers are not changed lines; colouring them would make every patch open
      // with a false green and red.
      rows.push(diffRow(index, '', '', line, { background: SOFT_BG }));
      return;
    }
    const { marker, code } = diffLineParts(line);
    const addedLine = marker === '+';
    const removedLine = marker === '-';
    if (addedLine) added += 1;
    if (removedLine) removed += 1;
    const colour = addedLine ? ADDED : removedLine ? REMOVED : undefined;
    const tokens = highlightLine(code, language, state);
    const children: React.ReactNode[] = [];
    if (marker !== '') {
      children.push(h('span', { key: 'm', style: { color: colour, userSelect: 'none' } }, marker));
    }
    tokens.forEach((token, tokenIndex) => {
      children.push(
        h(
          'span',
          {
            key: tokenIndex,
            // Plain runs keep the diff colour; only real tokens take a syntax colour.
            style: { color: token.kind === 'plain' ? colour : TOKEN_COLORS[token.kind] },
          },
          token.text,
        ),
      );
    });
    if (code === '') children.push(h('span', { key: 'blank' }, ' '));
    rows.push(
      diffRow(
        index,
        addedLine ? '' : String(oldLine),
        removedLine ? '' : String(newLine),
        children,
        addedLine
          ? { background: 'rgba(63, 185, 80, 0.12)', edge: ADDED }
          : removedLine
            ? { background: 'rgba(248, 81, 73, 0.12)', edge: REMOVED }
            : undefined,
      ),
    );
    if (!addedLine) oldLine += 1;
    if (!removedLine) newLine += 1;
  });

  return { rows, added, removed };
}

export function DiffView({
  path,
  diff,
  busy,
  error,
}: {
  /** Source file the patch belongs to; only its extension is used. */
  path: string;
  diff: ClientCommitDiff | null;
  busy: boolean;
  error: string | null;
}) {
  // Called before any early return: hooks cannot be conditional.
  const [copied, setCopied] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const rendered = React.useMemo(
    () =>
      diff === null || diff.available === false || diff.patch.trim() === ''
        ? null
        : renderPatch(path, diff.patch),
    [path, diff],
  );
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
  if (rendered === null) return null;

  const copyPatch = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    // Hosts without a clipboard (or a denied origin) leave the text selectable instead;
    // a button that claims success on a no-op would be worse than no button.
    if (clipboard === undefined) return;
    clipboard
      .writeText(diff.patch)
      .then(() => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  };

  const capped = !expanded && rendered.rows.length > DIFF_ROW_CAP;
  return h(
    'div',
    { style: { marginTop: '3px', border: HAIRLINE, borderRadius: '6px', overflow: 'hidden' } },
    // The header mirrors a markdown code block: what language, how much changed, and the
    // one action a reader wants from a patch — copy it.
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '3px 8px',
          background: SOFT_BG,
          borderBottom: HAIRLINE,
          fontSize: '10px',
          ...MUTED,
        },
      },
      h('span', null, `改动 · ${languageOf(path) ?? '文本'}`),
      rendered.added > 0 ? h('span', { style: { color: ADDED } }, `+${rendered.added}`) : null,
      rendered.removed > 0 ? h('span', { style: { color: REMOVED } }, `−${rendered.removed}`) : null,
      h('span', { style: { flex: '1 1 auto' } }),
      h(
        'span',
        {
          role: 'button',
          tabIndex: 0,
          title: '复制整段补丁',
          onClick: copyPatch,
          onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              copyPatch();
            }
          },
          style: { ...INLINE_BUTTON },
        },
        copied ? '已复制' : '复制',
      ),
    ),
    h(
      'div',
      { style: { ...styles.mono, fontSize: '11px', lineHeight: 1.5, padding: '4px 0' } },
      capped ? rendered.rows.slice(0, DIFF_ROW_CAP) : rendered.rows,
    ),
    // A 120 KB patch is not readable in a sidebar; the cap keeps the card scannable and
    // leaves the rest one click away instead of behind a nested scrollbar.
    capped
      ? h(
          'div',
          { style: { ...MUTED, fontSize: '10px', padding: '2px 8px', borderTop: HAIRLINE } },
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              onClick: () => setExpanded(true),
              style: { ...INLINE_BUTTON },
            },
            `显示其余 ${rendered.rows.length - DIFF_ROW_CAP} 行`,
          ),
        )
      : null,
    diff.truncated
      ? h('div', { style: { ...MUTED, fontSize: '10px', padding: '2px 8px' } }, '改动过大，已截断显示。')
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
  onRetry,
}: {
  /** Needed to fetch a commit's patch; absent in a test render disables the expansion. */
  projectPath?: string | null;
  filePath: string | null;
  history: ClientFileHistory | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Re-runs the read. Without it a failed read is a dead end the reader cannot leave. */
  onRetry?: () => void;
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
      error !== null && typeof onRetry === 'function'
        ? h(Button, { variant: 'ghost', onClick: onRetry }, '重试')
        : null,
      h(Button, { variant: 'ghost', onClick: onClose }, '关闭'),
    ),
    busy
      ? h('div', { style: { ...MUTED, marginTop: '4px' } }, '读取文件历史…')
      : error !== null
        ? h('div', { style: { ...MUTED, color: REMOVED, marginTop: '4px' } }, error)
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
                          // Same rule as the activity lists: an expandable commit is a
                          // button, so it gets the hairline chrome the panel uses for
                          // anything that acts.
                          ...(canExpand
                            ? { cursor: 'pointer', border: HAIRLINE, borderRadius: '4px', padding: '3px 6px' }
                            : {}),
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
                        canExpand
                          ? h('span', { style: { ...INLINE_BUTTON } }, open ? '收起改动' : '改动')
                          : null,
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
                    open ? h(DiffView, { path: filePath, diff, busy: diffBusy, error: diffError }) : null,
                  );
                }),
              ),
  );
}
