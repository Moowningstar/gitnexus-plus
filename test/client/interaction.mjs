/**
 * The interaction chain, driven rather than described.
 *
 * Every other activity test asserts what a render *looks like*. These four steps are the
 * ones a user performs and a regression would break without changing any text at the
 * moment of render: open a commit, open one of its files, wait for the patch, close it
 * again. The fetch is stubbed at `globalThis.fetch`, so the assertions cover the whole
 * path from the click to the rendered diff — including the URL the client builds, which
 * is the one thing that can drift from the route the host actually serves.
 */
import { createRequire } from 'node:module';
import { mount } from './renderer.mjs';

const require = createRequire(import.meta.url);
const React = require('react');

/** @param {string} sha @param {string} subject @param {Array<{path: string, insertions: number, deletions: number}>} changed */
function commit(sha, subject, changed) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    date: '2026-10-28T09:00:00+08:00',
    author: 'Moowningstar',
    insertions: 3,
    deletions: 1,
    files: changed.length,
    parents: [],
    changed,
    filesTruncated: false,
    verdict: 'indexed',
  };
}

const PATCH = [
  'diff --git a/src/client/panel.ts b/src/client/panel.ts',
  'index 1111111..2222222 100644',
  '--- a/src/client/panel.ts',
  '+++ b/src/client/panel.ts',
  '@@ -1,2 +1,2 @@',
  '-const lanes = 1;',
  '+const lanes = 2;',
  '',
].join('\n');

/**
 * @param {{ I: any, React: any, check: (name: string, ok: boolean, detail?: string) => void, section: (title: string) => void }} api
 */
export async function interactionSuite({ I, React: facade, check, section }) {
  section('activity: the click-through chain');

  const timeline = [
    commit('deadbee1aaaa', 'feat: draw lanes', [
      { path: 'src/client/panel.ts', insertions: 3, deletions: 1 },
      { path: 'src/client/types.ts', insertions: 1, deletions: 0 },
    ]),
    commit('cafe1234bbbb', 'fix: close the lane', [
      { path: 'src/gitnexus/delta.ts', insertions: 2, deletions: 2 },
    ]),
  ];

  /** @type {string[]} */
  const calls = [];
  const realFetch = globalThis.fetch;

  const stubFetch = (status, body) => {
    calls.length = 0;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return {
        status,
        ok: status === 200,
        json: async () => body,
      };
    };
  };

  try {
    stubFetch(404, { ok: false, code: 'missing', message: 'no route' });

    const app = mount(
      React.createElement(I.ActivityTimeline, { timeline, indexKnown: true, projectPath: '/repo' }),
      { react: facade },
    );

    check(
      'a commit row is clickable only when its file list is present',
      app.findAll((node) => node.props.role === 'button').length === 2,
      String(app.findAll((node) => node.props.role === 'button').length),
    );

    const firstRow = app.find(
      (node) => node.props.role === 'button' && app.textOf(node).includes('draw lanes'),
    );
    app.click(firstRow);
    check(
      'clicking a commit reveals the files it touched',
      app.text().includes('src/client/panel.ts') && app.text().includes('src/client/types.ts'),
      app.text().slice(0, 240),
    );
    check(
      'the open commit says it is open',
      app.find((node) => node.props['aria-expanded'] === true) !== undefined,
    );

    // The patch route answers, and the diff replaces the "no route" state.
    stubFetch(200, { ok: true, available: true, patch: PATCH });

    const fileRow = () => app.find((node) => node.props.title === '展开该文件的改动');
    check('a file row offers to open its patch', fileRow() !== undefined);
    app.click(fileRow());
    await app.settle();

    check(
      'opening a file asks the host for that commit and that path',
      calls.length === 1 &&
        calls[0].includes('/api/gitnexus/file-diff?') &&
        calls[0].includes(encodeURIComponent('src/client/panel.ts')) &&
        calls[0].includes(encodeURIComponent('deadbee1aaaa')),
      calls.join(' | '),
    );
    // `renderPatch` splits a line into per-token spans, so the joined text has spaces
    // between tokens; the hunk header survives as one span and is the honest marker
    // that the patch body (not just its chrome) reached the DOM.
    check(
      'the returned patch is rendered under the file',
      app.text().includes('改动 · ') && app.text().includes('@@ -1,2 +1,2 @@'),
      app.text().slice(0, 320),
    );
    check(
      'the open file flips its own control to close',
      app.find((node) => node.props.title === '收起该文件的改动') !== undefined,
    );

    const before = calls.length;
    app.click(app.find((node) => node.props.title === '收起该文件的改动'));
    await app.settle();
    check(
      'closing the file drops its patch without asking the host again',
      calls.length === before && !app.text().includes('const lanes = 2;'),
      `${calls.length} vs ${before}`,
    );

    // Switching commits must not leave the previous commit's patch on screen.
    stubFetch(200, { ok: true, available: true, patch: PATCH });
    const secondRow = app.find(
      (node) => node.props.role === 'button' && app.textOf(node).includes('close the lane'),
    );
    app.click(secondRow);
    await app.settle();
    check(
      'opening another commit replaces the previous file list',
      app.text().includes('src/gitnexus/delta.ts') && !app.text().includes('src/client/panel.ts'),
      app.text().slice(0, 280),
    );

    // A host that predates the route answers 404; the panel must say so, not stay blank.
    // The second commit is still open, so the file row is already on screen.
    stubFetch(404, { ok: false, code: 'missing', message: 'Not found' });
    const thirdFile = app.find((node) => node.props.title === '展开该文件的改动');
    check('the second commit is still open for the 404 case', thirdFile !== undefined);
    app.click(thirdFile);
    await app.settle();
    check(
      'a host without the patch route says so instead of showing an empty diff',
      app.text().includes('当前宿主没有文件改动路由'),
      app.text().slice(0, 320),
    );

    app.unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
}
