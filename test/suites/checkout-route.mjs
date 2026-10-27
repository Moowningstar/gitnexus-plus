/**
 * `/api/gitnexus/checkout` — the one route in this plugin that writes.
 *
 * The test drives the mounted route against a stub server, so it can assert what the
 * handler forwards (the plain ref, nothing else) and what it refuses (a locked-down
 * branch, a path that is not a project) without checking anything out for real. The
 * real `git checkout` is exercised in `webview-setup.mjs` against a temp repository.
 */

import { check, section } from '../harness.mjs';

export async function checkoutRouteTests() {
  section('route: /api/gitnexus/checkout');
  const http = await import('node:http');
  const { mountCheckoutRoute } = await import('../../lib/routes/checkout.js');

  const registered = [];
  const shimServer = {
    register: (route) => {
      registered.push(route);
      return () => {
        const i = registered.indexOf(route);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
  const calls = [];
  let nextResult = { ok: true, branch: 'main', message: null };
  const dispose = mountCheckoutRoute(shimServer, {
    checkout: async (repo, branch) => {
      calls.push({ repo, branch });
      return { ...nextResult, branch };
    },
  });

  const server = http.createServer((req, res) => {
    const match = registered.find((route) => (req.url ?? '').startsWith(route.path));
    if (match !== undefined) {
      void match.handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('no route');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/api/gitnexus/checkout';
  const repo = process.cwd();
  const hit = async (query, body, method = 'POST') => {
    const res = await fetch(base + query, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const ok = await hit('?repo=' + encodeURIComponent(repo), { branch: 'main' });
  check('a checkout answers 200', ok.status === 200 && ok.body?.ok === true, 'status=' + ok.status);
  check('the route returns the branch it switched to', ok.body?.branch === 'main', JSON.stringify(ok.body));
  check(
    'the handler receives the project and the plain branch',
    calls.at(-1)?.repo === repo && calls.at(-1)?.branch === 'main',
    JSON.stringify(calls.at(-1)),
  );

  const missing = await hit('?repo=' + encodeURIComponent(repo));
  check('a missing repo is rejected', missing.status === 400, 'status=' + missing.status);

  const noBranch = await hit('?repo=' + encodeURIComponent(repo), {});
  check(
    'a missing branch is rejected',
    noBranch.status === 400 && noBranch.body?.code === 'missing-branch',
    'status=' + noBranch.status + ' body=' + JSON.stringify(noBranch.body),
  );

  const flagShaped = await hit('?repo=' + encodeURIComponent(repo), { branch: '--all' });
  check(
    'a flag-shaped branch is rejected before git sees it',
    flagShaped.status === 400 && flagShaped.body?.code === 'invalid-branch',
    'status=' + flagShaped.status + ' body=' + JSON.stringify(flagShaped.body),
  );
  check('the rejected branch never reached the handler', calls.length === 1, JSON.stringify(calls));

  const spaced = await hit('?repo=' + encodeURIComponent(repo), { branch: 'a b' });
  check('a branch with whitespace is rejected', spaced.status === 400, 'status=' + spaced.status);

  // git's own refusal (a dirty tree, a rebase in progress) is reported as 409 with the
  // message a human needs; nothing about it is retried or reinterpreted.
  nextResult = { ok: false, branch: null, message: 'error: Your local changes would be overwritten' };
  const refused = await hit('?repo=' + encodeURIComponent(repo), { branch: 'main' });
  check('a refused checkout is a 409', refused.status === 409, 'status=' + refused.status);
  check(
    'the refusal carries git\'s message',
    String(refused.body?.message ?? '').includes('local changes'),
    JSON.stringify(refused.body),
  );

  const notProject = await hit('?repo=' + encodeURIComponent('C:\\Windows\\System32'), { branch: 'main' });
  check(
    'a non-project is refused',
    notProject.status === 404 && notProject.body?.code === 'not-a-project',
    'status=' + notProject.status,
  );

  const get = await hit('?repo=' + encodeURIComponent(repo), undefined, 'GET');
  check('GET is rejected', get.status === 405, 'status=' + get.status);

  const head = await fetch(base + '?repo=' + encodeURIComponent(repo), { method: 'HEAD' });
  check('HEAD is allowed', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('the checkout disposer clears the registration', registered.length === 0);
}
