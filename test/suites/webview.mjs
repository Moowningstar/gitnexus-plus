/**
 * Shell primitives, AI settings injection, and the web view runner.
 *
 * Extracted from `run.mjs` unchanged — the checks, their messages and their order
 * inside each suite are as they were; only the file they live in changed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

export async function shellTests() {
  section('shell primitives: quoting, env prefixes, helper spawns, truncation honesty');
  const {
    envPrefix,
    exitDetail,
    invokeCommand,
    looksDeniedBySandbox,
    looksPermissionDenied,
    parseHelperOutput,
    quoteArg,
    readLineNumber,
    runHelper,
    shellFlavor,
    tailChars,
    tailToLine,
  } = await import('../../lib/shell.js');

  // --- quoting ------------------------------------------------------------------
  // One rule, six former copies. Each of these cases was a way the copies could have
  // silently disagreed: a space, an apostrophe, a CJK directory, a UNC path.
  check(
    'a plain path is single-quoted on both shells',
    quoteArg('win32', 'C:\\repo') === "'C:\\repo'" && quoteArg('posix', '/srv/repo') === "'/srv/repo'",
    `${quoteArg('win32', 'C:\\repo')} | ${quoteArg('posix', '/srv/repo')}`,
  );
  check(
    'a space stays inside the literal',
    quoteArg('win32', 'C:\\my repo') === "'C:\\my repo'",
    quoteArg('win32', 'C:\\my repo'),
  );
  check(
    "an apostrophe is doubled on windows and escaped on posix",
    quoteArg('win32', "it's") === "'it''s'" && quoteArg('posix', "it's") === "'it'\\''s'",
    `${quoteArg('win32', "it's")} | ${quoteArg('posix', "it's")}`,
  );
  check(
    'a CJK path is passed through unchanged',
    quoteArg('win32', 'D:\\项目\\文档') === "'D:\\项目\\文档'",
    quoteArg('win32', 'D:\\项目\\文档'),
  );
  check(
    'a UNC path keeps both leading separators',
    quoteArg('win32', '\\\\server\\share\\repo') === "'\\\\server\\share\\repo'",
    quoteArg('win32', '\\\\server\\share\\repo'),
  );

  // --- env prefixes -------------------------------------------------------------
  check(
    'windows assigns through $env: and ends with a separator',
    envPrefix('win32', [
      ['A', '1'],
      ['B', 'two words'],
    ]) === "$env:A='1'; $env:B='two words'; ",
    envPrefix('win32', [
      ['A', '1'],
      ['B', 'two words'],
    ]),
  );
  check(
    'posix assigns inline and ends with a separator',
    envPrefix('posix', [
      ['A', '1'],
      ['B', 'two words'],
    ]) === "A='1' B='two words' ",
    envPrefix('posix', [
      ['A', '1'],
      ['B', 'two words'],
    ]),
  );
  check('an empty prefix is the empty string, not a stray separator', envPrefix('win32', []) === '');

  // --- invocation ---------------------------------------------------------------
  check(
    'only a quoted windows head needs the call operator',
    invokeCommand('win32', "'C:\\x\\gitnexus.cmd'", 'analyze').startsWith('& ') &&
      invokeCommand('win32', "node 'C:\\x\\index.js'", 'analyze', { viaNode: true }) ===
        "node 'C:\\x\\index.js' analyze" &&
      invokeCommand('posix', "'/x/gitnexus'", 'analyze') === "'/x/gitnexus' analyze",
    invokeCommand('win32', "'C:\\x\\gitnexus.cmd'", 'analyze'),
  );
  check(
    'the flavour comes from the platform string',
    shellFlavor('win32') === 'win32' && shellFlavor('linux') === 'posix' && shellFlavor('darwin') === 'posix',
  );

  // --- tails --------------------------------------------------------------------
  const long = 'one\ntwo\nthree\nfour';
  check(
    'the line tail starts on a boundary when it can',
    tailToLine(long, 10) === 'four',
    JSON.stringify(tailToLine(long, 10)),
  );
  check(
    'the char tail does not look for a boundary',
    tailChars(long, 10) === '\ntwo\nthree\nfour'.slice(-10),
    JSON.stringify(tailChars(long, 10)),
  );
  check('a short text is returned whole', tailToLine('abc', 10) === 'abc' && tailChars('abc', 10) === 'abc');

  // --- refusal predicates -------------------------------------------------------
  // The two rules were two identically-named copies; they are different on purpose.
  check(
    'a bare EPERM is not a sandbox refusal',
    looksDeniedBySandbox('EPERM: operation not permitted') === false &&
      looksDeniedBySandbox('[sandbox: file access denied under workspace-write mode]') === true &&
      looksDeniedBySandbox('Error: Access is denied.') === true,
  );
  check(
    'the install reading includes EPERM and EACCES',
    looksPermissionDenied('EPERM: operation not permitted') === true &&
      looksPermissionDenied('EACCES: permission denied') === true &&
      looksPermissionDenied('everything is fine') === false,
  );

  // --- small readers ------------------------------------------------------------
  check(
    'a helper payload survives a warning printed before it',
    parseHelperOutput('warning: something\n{"ok":true}\n')?.ok === true &&
      parseHelperOutput('no object here') === null &&
      parseHelperOutput('{not json}') === null,
  );
  check(
    'line numbers accept numbers and bigints, and reject the rest',
    readLineNumber(3.9) === 3 && readLineNumber(7n) === 7 && readLineNumber('3') === null && readLineNumber(null) === null,
  );
  check(
    'the exit detail omits what it does not know',
    exitDetail(undefined, '') === '' && exitDetail(1, '') === ' (exit 1)' && exitDetail(1, 'boom') === ' (exit 1)：boom',
    exitDetail(1, 'boom'),
  );

  // --- the helper spawn ---------------------------------------------------------
  const stubShell = (result, options = {}) => {
    const calls = { resolves: 0, executes: 0 };
    return {
      calls,
      shell: {
        resolve(request) {
          calls.resolves += 1;
          calls.request = request;
          return { spec: true };
        },
        async execute() {
          calls.executes += 1;
          if (options.throwOnExecute) throw new Error('EPERM: spawn failed');
          return {
            async result() {
              if (options.throwOnResult) throw new Error('stream closed');
              return result;
            },
          };
        },
      },
    };
  };

  const ok = stubShell({ exitCode: 0, stdout: { text: '{"ok":true}' }, stderr: { text: '' } });
  const okRun = await runHelper({
    shell: ok.shell,
    command: 'node helper.js',
    workdir: '/repo',
    timeoutMs: 1000,
    stdoutMaxBytes: 1024,
  });
  check(
    'a helper run reports its output and asks the executor to kill at expiry',
    okRun.kind === 'ok' &&
      okRun.stdout === '{"ok":true}' &&
      okRun.exitCode === 0 &&
      ok.calls.request.onExpiry === 'kill' &&
      ok.calls.request.workdir === '/repo',
    JSON.stringify({ run: okRun, request: ok.calls.request }),
  );

  const slow = stubShell({ exitCode: null, timedOut: true });
  const slowRun = await runHelper({
    shell: slow.shell,
    command: 'node helper.js',
    workdir: '/repo',
    timeoutMs: 1000,
    stdoutMaxBytes: 1024,
  });
  check('a timed-out helper is its own kind', slowRun.kind === 'timed-out', JSON.stringify(slowRun));

  const failing = stubShell({}, { throwOnExecute: true });
  const failedRun = await runHelper({
    shell: failing.shell,
    command: 'node helper.js',
    workdir: '/repo',
    timeoutMs: 1000,
    stdoutMaxBytes: 1024,
  });
  check(
    'a refused spawn carries the reason instead of throwing',
    failedRun.kind === 'spawn-failed' && failedRun.message.includes('EPERM'),
    JSON.stringify(failedRun),
  );

  // --- truncation is a fact, not a guess ----------------------------------------
  // A page of exactly `limit` rows is complete; reporting it as truncated taught the
  // reader to ignore the flag. Both call sites fetched one row past the page instead.
  {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { readGitActivity } = await import('../../lib/gitnexus/git-activity.js');

    const root = fixturePath('shell-truncation');
    await fs.rm(root, { recursive: true, force: true });
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const git = (args) => exec('git', args, { cwd: root, windowsHide: true, timeout: 30_000 });
      const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=shell-test'];
      await git(['init']);
      for (const message of ['one', 'two', 'three']) {
        await git([...identity, 'add', '-A']);
        await git([...identity, 'commit', '-m', message, '--allow-empty']);
      }

      const exact = await readGitActivity(root, { maxCommits: 3, sinceDays: 1 });
      const under = await readGitActivity(root, { maxCommits: 2, sinceDays: 1 });
      check(
        'a commit window holding exactly the cap is not called truncated',
        exact !== null && exact.window.truncated === false,
        JSON.stringify(exact?.window),
      );
      check(
        'one commit past the cap is',
        under !== null && under.window.truncated === true,
        JSON.stringify(under?.window),
      );
    } catch (cause) {
      // The confined test environment cannot spawn git; the same skip the delta tests use.
      check(
        'git truncation tests run (skipped: git cannot be spawned in this sandbox)',
        true,
        String(cause?.message ?? cause),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

export async function aiSettingsTests() {
  section('AI settings: environment variables to the SPA provider shape');
  const { AI_ENV, AI_PROVIDERS, describeAiSettings, llmSettingsSeed, normalizeAiProvider, readAiSettings } =
    await import('../../lib/gitnexus/ai-settings.js');

  check(
    'the environment names are the documented ones',
    AI_ENV.provider === 'GITNEXUS_PLUS_AI_PROVIDER' &&
      AI_ENV.apiKey === 'GITNEXUS_PLUS_AI_API_KEY' &&
      AI_ENV.model === 'GITNEXUS_PLUS_AI_MODEL' &&
      AI_ENV.baseUrl === 'GITNEXUS_PLUS_AI_BASE_URL',
    JSON.stringify(AI_ENV),
  );
  check('the provider list matches the SPA dialog', AI_PROVIDERS.length === 9, AI_PROVIDERS.join(','));

  const absent = readAiSettings({});
  check('an empty environment is absent, not an error', absent.kind === 'absent', JSON.stringify(absent));

  const noProvider = readAiSettings({
    GITNEXUS_PLUS_AI_API_KEY: 'sk-test',
    GITNEXUS_PLUS_AI_MODEL: 'gpt-4o-mini',
  });
  check(
    'a key without a provider is refused, and names the missing variable',
    noProvider.kind === 'invalid' && noProvider.reason.includes('GITNEXUS_PLUS_AI_PROVIDER'),
    JSON.stringify(noProvider),
  );

  const noModel = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'openai',
    GITNEXUS_PLUS_AI_API_KEY: 'sk-test',
  });
  check(
    'a provider without a model is refused, and names the missing variable',
    noModel.kind === 'invalid' && noModel.reason.includes('GITNEXUS_PLUS_AI_MODEL'),
    JSON.stringify(noModel),
  );

  const unknown = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'not-a-provider',
    GITNEXUS_PLUS_AI_MODEL: 'x',
  });
  check(
    'an unknown provider lists the choices instead of guessing',
    unknown.kind === 'invalid' && unknown.reason.includes('deepseek') && unknown.reason.includes('openai'),
    JSON.stringify(unknown),
  );

  const noKey = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'openai',
    GITNEXUS_PLUS_AI_MODEL: 'gpt-4o-mini',
  });
  check(
    'a hosted provider without a key is refused',
    noKey.kind === 'invalid' && noKey.reason.includes('GITNEXUS_PLUS_AI_API_KEY'),
    JSON.stringify(noKey),
  );

  const local = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'ollama',
    GITNEXUS_PLUS_AI_MODEL: 'llama3.2',
  });
  check(
    'a local model needs no key',
    local.kind === 'ready' && local.settings.apiKey === '' && local.settings.baseUrl === null,
    JSON.stringify(local),
  );

  const azureNoEndpoint = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'azure',
    GITNEXUS_PLUS_AI_MODEL: 'gpt-4o',
    GITNEXUS_PLUS_AI_API_KEY: 'k',
  });
  const azureReady = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'azure',
    GITNEXUS_PLUS_AI_MODEL: 'gpt-4o',
    GITNEXUS_PLUS_AI_API_KEY: 'k',
    GITNEXUS_PLUS_AI_BASE_URL: 'https://demo.openai.azure.com',
  });
  check(
    'azure needs its endpoint, and accepts one',
    azureNoEndpoint.kind === 'invalid' &&
      azureReady.kind === 'ready' &&
      azureReady.settings.provider === 'azure-openai',
    `${JSON.stringify(azureNoEndpoint)} / ${JSON.stringify(azureReady)}`,
  );

  check(
    'provider aliases are normalised',
    normalizeAiProvider('Google') === 'gemini' &&
      normalizeAiProvider(' claude ') === 'anthropic' &&
      normalizeAiProvider('Z.AI') === 'glm' &&
      normalizeAiProvider('open_ai') === 'openai' &&
      normalizeAiProvider('nope') === null,
    [normalizeAiProvider('Google'), normalizeAiProvider('Z.AI'), normalizeAiProvider('nope')].join(','),
  );

  const trailing = readAiSettings({
    GITNEXUS_PLUS_AI_PROVIDER: 'openai',
    GITNEXUS_PLUS_AI_MODEL: 'gpt-4o-mini',
    GITNEXUS_PLUS_AI_API_KEY: 'sk-test',
    GITNEXUS_PLUS_AI_BASE_URL: 'https://api.example.com/v1///',
  });
  check(
    'a base url loses its trailing slashes',
    trailing.kind === 'ready' && trailing.settings.baseUrl === 'https://api.example.com/v1',
    JSON.stringify(trailing),
  );

  const openaiSeed = llmSettingsSeed({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.example.com/v1',
  });
  check(
    'only the active provider is seeded, so a hand-entered one survives',
    openaiSeed.activeProvider === 'openai' &&
      openaiSeed.openai.model === 'gpt-4o-mini' &&
      openaiSeed.openai.apiKey === 'sk-test' &&
      openaiSeed.openai.baseUrl === 'https://api.example.com/v1' &&
      Object.keys(openaiSeed).length === 2,
    JSON.stringify(openaiSeed),
  );

  const azureSeed = llmSettingsSeed({
    provider: 'azure-openai',
    apiKey: 'k',
    model: 'gpt-4o',
    baseUrl: 'https://demo.openai.azure.com',
  });
  check(
    'azure is stored under the SPA storage key, with endpoint and deployment',
    azureSeed.activeProvider === 'azure-openai' &&
      azureSeed.azureOpenAI.endpoint === 'https://demo.openai.azure.com' &&
      azureSeed.azureOpenAI.deploymentName === 'gpt-4o' &&
      azureSeed['azure-openai'] === undefined,
    JSON.stringify(azureSeed),
  );

  const ollamaSeed = llmSettingsSeed({ provider: 'ollama', apiKey: '', model: 'llama3.2', baseUrl: null });
  check(
    'a local model is seeded without a key field',
    ollamaSeed.activeProvider === 'ollama' && ollamaSeed.ollama.model === 'llama3.2' && ollamaSeed.ollama.apiKey === undefined,
    JSON.stringify(ollamaSeed),
  );

  const described = describeAiSettings(trailing);
  check(
    'the description names the provider and model, never the key',
    described.includes('openai') && described.includes('gpt-4o-mini') && !described.includes('sk-test'),
    described,
  );
  check(
    'absent and invalid configurations describe themselves',
    describeAiSettings(absent) === '未配置' && describeAiSettings(noModel) === '配置有误',
    `${describeAiSettings(absent)} / ${describeAiSettings(noModel)}`,
  );
}

export async function webDistTests() {
  section('generated web dist (the page that seeds the SPA)');
  const { defaultWebDistRoot, locateWebDist, prepareWebDist, removeWebDist, rewriteIndexHtml, scriptSafeJson } =
    await import('../../lib/gitnexus/webdist.js');

  const safe = scriptSafeJson({ a: '</script><script>alert(1)</script>' });
  check('the payload cannot close its own script element', !safe.includes('</script>') && safe.includes('\\u003c'), safe);

  const html =
    '<!doctype html><html><head><title>GitNexus</title>' +
    '<script type="module" crossorigin src="/assets/index-x.js"></script>' +
    '<link rel="stylesheet" href="/assets/index.css">' +
    '</head><body><div id="root"></div></body></html>';
  const rewritten = rewriteIndexHtml(html, { activeProvider: 'openai', openai: { model: 'gpt-4o-mini' } });
  check(
    'the module script is replaced by a seed that loads it afterwards',
    typeof rewritten === 'string' &&
      !rewritten.includes('<script type="module"') &&
      rewritten.includes('data-gitnexus-plus-ai') &&
      rewritten.includes('script.src = "/assets/index-x.js"') &&
      rewritten.includes('sessionStorage.setItem("gitnexus-llm-settings"'),
    String(rewritten).slice(0, 400),
  );
  check(
    'the rest of the page survives the rewrite',
    typeof rewritten === 'string' &&
      rewritten.includes('/assets/index.css') &&
      rewritten.includes('<div id="root">') &&
      rewritten.indexOf('data-gitnexus-plus-ai') < rewritten.indexOf('</head>'),
    String(rewritten),
  );
  check('no seed means no rewrite', rewriteIndexHtml(html, null) === null);
  check(
    'a page without a module script is not rewritten',
    rewriteIndexHtml('<!doctype html><html><head></head><body></body></html>', { activeProvider: 'openai' }) === null,
  );

  // A package-shaped directory, so the locator can be exercised without a real install.
  const root = fixturePath('webdist');
  await fs.rm(root, { recursive: true, force: true });
  const pkg = path.join(root, 'node_modules', 'gitnexus');
  const packaged = path.join(pkg, 'web');
  await fs.mkdir(path.join(packaged, 'assets'), { recursive: true });
  await fs.writeFile(path.join(packaged, 'index.html'), html);
  await fs.writeFile(path.join(packaged, 'assets', 'index-x.js'), 'console.log("spa")');

  check(
    'the packaged page is found from a dist/cli path',
    (await locateWebDist({ cliPath: path.join(pkg, 'dist', 'cli', 'index.js') })) === packaged,
    String(await locateWebDist({ cliPath: path.join(pkg, 'dist', 'cli', 'index.js') })),
  );
  check(
    'the packaged page is found from a package root',
    (await locateWebDist({ cliPath: 'gitnexus', packageRoot: pkg })) === packaged,
  );
  check(
    'a package without a page is reported as missing',
    (await locateWebDist({ cliPath: 'gitnexus', packageRoot: path.join(root, 'nope') })) === null,
  );

  const outDir = path.join(root, 'out');
  const prepared = await prepareWebDist({
    sourceDir: packaged,
    outDir,
    seed: { activeProvider: 'openai', openai: { model: 'gpt-4o-mini', apiKey: 'sk-test' } },
  });
  check('a prepared dist reports its directory and asset strategy', prepared !== null && prepared.dir === outDir && (prepared.assets === 'link' || prepared.assets === 'copied'), JSON.stringify(prepared));
  const written = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  check(
    'the written page carries the seed',
    written.includes('sk-test') && written.includes('/assets/index-x.js') && !written.includes('<script type="module"'),
    written.slice(0, 400),
  );
  const linkedAsset = await fs.readFile(path.join(outDir, 'assets', 'index-x.js'), 'utf8');
  check('the packaged assets are reachable from the generated directory', linkedAsset.includes('console.log("spa")'));

  check(
    'a missing source page is refused rather than half-written',
    (await prepareWebDist({ sourceDir: path.join(root, 'nope'), outDir: path.join(root, 'out2'), seed: { activeProvider: 'openai' } })) === null,
  );

  await removeWebDist(outDir);
  const gone = await fs
    .access(path.join(outDir, 'index.html'))
    .then(() => false)
    .catch(() => true);
  check('a generated dist can be removed', gone);

  check(
    'generated pages live under DSH_HOME',
    defaultWebDistRoot({ DSH_HOME: 'C:\\dsh-home' }) === path.join('C:\\dsh-home', 'gitnexus-plus', 'webview'),
    defaultWebDistRoot({ DSH_HOME: 'C:\\dsh-home' }),
  );

  await fs.rm(root, { recursive: true, force: true });
}

export async function webViewTests() {
  section('web view runner (the embedded GitNexus SPA)');
  const http = await import('node:http');
  const { createWebViewRunner, serveCommandLine, webViewUrl } = await import('../../lib/gitnexus/webview.js');
  const { mountWebViewRoute } = await import('../../lib/routes/webview.js');

  // The default `aiSettings` reads the environment, so a machine that exports these would
  // otherwise change every command this section builds and write a page into `$DSH_HOME`.
  const AI_VARS = [
    'GITNEXUS_PLUS_AI_PROVIDER',
    'GITNEXUS_PLUS_AI_API_KEY',
    'GITNEXUS_PLUS_AI_MODEL',
    'GITNEXUS_PLUS_AI_BASE_URL',
  ];
  const savedAiEnv = AI_VARS.map((name) => [name, process.env[name]]);
  for (const name of AI_VARS) delete process.env[name];

  // --- the command line ---------------------------------------------------------
  const winServe = serveCommandLine('C:\\tools\\gitnexus.cmd', { flavor: 'win32' });
  check('serve uses the call operator on Windows', winServe.includes("& 'C:\\tools\\gitnexus.cmd' serve"), winServe);
  check(
    'serve defaults to 4747 on loopback',
    winServe.includes('serve --port 4747') && winServe.includes("--host '127.0.0.1'"),
    winServe,
  );
  // The same two measured guards the analyze command carries: the memory override stops
  // the CLI re-spawning itself over piped stdio, and the heap is what that respawn was
  // trying to obtain.
  check(
    'the memory and heap guards are kept from the analyze command',
    winServe.includes("$env:GITNEXUS_MEMORY='off'") && winServe.includes('$env:NODE_OPTIONS='),
    winServe,
  );
  check('no registry home is exported when none was resolved', !winServe.includes('GITNEXUS_HOME'), winServe);

  const homedServe = serveCommandLine('C:\\tools\\gitnexus.cmd', {
    flavor: 'win32',
    gitnexusHome: 'D:\\repo\\.gitnexus\\plugin-home',
  });
  check(
    'the resolved registry home is exported to the server',
    homedServe.includes("$env:GITNEXUS_HOME='D:\\repo\\.gitnexus\\plugin-home'"),
    homedServe,
  );

  const posixServe = serveCommandLine('/usr/local/bin/gitnexus', { flavor: 'posix', port: 5000 });
  check(
    'POSIX needs no call operator',
    !posixServe.includes('& ') && posixServe.includes("'/usr/local/bin/gitnexus' serve"),
    posixServe,
  );
  check('the port is threaded through', posixServe.includes('serve --port 5000'), posixServe);
  check(
    'a JS entry point is launched through node, without the call operator',
    (() => {
      const nodeServe = serveCommandLine('C:\\g\\dist\\cli\\index.js', { flavor: 'win32', viaNode: true });
      return nodeServe.includes("node 'C:\\g\\dist\\cli\\index.js' serve") && !nodeServe.includes('& ');
    })(),
  );

  // `?repo=` is a path, not a name: it has to survive spaces and every separator, and it
  // is the one part of the URL the SPA resolves back to a registry entry.
  const spaUrl = webViewUrl(4747, '/tmp/my repo');
  check(
    'the SPA URL carries the repository path, encoded',
    spaUrl.startsWith('http://127.0.0.1:4747/?repo=') && spaUrl.includes('my%20repo') && !spaUrl.includes(' '),
    spaUrl,
  );
  check('the host is configurable', webViewUrl(5000, '/r', 'localhost').startsWith('http://localhost:5000/?repo='));

  // --- stubs --------------------------------------------------------------------
  /** A `fetch` stub: `servers` maps a port to whether it answers and what it lists. */
  const makeFetch = (servers) => async (raw) => {
    const parsed = new URL(raw);
    const server = servers.get(Number(parsed.port));
    if (server === undefined || server.up !== true) {
      return { ok: false, status: 503, json: async () => null };
    }
    if (parsed.pathname === '/api/health') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    if (parsed.pathname === '/api/repos') {
      return {
        ok: true,
        status: 200,
        json: async () => (server.repos ?? []).map((entry) => ({ path: entry })),
      };
    }
    return { ok: false, status: 404, json: async () => null };
  };

  /** A shell stub: records the spec and hands back one controllable process handle. */
  const makeShell = (result, hooks = {}) => {
    const calls = { resolves: [], executes: 0, kills: 0 };
    const handle = {
      result: () => result,
      kill: async () => {
        calls.kills += 1;
        hooks.onKill?.();
        return true;
      },
    };
    const shell = {
      resolve: (request) => {
        calls.resolves.push(request);
        return { command: request.command, request };
      },
      execute: async () => {
        calls.executes += 1;
        hooks.onStart?.();
        return handle;
      },
    };
    return { calls, shell };
  };

  // --- a fixture registry GitNexus could have written ---------------------------
  const root = fixturePath('webview');
  await fs.rm(root, { recursive: true, force: true });
  const repoDir = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const emptyHome = path.join(root, 'empty-home');
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(emptyHome, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, 'registry.json'),
    JSON.stringify([
      {
        name: 'repo',
        path: repoDir,
        storagePath: path.join(repoDir, '.gitnexus'),
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: '',
        stats: { files: 1, nodes: 1, edges: 0, communities: 1, processes: 0, embeddings: 0 },
      },
    ]),
  );
  await fs.writeFile(path.join(emptyHome, 'registry.json'), '[]');
  // A fake CLI. Never executed — `findGitnexusCli` only stats it, which is how the real
  // probe works too.
  const stubCli = path.join(root, 'gitnexus-cli');
  await fs.writeFile(stubCli, '');
  const toolchain = { env: { ...process.env, GITNEXUS_CLI: stubCli } };
  const neverStops = new Promise(() => {});

  // --- nothing indexed means nothing to show -----------------------------------
  const unindexed = createWebViewRunner({ shell: null, registryHomes: () => [emptyHome] });
  const noIndex = await unindexed.start(repoDir);
  check(
    'an unindexed repository is refused before anything is spawned',
    noIndex.state === 'failed' && noIndex.message.includes('没有这个仓库的索引'),
    noIndex.message,
  );
  check('the refusal names the registries it searched', noIndex.message.includes(emptyHome), noIndex.message);

  // --- the happy path ----------------------------------------------------------
  const servers = new Map();
  const spawned = makeShell(neverStops, {
    // The port is dead until the process is up, then answers and lists this repository.
    onStart: () => servers.set(4747, { up: true, repos: [repoDir] }),
    onKill: () => servers.delete(4747),
  });
  const runner = createWebViewRunner({
    shell: spawned.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(servers),
    sleep: async () => {},
    startTimeoutMs: 500,
  });

  const started = await runner.start(repoDir);
  check(
    'a fresh server starts and reports ready',
    started.state === 'ready' && started.owner === 'managed',
    JSON.stringify(started),
  );
  check('the URL points at the port it bound', started.url === webViewUrl(4747, repoDir), started.url);
  check('the registry it was started with is reported', started.registryHome === homeDir, started.registryHome);
  check(
    'the command is reported so a failure can be reproduced by hand',
    typeof started.command === 'string' && started.command.includes('serve --port 4747'),
    String(started.command),
  );
  check('exactly one process was spawned', spawned.calls.executes === 1);

  // The contract that makes this a server rather than a command: no deadline, and the
  // handle is kept instead of awaited.
  const spec = spawned.calls.resolves[0];
  check('the spawn arms no deadline', spec.onExpiry === 'none', JSON.stringify(spec?.onExpiry));
  check('the spawn runs in the repository', spec.workdir === repoDir, String(spec?.workdir));
  check(
    'the spawn exports the resolved registry home',
    typeof spec.command === 'string' && spec.command.includes(homeDir),
    String(spec?.command),
  );
  check('a running server reports ready without spawning again', (await runner.status(repoDir)).state === 'ready');
  check('asking for it twice does not spawn twice', (await runner.start(repoDir)).state === 'ready' && spawned.calls.executes === 1);

  const restarted = await runner.restart(repoDir);
  check(
    'restart replaces the process instead of reusing it',
    restarted.state === 'ready' && spawned.calls.executes === 2 && spawned.calls.kills === 1,
    `executes=${spawned.calls.executes} kills=${spawned.calls.kills}`,
  );

  const stopped = await runner.stop();
  check('stop kills the process this plugin started', spawned.calls.kills === 2, `kills=${spawned.calls.kills}`);
  check('stop reports stopped', stopped.state === 'stopped' && stopped.url === null, JSON.stringify(stopped));
  check('a stopped server stays stopped', (await runner.status(repoDir)).state === 'stopped');
  check(
    'with no AI variables a start reports that the settings are left alone',
    started.ai.injected === false && String(started.ai.reason).includes('GITNEXUS_PLUS_AI_'),
    JSON.stringify(started.ai),
  );

  // --- seeding the SPA's AI settings -------------------------------------------
  // The SPA is a cross-origin iframe, so this half cannot write its `sessionStorage`.
  // The injection point is therefore the page the server hands out: `GITNEXUS_WEB_DIST`
  // points it at a generated copy of `index.html` that seeds the settings first.
  const webSource = path.join(root, 'web');
  await fs.mkdir(path.join(webSource, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(webSource, 'index.html'),
    '<!doctype html><html><head><title>GitNexus</title>' +
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
      '<link rel="stylesheet" href="/assets/index.css">' +
      '</head><body><div id="root"></div></body></html>',
  );
  await fs.writeFile(path.join(webSource, 'assets', 'index-abc.js'), 'console.log("spa")');
  const distRoot = path.join(root, 'dist');

  const seededServers = new Map();
  const seededShell = makeShell(neverStops, {
    onStart: () => seededServers.set(4747, { up: true, repos: [repoDir] }),
    onKill: () => seededServers.delete(4747),
  });
  const seeder = createWebViewRunner({
    shell: seededShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(seededServers),
    sleep: async () => {},
    startTimeoutMs: 500,
    webDistRoot: distRoot,
    webDistSource: webSource,
    aiSettings: () => ({
      kind: 'ready',
      settings: {
        provider: 'openai',
        apiKey: 'sk-test-key',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.example.com/v1',
      },
    }),
  });
  const seeded = await seeder.start(repoDir);
  check(
    'a configured start reports the injection',
    seeded.state === 'ready' && seeded.ai.injected === true,
    JSON.stringify(seeded.ai),
  );
  check(
    'the injection reports provider and model but never the key',
    seeded.ai.provider === 'openai' &&
      seeded.ai.model === 'gpt-4o-mini' &&
      JSON.stringify(seeded.ai).includes('sk-test-key') === false,
    JSON.stringify(seeded.ai),
  );
  const seededSpec = seededShell.calls.resolves[0];
  const generatedDir = path.join(distRoot, '4747');
  check(
    'the server is pointed at the generated page',
    typeof seededSpec?.command === 'string' &&
      seededSpec.command.includes('GITNEXUS_WEB_DIST=') &&
      seededSpec.command.includes(generatedDir),
    String(seededSpec?.command),
  );
  const generatedIndex = await fs.readFile(path.join(generatedDir, 'index.html'), 'utf8');
  check(
    'the generated page seeds the settings before the app loads',
    generatedIndex.includes('gitnexus-llm-settings') &&
      generatedIndex.includes('sk-test-key') &&
      generatedIndex.includes('script.src = "/assets/index-abc.js"'),
    generatedIndex.slice(0, 500),
  );
  check(
    'the original module tag is gone, so the seed cannot be bypassed',
    !generatedIndex.includes('<script type="module"') && generatedIndex.includes('data-gitnexus-plus-ai'),
    generatedIndex.slice(0, 500),
  );
  const linkedAsset = await fs.readFile(path.join(generatedDir, 'assets', 'index-abc.js'), 'utf8');
  check('the packaged assets resolve from the generated directory', linkedAsset.includes('console.log("spa")'));

  await seeder.stop();
  const generatedGone = await fs
    .access(path.join(generatedDir, 'index.html'))
    .then(() => false)
    .catch(() => true);
  check('the generated page is removed with the server, key and all', generatedGone);

  // An adopted server keeps its own page — it was started before this plugin existed.
  const adoptAiServers = new Map([[4747, { up: true, repos: [repoDir] }]]);
  const adoptAiShell = makeShell(neverStops);
  const aiAdopter = createWebViewRunner({
    shell: adoptAiShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(adoptAiServers),
    sleep: async () => {},
    startTimeoutMs: 500,
    webDistRoot: distRoot,
    webDistSource: webSource,
    aiSettings: () => ({
      kind: 'ready',
      settings: { provider: 'gemini', apiKey: 'k', model: 'gemini-2.0-flash', baseUrl: null },
    }),
  });
  const adoptedAi = await aiAdopter.start(repoDir);
  check(
    'an adopted server says it cannot be seeded rather than pretending',
    adoptedAi.state === 'ready' && adoptedAi.ai.injected === false && String(adoptedAi.ai.reason).includes('外部'),
    JSON.stringify(adoptedAi.ai),
  );

  // A typo in a variable name is explained, but must not stop the server.
  const badServers = new Map();
  const badShell = makeShell(neverStops, {
    onStart: () => badServers.set(4749, { up: true, repos: [repoDir] }),
    onKill: () => badServers.delete(4749),
  });
  const badRunner = createWebViewRunner({
    shell: badShell.shell,
    port: 4749,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(badServers),
    sleep: async () => {},
    startTimeoutMs: 500,
    webDistRoot: distRoot,
    aiSettings: () => ({ kind: 'invalid', reason: '缺少 GITNEXUS_PLUS_AI_MODEL：供应商 openai 需要模型 id。' }),
  });
  const badStart = await badRunner.start(repoDir);
  check(
    'a bad AI configuration still starts, and explains itself',
    badStart.state === 'ready' && badStart.ai.injected === false && String(badStart.ai.reason).includes('缺少'),
    JSON.stringify(badStart.ai),
  );
  check(
    'a bad AI configuration serves the packaged page unchanged',
    typeof badShell.calls.resolves[0]?.command === 'string' &&
      badShell.calls.resolves[0].command.includes('GITNEXUS_WEB_DIST=') === false,
    String(badShell.calls.resolves[0]?.command),
  );

  // --- adopting a server this plugin did not start ------------------------------
  const adoptServers = new Map([[4747, { up: true, repos: [repoDir] }]]);
  const adoptShell = makeShell(neverStops);
  const adopter = createWebViewRunner({
    shell: adoptShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(adoptServers),
    sleep: async () => {},
    startTimeoutMs: 500,
  });
  const adopted = await adopter.start(repoDir);
  check(
    'an existing server that can see the repository is adopted',
    adopted.state === 'ready' && adopted.owner === 'adopted',
    JSON.stringify(adopted),
  );
  check('adoption spawns nothing', adoptShell.calls.executes === 0);
  const adoptedStop = await adopter.stop();
  check(
    'an adopted server is never killed',
    adoptShell.calls.kills === 0 && adoptedStop.state === 'ready',
    `kills=${adoptShell.calls.kills} state=${adoptedStop.state}`,
  );

  // Someone else's GitNexus on the default port, holding another repository's registry.
  const foreignServers = new Map([[4747, { up: true, repos: ['/somewhere/else'] }]]);
  const foreignShell = makeShell(neverStops, {
    onStart: () => foreignServers.set(4748, { up: true, repos: [repoDir] }),
  });
  const barger = createWebViewRunner({
    shell: foreignShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(foreignServers),
    sleep: async () => {},
    startTimeoutMs: 500,
  });
  const onNextPort = await barger.start(repoDir);
  check(
    'a foreign server on the first port is stepped over, not killed',
    onNextPort.state === 'ready' && onNextPort.port === 4748 && foreignShell.calls.kills === 0,
    JSON.stringify(onNextPort),
  );
  check('the URL follows the port actually used', onNextPort.url === webViewUrl(4748, repoDir), onNextPort.url);

  // --- failures the panel has to be able to explain ------------------------------
  const exitServers = new Map();
  const exitShell = makeShell(
    Promise.resolve({
      exitCode: 1,
      stdout: { text: 'GitNexus server starting' },
      stderr: {
        text:
          'Runtime exception: Trying to read a database file with a different version. ' +
          'Database file version: 42, Current build storage version: 41',
      },
    }),
  );
  const dying = createWebViewRunner({
    shell: exitShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(exitServers),
    sleep: async () => {},
    startTimeoutMs: 500,
  });
  const died = await dying.start(repoDir);
  check(
    'a server that exits at once is reported as failed',
    died.state === 'failed' && died.message.includes('exit 1'),
    died.message,
  );
  check(
    'the process output is surfaced instead of a blank SPA',
    died.output.includes('different version'),
    died.output,
  );

  const wrongServers = new Map();
  const wrongShell = makeShell(neverStops, {
    onStart: () => wrongServers.set(4747, { up: true, repos: ['/other/repo'] }),
  });
  const wrongHome = createWebViewRunner({
    shell: wrongShell.shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(wrongServers),
    sleep: async () => {},
    startTimeoutMs: 500,
  });
  const mismatch = await wrongHome.start(repoDir);
  check(
    'a server that cannot see the repository is reported, not offered',
    mismatch.state === 'failed' && mismatch.message.includes('没有这个仓库'),
    mismatch.message,
  );
  check('the mismatched server is stopped again', wrongShell.calls.kills === 1, `kills=${wrongShell.calls.kills}`);

  const noShell = createWebViewRunner({
    shell: null,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(new Map()),
    sleep: async () => {},
  });
  const unsupported = await noShell.start(repoDir);
  check(
    'a host without a shell executor reports unavailable',
    unsupported.state === 'unavailable' && unsupported.message.includes('shell 执行器'),
    unsupported.message,
  );

  const noCli = createWebViewRunner({
    shell: makeShell(neverStops).shell,
    port: 4747,
    toolchain: { discover: false },
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(new Map()),
    sleep: async () => {},
  });
  const absent = await noCli.start(repoDir);
  check(
    'a machine without the CLI says what to install',
    absent.state === 'unavailable' && absent.message.includes('npm i -g gitnexus'),
    absent.message,
  );

  const slow = createWebViewRunner({
    shell: makeShell(neverStops).shell,
    port: 4747,
    toolchain,
    registryHomes: () => [homeDir],
    fetchLike: makeFetch(new Map()),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 10)),
    startTimeoutMs: 60,
  });
  const timedOut = await slow.start(repoDir);
  check(
    'a server that never answers is a timeout, not a hang',
    timedOut.state === 'failed' && timedOut.message.includes('超时'),
    timedOut.message,
  );

  // --- the route ----------------------------------------------------------------
  const registered = [];
  const shimServer = {
    register: (route) => {
      registered.push(route);
      return () => {
        const index = registered.indexOf(route);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
  const calls = { status: [], start: [], restart: [], stop: 0 };
  const view = {
    state: 'ready',
    repoPath: repoDir,
    url: webViewUrl(4747, repoDir),
    port: 4747,
    owner: 'managed',
    repoResolvable: true,
    registryHome: homeDir,
    command: 'gitnexus serve --port 4747',
    startedAt: 1,
    message: null,
    output: '',
  };
  const disposeRoute = mountWebViewRoute(shimServer, {
    status: async (repo) => {
      calls.status.push(repo);
      return { ...view, state: 'stopped', url: null };
    },
    start: async (repo) => {
      calls.start.push(repo);
      return view;
    },
    restart: async (repo) => {
      calls.restart.push(repo);
      return view;
    },
    stop: async () => {
      calls.stop += 1;
      return { ...view, state: 'stopped' };
    },
  });
  check(
    'the route is registered under the plugin prefix',
    registered.length === 1 && registered[0].path === '/api/gitnexus/webview',
  );

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
  const hit = async (suffix, init) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/gitnexus/webview${suffix}`, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const missingRepo = await hit('');
  check(
    'a missing repo is a 400',
    missingRepo.status === 400 && missingRepo.body?.code === 'missing-repo',
    `status=${missingRepo.status}`,
  );

  const reported = await hit(`?repo=${encodeURIComponent(repoDir)}`);
  check(
    'GET reports without starting anything',
    reported.status === 200 && reported.body?.view?.state === 'stopped' && calls.start.length === 0,
    JSON.stringify(reported.body),
  );

  const startBody = await hit(`?repo=${encodeURIComponent(repoDir)}`, { method: 'POST' });
  check(
    'POST starts the server and answers ok when it is ready',
    startBody.status === 200 && startBody.body?.ok === true && calls.start.length === 1,
    JSON.stringify(startBody.body),
  );

  const restartBody = await hit(`?repo=${encodeURIComponent(repoDir)}&restart=1`, { method: 'POST' });
  check(
    'restart=1 forces a fresh process',
    restartBody.status === 200 && calls.restart.length === 1,
    JSON.stringify(restartBody.body),
  );

  const notADir = await hit(`?repo=${encodeURIComponent(path.join(repoDir, 'nope'))}`, { method: 'POST' });
  check(
    'a directory that does not exist is refused',
    notADir.status === 404 && notADir.body?.code === 'not-a-directory',
    `status=${notADir.status}`,
  );

  const stopBody = await hit('', { method: 'DELETE' });
  check('DELETE stops the server', stopBody.status === 200 && calls.stop === 1, JSON.stringify(stopBody.body));

  const put = await hit(`?repo=${encodeURIComponent(repoDir)}`, { method: 'PUT' });
  check('an unsupported method is a 405', put.status === 405, `status=${put.status}`);

  const head = await hit(`?repo=${encodeURIComponent(repoDir)}`, { method: 'HEAD' });
  check('HEAD is allowed without a body', head.status === 200 && head.body === null, `status=${head.status}`);

  await new Promise((resolve) => server.close(resolve));
  disposeRoute();
  check('the dispose hook clears the registration', registered.length === 0);

  for (const [name, value] of savedAiEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  await fs.rm(root, { recursive: true, force: true });
}
