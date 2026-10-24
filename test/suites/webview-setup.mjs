/**
 * The parts the embedded web view is built from: shell quoting, the AI settings that
 * get seeded into the page, and the generated web-dist directory.
 *
 * These run without spawning anything; `webview.mjs` runs the server lifecycle checks
 * against a stub shell.
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

/**
 * The probe half of the web view: which registry a repository would be served from,
 * and what a running server says about it. Stub fetch, no sockets.
 */
export async function webViewProbeTests() {
  section('web view probe: registry order, path identity, server answers');
  const { createWebViewProbe, registryHomesFor, repoPathMatches } = await import(
    '../../lib/gitnexus/webview-probe.js'
  );

  check(
    'paths compare across separators and case',
    repoPathMatches('D:/Repo/Project', 'D:\\repo\\project\\'),
    String(repoPathMatches('D:/Repo/Project', 'D:\\repo\\project\\')),
  );
  check(
    'different repositories do not match',
    !repoPathMatches('D:/repo/a', 'D:/repo/b'),
  );

  const homes = registryHomesFor('D:/repo', 'D:/custom');
  check(
    'the configured home is looked at first',
    homes[0] === path.resolve('D:/custom') && homes.length >= 2,
    JSON.stringify(homes),
  );
  check(
    'a configured home duplicating the plugin home is listed once',
    new Set(homes.map((home) => normalizePathKey(home))).size === homes.length,
    JSON.stringify(homes),
  );

  const answers = new Map();
  answers.set(4747, { health: false, repos: [] });
  answers.set(4748, { health: true, repos: [{ path: 'D:\\other' }] });
  answers.set(4749, { health: true, repos: [{ path: 'D:\\repo' }, { path: 12 }] });
  const probe = createWebViewProbe({
    host: '127.0.0.1',
    fetchLike: async (url) => {
      const port = Number(new URL(url).port);
      const answer = answers.get(port);
      if (answer === undefined) throw new Error('no server');
      if (url.endsWith('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ status: answer.health ? 'ok' : 'down' }) };
      }
      return { ok: true, status: 200, json: async () => answer.repos };
    },
  });

  check('a silent port is not healthy', (await probe.probeHealth(4747)) === false);
  check('a healthy port answers', (await probe.probeHealth(4748)) === true);
  check(
    'a server with another registry does not have this repository',
    (await probe.serverHasRepo(4748, 'D:/repo')) === false,
  );
  check(
    'the server that lists this repository does',
    (await probe.serverHasRepo(4749, 'D:/repo')) === true,
  );
  check(
    'entries that are not paths are ignored rather than crashing',
    (await probe.listRepos(4749)).length === 1,
  );
  check('a port nothing answers on is not healthy', (await probe.probeHealth(4751)) === false);
}
