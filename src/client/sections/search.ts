import * as React from 'react';
import { Button, HAIRLINE, INLINE_BUTTON, MUTED, PathLabel, SOFT_BG, Section, Tag, h, styles } from '../primitives';
import { ClientSearchHit, SearchViewState } from '../types';

/**
 * Keyword search over the graph's symbol names and file paths.
 *
 * A native `input` rather than a primitives component: the shared package ships no
 * declarations for an input, and guessing a prop name there fails at mount time in a
 * browser where no test here can see it. The styling is the same theme-agnostic
 * vocabulary the rest of the panel uses — inherited colour, borders from
 * `currentColor`.
 */
export function SearchSection({ search }: { search: SearchViewState }) {
  const keyOf = (hit: ClientSearchHit): string =>
    `${hit.kind}:${hit.filePath}:${hit.startLine ?? ''}:${hit.name}`;
  const canSubmit = search.query.trim() !== '' && !search.searching;

  return h(
    Section,
    {
      wide: true,
      title: '关键词搜索',
      meta: h(
        'span',
        { style: { ...MUTED, fontSize: '12px' } },
        search.mode === 'text' ? '源码关键词（回退）' : '符号名 / 文件路径',
      ),
      // Twenty hits of `path:line` rows is a scroll area, not a page length.
      scroll: 420,
    },
    h(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '4px', flexWrap: 'wrap' } },
      h('input', {
        type: 'search',
        value: search.query,
        placeholder: '搜索符号或文件，例如 analyzeCoverage',
        'aria-label': '关键词搜索',
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => search.onQueryChange(event.target.value),
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter' && canSubmit) {
            event.preventDefault();
            search.onSubmit();
          }
        },
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          padding: '5px 8px',
          border: HAIRLINE,
          borderRadius: '6px',
          background: SOFT_BG,
          color: 'inherit',
          font: 'inherit',
        },
      }),
      h(Button, { variant: 'primary', disabled: !canSubmit, onClick: search.onSubmit }, search.searching ? '搜索中…' : '搜索'),
      search.query === '' ? null : h(Button, { variant: 'ghost', onClick: search.onClear }, '清除'),
    ),
    search.error !== null
      ? h(
          'div',
          {
            style: {
              ...MUTED,
              color: 'var(--dsw-alias-state-error-primary, inherit)',
              marginTop: '6px',
            },
          },
          search.error,
        )
      : null,
    h(
      'div',
      { style: { ...MUTED, fontSize: '10px', marginTop: '4px' } },
      search.warning ??
        (search.mode === 'text'
          ? '图查询不可用，已回退到源码关键词搜索。'
          : search.contentSearch
            ? '按符号名、文件路径与文件正文（FTS）匹配。'
            : '按符号名与文件路径匹配；不搜索正文。'),
    ),
    search.results === null
      ? null
      : search.results.length === 0
        ? h('div', { style: { ...MUTED, marginTop: '6px' } }, `没有匹配“${search.query}”的符号或文件。`)
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', marginTop: '6px' } },
            h(
              'div',
              { style: { ...MUTED, fontSize: '10px', paddingBottom: '2px' } },
              (search.mode === 'text'
                ? `找到 ${search.total} 处源码匹配`
                : `找到 ${search.total} 个结果`) +
                `${search.truncated ? '（已截断）' : ''} · 点击结果打开文件`,
            ),
            search.results.map((hit) =>
              h(
                'div',
                {
                  key: keyOf(hit),
                  style: { ...styles.fileRow, borderTop: HAIRLINE, padding: '5px 0' },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => search.onOpen(hit),
                    title:
                      hit.startLine === null
                        ? `打开 ${hit.filePath}`
                        : `打开 ${hit.filePath}:${hit.startLine}`,
                    style: {
                      ...INLINE_BUTTON,
                      flex: '1 1 auto',
                      minWidth: 0,
                      gap: '6px',
                      padding: '3px 6px',
                      fontSize: '12px',
                      textAlign: 'left',
                    },
                  },
                  h(Tag, { tone: 'neutral' }, hit.kind),
                  h(
                    'span',
                    {
                      style: {
                        fontWeight: 600,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    hit.name,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        ...MUTED,
                        ...styles.mono,
                        minWidth: 0,
                        flex: '1 1 auto',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    h(PathLabel, { path: hit.filePath }),
                    hit.startLine !== null ? `:${hit.startLine}` : '',
                  ),
                ),
                h(
                  Button,
                  { variant: 'ghost', onClick: () => search.onCopy(hit) },
                  search.copied === keyOf(hit) ? '已复制' : '复制',
                ),
              ),
            ),
          ),
  );
}
