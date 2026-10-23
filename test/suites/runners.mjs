/**
 * The analyzer and installer runners.
 *
 * Each suite drives a command line and parses what came back. Nothing real is spawned
 * unless git is available: a confined sandbox skips the git-dependent checks rather
 * than failing them.
 */


import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

export async function analyzeTests() {
  section('analyze runner (the one mutating capability)');
  const { createAnalyzeRunner, analyzeCommandLine } = await import('../../lib/gitnexus/analyze.js');

  // The bug that made the button appear to do nothing. A quoted path without a call
  // operator is a string *literal* to PowerShell, so the whole statement is a parse
  // error and the command never runs — measured against the real shim: without `&` it
  // reports "unexpected token", with it, the version prints.
  const winLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', { flavor: 'win32' });
  check('a Windows command uses the call operator', winLine.includes("& 'C:\\tools\\gitnexus.cmd'"), winLine);
  check('the call operator precedes the shim, not the args', /&\s'[^']*gitnexus\.cmd'\sanalyze/.test(winLine), winLine);
  check('--index-only is in the built command', winLine.includes('analyze --index-only'));
  check('the repository is quoted', winLine.includes("'D:\\repo'"));
  // Dropping the prefix reintroduces the respawn-over-piped-stdio failure the
  // maintenance text exists to avoid.
  check('GITNEXUS_MEMORY=off is kept', winLine.includes("$env:GITNEXUS_MEMORY='off'"), winLine);
  check('the heap override is kept', winLine.includes("$env:NODE_OPTIONS='--max-old-space-size=8192'"), winLine);

  const forcedLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', { flavor: 'win32', force: true });
  check('--force is appended after --index-only', forcedLine.includes('analyze --index-only --force'), forcedLine);
  check('a normal command is not forced', !winLine.includes('--force'), winLine);

  // The directory half of the same policy: a folder without `.git` is refused by the
  // CLI even when its path is explicit, and `--skip-git` is its documented escape.
  const noGitLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', {
    flavor: 'win32',
    skipGit: true,
  });
  check('--skip-git is emitted for a folder without .git', noGitLine.includes('--skip-git'), noGitLine);
  check('the path stays the last argument', noGitLine.trimEnd().endsWith("'D:\\repo'"), noGitLine);

  // The repair flag is a different operation, and the builder is the last place that
  // can keep the two contradictory flags apart: `--skip-fts --repair-fts` exits 0
  // having repaired nothing.
  const repairLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', {
    flavor: 'win32',
    repairFts: true,
    skipFts: true,
    force: true,
  });
  check('--repair-fts is appended after --index-only', repairLine.includes('analyze --index-only --repair-fts'), repairLine);
  check('a repair run never also skips FTS', !repairLine.includes('--skip-fts'), repairLine);
  check('a repair run is never also forced', !repairLine.includes('--force'), repairLine);

  // The runner reads the same config as the command text. Without this, the panel
  // confirms `GITNEXUS_HOME=… --skip-fts` and the process runs without either.
  const configuredLine = analyzeCommandLine('/usr/local/bin/gitnexus', '/home/u/repo', {
    flavor: 'posix',
    skipFts: true,
    gitnexusHome: '/tmp/gn-home',
  });
  check(
    'the runner mirrors skipFts and GITNEXUS_HOME',
    configuredLine.includes('--skip-fts') && configuredLine.includes("GITNEXUS_HOME='/tmp/gn-home'"),
    configuredLine,
  );

  const posixLine = analyzeCommandLine('/usr/local/bin/gitnexus', '/home/u/repo', { flavor: 'posix' });
  check(
    'POSIX needs no call operator, because an absolute path is already a command',
    !posixLine.includes('& ') && posixLine.includes("'/usr/local/bin/gitnexus' analyze"),
    posixLine,
  );
  check('POSIX uses assignment prefixes', posixLine.startsWith("GITNEXUS_MEMORY='off' NODE_OPTIONS="), posixLine);

  // A CLI from the declared dependency is that package's own `dist/cli/index.js`, so it
  // runs through `node`. That is the shape that removes the shim problems entirely: no
  // `.cmd`/`.ps1` choice, and no reliance on the shell's call operator.
  const nodeLine = analyzeCommandLine('D:\\p\\node_modules\\gitnexus\\dist\\cli\\index.js', 'D:\\repo', {
    flavor: 'win32',
    viaNode: true,
  });
  check('a dependency CLI is spawned through node', nodeLine.includes("node 'D:\\p\\node_modules\\gitnexus"), nodeLine);
  check('a node-spawned CLI needs no call operator', !nodeLine.includes('& '), nodeLine);
  check('a node-spawned CLI still gets the environment prefix', nodeLine.includes("$env:GITNEXUS_MEMORY='off'"));

  let captured = null;
  /**
   * A stub faithful to the seam: `result()` settles, and honours an abort.
   *
   * Returns a whole runner-options object rather than the shell alone, because
   * `createAnalyzeRunner` takes `{ shell, ... }` — returning the bare shell made every
   * call site pass the wrong shape and fail on `options.shell.resolve` being undefined.
   */
  const stubShell = (result, delayMs = 0) => ({
    shell: {
      resolve: (req) => {
        captured = req;
        return req;
      },
      execute: async (spec) => ({
        result: () =>
          new Promise((resolve) => {
            // A signal already aborted when `result()` is reached settles at once.
            // Without this the stub models a race the real seam does not have: the
            // README states that a cancellation arriving during preparation rejects
            // `execute` outright, and the runner handles that too — but a test that
            // only ever cancels *after* the handle exists would never exercise it.
            if (spec.signal?.aborted === true) return resolve({ exitCode: null, aborted: true });
            const finish = () => resolve(result);
            if (delayMs === 0) return finish();
            const t = setTimeout(finish, delayMs);
            spec.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve({ exitCode: null, aborted: true });
              },
              { once: true },
            );
          }),
        kill: () => true,
      }),
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 40));

  const done = createAnalyzeRunner(stubShell({ exitCode: 0, stdout: { text: 'indexed (7.2s)' } }));
  done.start('D:/Project/x');
  await settle();
  check('exit 0 is a completed run', done.status('D:/Project/x')?.state === 'done');
  check('output is kept for the panel', done.status('D:/Project/x')?.output.includes('7.2s'));

  // The refined rule: this runner never constructs a policy — it may only forward one
  // the host resolved. Without a provider the request carries none, so the executor's
  // deployment default applies exactly as before.
  check(
    'the runner sets no sandboxPolicy when the host provides none',
    captured !== null && !Object.prototype.hasOwnProperty.call(captured, 'sandboxPolicy'),
    JSON.stringify(Object.keys(captured ?? {})),
  );

  // And when the host does resolve one, it must travel unchanged: the workspace root is
  // the input an agentless route cannot otherwise supply, and the sandbox derives its
  // write capability SID from it (measured: a plugin route without it is confined to the
  // DSH application directory and cannot write `.gitnexus` at all).
  {
    // `captured` is shared with the assertions below; restore it so this block cannot
    // make them report on the wrong run.
    const savedCaptured = captured;
    const cliRoot = path.join(import.meta.dirname, '..', '.fixtures', `policy-cli-${process.pid}`);
    const cliPkg = path.join(cliRoot, 'node_modules', 'gitnexus');
    await fs.mkdir(path.join(cliPkg, 'dist', 'cli'), { recursive: true });
    await fs.mkdir(path.join(cliPkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(cliPkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(cliPkg, 'dist', 'cli', 'index.js'), '');
    await fs.writeFile(path.join(cliPkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
    const policy = { mode: 'workspace-write', workspaceRoot: 'D:\\Project\\policy' };
    const asked = [];
    const runner = createAnalyzeRunner({
      ...stubShell({ exitCode: 0 }),
      toolchain: { managedPrefix: cliRoot },
      sandboxPolicy: (repoPath) => {
        asked.push(repoPath);
        return policy;
      },
    });
    runner.start('D:/Project/policy');
    await settle();
    check(
      'a host-resolved sandbox policy is forwarded unchanged',
      captured?.sandboxPolicy === policy,
      JSON.stringify(captured?.sandboxPolicy),
    );
    check(
      'the policy is resolved for the run repository',
      asked.length === 1 && path.resolve(String(asked[0])).toLowerCase().endsWith('policy'),
      JSON.stringify(asked),
    );
    runner.dispose();
    await fs.rm(cliRoot, { recursive: true, force: true });
    captured = savedCaptured;
  }
  check('the run is killable at its deadline', captured?.onExpiry === 'kill');
  // The runner resolves the path before using it, so the assertion has to resolve it
  // the same way — comparing against the literal `D:/Project/x` tested the test's own
  // separator preference, not the runner's behaviour.
  check(
    'the working directory is the resolved repository',
    captured?.workdir === path.resolve('D:/Project/x'),
    String(captured?.workdir),
  );
  check('a cancellation signal reaches the executor', captured?.signal instanceof AbortSignal);
  check(
    '--index-only is always passed',
    done.status('D:/Project/x')?.command.includes('analyze --index-only') === true,
    done.status('D:/Project/x')?.command,
  );
  check(
    'a repository without FTS gets --skip-fts automatically',
    done.status('D:/Project/x')?.command.includes('--skip-fts') === true,
    done.status('D:/Project/x')?.command,
  );
  check(
    'the registry write is redirected into the project',
    done.status('D:/Project/x')?.command.includes('GITNEXUS_HOME') === true &&
      done.status('D:/Project/x')?.command.includes('plugin-home') === true,
    done.status('D:/Project/x')?.command,
  );
  check(
    'a directory without .git gets --skip-git automatically',
    done.status('D:/Project/x')?.command.includes('--skip-git') === true,
    done.status('D:/Project/x')?.command,
  );

  // The other half of that decision: a real git repository must not get the flag, or
  // the index would silently lose its commit baseline.
  const gitFixture = fixturePath('runner-git');
  await fs.rm(gitFixture, { recursive: true, force: true });
  await fs.mkdir(path.join(gitFixture, '.git'), { recursive: true });
  const withGit = createAnalyzeRunner(stubShell({ exitCode: 0 }));
  withGit.start(gitFixture);
  await settle();
  check(
    'a git repository does not get --skip-git',
    withGit.status(gitFixture)?.command.includes('--skip-git') === false,
    withGit.status(gitFixture)?.command,
  );
  withGit.dispose();
  await fs.rm(gitFixture, { recursive: true, force: true });

  // 0.1.3 pre-created parsedfile-store to dodge a worker mkdir. GitNexus deletes that
  // directory at the start of every parse, so a pre-created one turns each run into an
  // rmdir on a host-owned directory — the `EPERM … rmdir parsedfile-store` that 0.1.3's
  // users hit. The runner now removes a leftover and creates only the durable caches.
  const cacheRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-cache-'));
  await fs.mkdir(path.join(cacheRepo, '.gitnexus', 'parsedfile-store'), { recursive: true });
  const cacheRun = createAnalyzeRunner(stubShell({ exitCode: 0 }));
  cacheRun.start(cacheRepo);
  await settle();
  const leftover = await fs
    .access(path.join(cacheRepo, '.gitnexus', 'parsedfile-store'))
    .then(() => true)
    .catch(() => false);
  check('analyze clears a leftover run-scoped store before spawning', !leftover);
  const durable = await Promise.all(
    ['parsedfile-cache', 'parse-cache'].map((name) =>
      fs
        .access(path.join(cacheRepo, '.gitnexus', name))
        .then(() => true)
        .catch(() => false),
    ),
  );
  check('analyze pre-creates the durable caches before spawning', durable.every(Boolean), JSON.stringify(durable));
  await fs.rm(cacheRepo, { recursive: true, force: true });

  const denied = createAnalyzeRunner(
    stubShell({ exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } }),
  );
  denied.start('D:/Project/d');
  await settle();
  check('a sandbox refusal is reported as denied, not as a failure', denied.status('D:/Project/d')?.state === 'denied');
  check(
    'a denial says the plugin will not escalate',
    denied.status('D:/Project/d')?.message?.includes('不会申请扩权') === true,
  );

  const timedOut = createAnalyzeRunner(stubShell({ exitCode: null, timedOut: true }));
  timedOut.start('D:/Project/t');
  await settle();
  check('a deadline kill is reported as timed out', timedOut.status('D:/Project/t')?.state === 'timed-out');

  const failed = createAnalyzeRunner(stubShell({ exitCode: 2, stderr: { text: 'boom' } }));
  failed.start('D:/Project/f');
  await settle();
  check('a non-zero exit is a failure', failed.status('D:/Project/f')?.state === 'failed');

  // A transient Windows file lock on `.gitnexus` is not a policy refusal: the measured
  // failure is `EPERM … open '…\\.gitnexus\\lbug.init.lock'` while a scanner holds the
  // directory, and the ACL for that path was verified healthy. One retry, after clearing
  // a lock a crashed run left behind, is the response — not telling the operator to stop.
  {
    const lockMessage =
      "Error: EPERM: operation not permitted, open 'D:\\Project\\r\\.gitnexus\\lbug.init.lock'";
    /** @param {unknown[]} results */
    const sequenceShell = (results) => {
      let calls = 0;
      return {
        shell: {
          resolve: (req) => req,
          execute: async () => ({
            result: async () => {
              const result = results[Math.min(calls, results.length - 1)];
              calls += 1;
              return result;
            },
            kill: () => true,
          }),
        },
        calls: () => calls,
      };
    };

    const lockRepo = path.join(import.meta.dirname, '..', '.fixtures', `retry-${process.pid}`);
    await fs.rm(lockRepo, { recursive: true, force: true });
    await fs.mkdir(path.join(lockRepo, '.gitnexus'), { recursive: true });
    await fs.writeFile(path.join(lockRepo, '.gitnexus', 'lbug.init.lock'), '{"pid":999999}');

    // A plugin-owned CLI tree, so the runner reaches the spawn path without depending on
    // whatever gitnexus this machine happens to have globally installed.
    const cliRoot = path.join(lockRepo, 'cli');
    const cliPkg = path.join(cliRoot, 'node_modules', 'gitnexus');
    await fs.mkdir(path.join(cliPkg, 'dist', 'cli'), { recursive: true });
    await fs.mkdir(path.join(cliPkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(cliPkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(cliPkg, 'dist', 'cli', 'index.js'), '');
    await fs.writeFile(path.join(cliPkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
    const toolchain = { managedPrefix: cliRoot };

    const recovered = sequenceShell([
      { exitCode: 1, stderr: { text: lockMessage } },
      { exitCode: 0, stdout: { text: 'done' } },
    ]);
    const retrying = createAnalyzeRunner({ shell: recovered.shell, retryDelayMs: 5, toolchain });
    retrying.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a transient lock failure is retried once', recovered.calls() === 2, String(recovered.calls()));
    check('the retried run reports success', retrying.status(lockRepo)?.state === 'done', JSON.stringify(retrying.status(lockRepo)));
    check('the status records the attempt count', retrying.status(lockRepo)?.attempts === 2, String(retrying.status(lockRepo)?.attempts));
    const staleGone = await fs
      .access(path.join(lockRepo, '.gitnexus', 'lbug.init.lock'))
      .then(() => false)
      .catch(() => true);
    check('the stale init lock is cleared before the retry', staleGone);
    retrying.dispose();

    // The other EPERM measured in this deployment, and the opposite verdict: the
    // confined token can create files in `.gitnexus` but not directories, so the worker
    // cannot make its shard store. Retrying cannot grant that right.
    const storeMessage =
      "Error: EPERM: operation not permitted, mkdir 'D:\\Project\\r\\.gitnexus\\parsedfile-store'";
    const storeDenied = sequenceShell([
      { exitCode: 1, stderr: { text: storeMessage } },
      { exitCode: 0 },
    ]);
    const deniedStore = createAnalyzeRunner({ shell: storeDenied.shell, retryDelayMs: 5, toolchain });
    deniedStore.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a denied cache-directory creation is not retried', storeDenied.calls() === 1, String(storeDenied.calls()));
    check(
      'it is reported as a sandbox refusal, not a transient lock',
      deniedStore.status(lockRepo)?.state === 'denied',
      JSON.stringify(deniedStore.status(lockRepo)),
    );
    check(
      'the message says the sandbox forbids the directory and points at the terminal',
      deniedStore.status(lockRepo)?.message?.includes('创建缓存目录') === true &&
        deniedStore.status(lockRepo)?.message?.includes('普通终端') === true,
      deniedStore.status(lockRepo)?.message,
    );
    deniedStore.dispose();

    // The FTS repair starts a child process; a confined shell refuses it, and no retry
    // grants a spawn right. Measured as `Analysis failed: spawn EPERM`.
    const spawnDenied = sequenceShell([
      { exitCode: 1, stderr: { text: '  Analysis failed: spawn EPERM' } },
      { exitCode: 0 },
    ]);
    const repairRun = createAnalyzeRunner({ shell: spawnDenied.shell, retryDelayMs: 5, toolchain });
    repairRun.start(lockRepo, { repairFts: true });
    await new Promise((r) => setTimeout(r, 80));
    check('a refused child process is not retried', spawnDenied.calls() === 1, String(spawnDenied.calls()));
    check('it is reported as a sandbox refusal', repairRun.status(lockRepo)?.state === 'denied', JSON.stringify(repairRun.status(lockRepo)));
    check(
      'the message names the child process and the terminal',
      repairRun.status(lockRepo)?.message?.includes('子进程') === true &&
        repairRun.status(lockRepo)?.message?.includes('终端') === true,
      repairRun.status(lockRepo)?.message,
    );
    repairRun.dispose();

    // An extension that is present but cannot load is an upstream runtime gap. Telling
    // the operator to retry would be wrong; naming the runtime is the useful answer.
    const unloadable = sequenceShell([
      {
        exitCode: 1,
        stderr: {
          text: 'Analysis failed: Cannot repair FTS indexes: The FTS extension file was found but could not be loaded',
        },
      },
      { exitCode: 0 },
    ]);
    const ftsRun = createAnalyzeRunner({ shell: unloadable.shell, retryDelayMs: 5, toolchain });
    ftsRun.start(lockRepo, { repairFts: true });
    await new Promise((r) => setTimeout(r, 80));
    check('an unloadable FTS extension is not retried', unloadable.calls() === 1, String(unloadable.calls()));
    check('it is a failure, not a sandbox refusal', ftsRun.status(lockRepo)?.state === 'failed', JSON.stringify(ftsRun.status(lockRepo)));
    check(
      'the message names the missing runtime',
      ftsRun.status(lockRepo)?.message?.includes('运行时') === true,
      ftsRun.status(lockRepo)?.message,
    );
    ftsRun.dispose();

    // A confined shell cannot start git, so a successful run writes an empty
    // `lastCommit`. The index is fine; the baseline is not, and the operator should know
    // why the gate says 无法确认 afterwards.
    await fs.writeFile(
      path.join(lockRepo, '.gitnexus', 'gitnexus.json'),
      JSON.stringify({ lastCommit: '', stats: { files: 1 } }),
    );
    const noBaseline = sequenceShell([{ exitCode: 0, stdout: { text: 'done' } }]);
    const baselineRun = createAnalyzeRunner({ shell: noBaseline.shell, retryDelayMs: 5, toolchain });
    baselineRun.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a successful run without a baseline still completes', baselineRun.status(lockRepo)?.state === 'done');
    check(
      'it explains the missing commit baseline',
      baselineRun.status(lockRepo)?.message?.includes('提交基线') === true,
      baselineRun.status(lockRepo)?.message,
    );
    baselineRun.dispose();

    const stillLocked = sequenceShell([
      { exitCode: 1, stderr: { text: lockMessage } },
      { exitCode: 1, stderr: { text: lockMessage } },
    ]);
    const locked = createAnalyzeRunner({ shell: stillLocked.shell, retryDelayMs: 5, toolchain });
    locked.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a second lock failure is reported as failed, not denied', locked.status(lockRepo)?.state === 'failed', JSON.stringify(locked.status(lockRepo)));
    check(
      'the message names a transient lock and the retry',
      locked.status(lockRepo)?.message?.includes('临时占用') === true &&
        locked.status(lockRepo)?.message?.includes('重试') === true,
      locked.status(lockRepo)?.message,
    );
    locked.dispose();

    // A real sandbox refusal must never be retried: the marker is the only signal that
    // means "do not try again".
    const refused = sequenceShell([
      { exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } },
      { exitCode: 0 },
    ]);
    const refusing = createAnalyzeRunner({ shell: refused.shell, retryDelayMs: 5, toolchain });
    refusing.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a sandbox refusal is not retried', refused.calls() === 1, String(refused.calls()));
    check('the refusal is still reported as denied', refusing.status(lockRepo)?.state === 'denied');
    refusing.dispose();

    await fs.rm(lockRepo, { recursive: true, force: true });
  }

  // The managed tree is the one a panel install writes. Before this wiring existed,
  // `findGitnexusCli` supported `managedPrefix` but no caller passed it, so an install
  // succeeded and every later refresh still said "no CLI". This fixture is the shape
  // that would have caught that.
  const managedRoot = fixturePath('managed');
  const managedPackage = path.join(managedRoot, 'managed', 'node_modules', 'gitnexus');
  await fs.rm(managedRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(managedPackage, 'dist', 'cli'), { recursive: true });
  await fs.mkdir(path.join(managedPackage, 'dist', 'core', 'ingestion'), { recursive: true });
  await fs.writeFile(path.join(managedPackage, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
  await fs.writeFile(path.join(managedPackage, 'dist', 'cli', 'index.js'), '');
  await fs.writeFile(path.join(managedPackage, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');

  const { findGitnexusRoot } = await import('../../lib/gitnexus/root.js');
  const { findGitnexusCli } = await import('../../lib/gitnexus/toolchain.js');
  const foundRoot = findGitnexusRoot({ managedPrefix: path.join(managedRoot, 'managed') });
  check('a managed install is found as the package root', foundRoot === managedPackage, String(foundRoot));
  const foundCli = findGitnexusCli({ managedPrefix: path.join(managedRoot, 'managed') });
  check(
    'a managed install is selected as the CLI',
    foundCli.present === true && foundCli.source === 'managed' && foundCli.cliPath === path.join(managedPackage, 'dist', 'cli', 'index.js'),
    JSON.stringify(foundCli),
  );

  // The PATH probe used to read `env.PATH` from a spread copy of `process.env`, where
  // Windows spells the key `Path` — so the probe silently looked at nothing. This
  // fixture puts the package only behind a `Path` entry, which is the shape that failed.
  const pathRoot = fixturePath('path-probe');
  const pathPackage = path.join(pathRoot, 'node_modules', 'gitnexus');
  await fs.rm(pathRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(pathPackage, 'dist', 'core', 'ingestion'), { recursive: true });
  await fs.writeFile(path.join(pathPackage, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
  await fs.writeFile(path.join(pathPackage, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
  const viaWindowsSpelling = findGitnexusRoot({
    env: { Path: pathRoot, GITNEXUS_PACKAGE_ROOT: '' },
  });
  check(
    'a PATH entry spelled `Path` is probed',
    viaWindowsSpelling === pathPackage,
    String(viaWindowsSpelling),
  );
  const viaPosixSpelling = findGitnexusRoot({
    env: { PATH: pathRoot, GITNEXUS_PACKAGE_ROOT: '' },
  });
  check(
    'a PATH entry spelled `PATH` is probed',
    viaPosixSpelling === pathPackage,
    String(viaPosixSpelling),
  );

  // Two installs on PATH: an older copy first, the shim's own package second. The shim
  // is what the CLI runs, so its installation must win — otherwise the helper loads a
  // different native build than the one that wrote the index.
  const staleEntry = fixturePath('stale-entry');
  const shimEntry = fixturePath('shim-entry');
  const stalePackage = path.join(staleEntry, 'node_modules', 'gitnexus');
  const shimPackage = path.join(shimEntry, 'node_modules', 'gitnexus');
  for (const pkg of [stalePackage, shimPackage]) {
    await fs.rm(path.dirname(path.dirname(pkg)), { recursive: true, force: true });
    await fs.mkdir(path.join(pkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(pkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
  }
  await fs.writeFile(path.join(shimEntry, 'gitnexus.cmd'), '@echo off\r\n');
  const withShim = findGitnexusRoot({
    env: {
      Path: `${staleEntry}${path.delimiter}${shimEntry}`,
      GITNEXUS_PACKAGE_ROOT: '',
    },
  });
  check(
    'the install that carries the shim wins over an earlier copy on PATH',
    withShim === shimPackage,
    String(withShim),
  );

  const managed = createAnalyzeRunner({
    ...stubShell({ exitCode: 0 }),
    toolchain: { managedPrefix: path.join(managedRoot, 'managed') },
  });
  managed.start('D:/Project/m', { force: true });
  await settle();
  check(
    'the managed CLI is the one a run invokes',
    managed.status('D:/Project/m')?.command.includes(managedPackage) === true,
    managed.status('D:/Project/m')?.command,
  );
  check('a forced run records its mode', managed.status('D:/Project/m')?.force === true);
  check(
    'a forced run actually carries --force',
    managed.status('D:/Project/m')?.command.includes('--force') === true,
    managed.status('D:/Project/m')?.command,
  );

  // The repair run is the narrow write: FTS indexes only. Two flags must never ride
  // along — `--force` (that is a full rebuild, a much larger change than the button
  // says) and `--skip-fts` (which asks to skip the very thing being repaired; the CLI
  // accepts the pair and exits 0 having done nothing).
  const repaired = createAnalyzeRunner({
    ...stubShell({ exitCode: 0 }),
    toolchain: { managedPrefix: path.join(managedRoot, 'managed') },
  });
  repaired.start('D:/Project/r', { repairFts: true });
  await settle();
  check('a repair run records its mode', repaired.status('D:/Project/r')?.repairFts === true);
  check(
    'a repair run carries --repair-fts and never --skip-fts',
    repaired.status('D:/Project/r')?.command.includes('--repair-fts') === true &&
      repaired.status('D:/Project/r')?.command.includes('--skip-fts') === false,
    repaired.status('D:/Project/r')?.command,
  );
  check('a repair run is not a forced rebuild', repaired.status('D:/Project/r')?.force === false);
  repaired.dispose();
  managed.dispose();
  await fs.rm(managedRoot, { recursive: true, force: true });

  const absent = createAnalyzeRunner({ ...stubShell({ exitCode: 0 }), toolchain: { discover: false } });
  absent.start('D:/Project/n');
  check('no CLI is decided before anything is spawned', absent.status('D:/Project/n')?.state === 'unavailable');
  check(
    'the unavailable message names the install command',
    absent.status('D:/Project/n')?.message?.includes('npm i -g gitnexus') === true,
  );

  // Two concurrent `analyze` processes would contend for the same store and the second
  // would report a failure that says nothing about the repository.
  const serial = createAnalyzeRunner(stubShell({ exitCode: 0 }, 150));
  const first = serial.start('D:/Project/s');
  const second = serial.start('D:/Project/s');
  check('a second start returns the run already in flight', first.startedAt === second.startedAt);
  check('cancel reports that it acted', serial.cancel('D:/Project/s') === true);
  await settle();
  check('a cancelled run settles as cancelled', serial.status('D:/Project/s')?.state === 'cancelled');
  check('a cancelled run records when it finished', serial.status('D:/Project/s')?.finishedAt !== null);
  check(
    'a cancelled repository can be started again',
    serial.start('D:/Project/s')?.state === 'running',
  );
  serial.dispose();
}

export async function installTests() {
  section('gitnexus installer (the prerequisite the plugin can satisfy)');
  const { createInstallRunner, installCommandLine, defaultInstallPrefix } = await import('../../lib/gitnexus/install.js');

  // The two properties that make this safe to offer at all.
  const win = installCommandLine('C:\\Users\\u\\.dsh\\gitnexus-plus\\gitnexus', 'gitnexus@^1.6.12', { platform: 'win32' });
  check('the install is an npm install', win.includes('npm install'), win);
  check('it installs under a prefix rather than changing directory', win.includes("--prefix '"), win);
  check(
    'npm writes its cache inside the granted install tree',
    win.includes('npm_config_cache') && win.includes('.npm-cache'),
    win,
  );
  // No `--registry`: the operator's npmrc is the only authority on where their packages
  // come from, and hardcoding one breaks exactly the users who need this path.
  check('no registry is hardcoded', !win.includes('--registry'), win);
  check('the version spec is explicit', win.includes('gitnexus@^1.6.12'), win);

  check('the default prefix is plugin-owned, not the global prefix', defaultInstallPrefix({ DSH_HOME: 'C:\\x' }).endsWith('gitnexus'), defaultInstallPrefix({ DSH_HOME: 'C:\\x' }));

  const stubShell = (result) => ({
    shell: {
      resolve: (req) => req,
      execute: async () => ({ result: async () => result, kill: () => true }),
    },
  });

  const prefix = path.join(import.meta.dirname, '..', '.fixtures', 'install-prefix');
  const ok = createInstallRunner({ ...stubShell({ exitCode: 0, stdout: { text: 'added 206 packages' } }), prefix });
  ok.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a successful install reports done', ok.status()?.state === 'done', JSON.stringify(ok.status()));
  check('the installed CLI path is under the prefix', ok.cliPath().includes('node_modules'), ok.cliPath());
  check('the CLI path is the package bin', ok.cliPath().endsWith(path.join('dist', 'cli', 'index.js')), ok.cliPath());

  // npm's build scripts are the most likely failure: a machine without a C++ toolchain,
  // or a registry it cannot reach. The message has to name both.
  const bad = createInstallRunner({ ...stubShell({ exitCode: 1, stderr: { text: 'gyp ERR! find VS' } }), prefix });
  bad.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a failed install reports failed', bad.status()?.state === 'failed');
  check(
    'the failure message names the two likely causes',
    /registry/.test(bad.status()?.message ?? '') && /编译|toolchain|C\+\+/.test(bad.status()?.message ?? ''),
    bad.status()?.message,
  );

  const denied = createInstallRunner({
    ...stubShell({ exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } }),
    prefix,
  });
  denied.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a sandbox refusal is denied, not failed', denied.status()?.state === 'denied');
  check('a denial says the plugin will not escalate', denied.status()?.message?.includes('不会申请扩权') === true);

  // The install is a no-session spawn. Without a policy it inherits the DSH
  // application directory, whose Windows ACL grant fails under Program Files; the
  // install target is the only tree the command needs to write.
  const installPolicy = { mode: 'workspace-write', workspaceRoot: prefix };
  let policyPrefix = null;
  let policyRequest = null;
  const policyShell = {
    shell: {
      resolve: (req) => {
        policyRequest = req;
        return req;
      },
      execute: async () => ({
        result: async () => ({ exitCode: 0, stdout: { text: 'added 206 packages' } }),
      }),
    },
  };
  const withPolicy = createInstallRunner({
    ...policyShell,
    prefix,
    sandboxPolicy: (target) => {
      policyPrefix = target;
      return installPolicy;
    },
  });
  withPolicy.start();
  await new Promise((r) => setTimeout(r, 30));
  check(
    'the install policy is rooted at the install prefix',
    policyRequest?.sandboxPolicy === installPolicy &&
      path.resolve(policyPrefix) === path.resolve(prefix),
    JSON.stringify({ asked: policyPrefix, policy: policyRequest?.sandboxPolicy }),
  );

  // A policy failure happens inside `shell.resolve`, before any process exists. It
  // must become a failed install with the copyable command, not an exception that
  // escapes the route as an opaque 500.
  const brokenShell = createInstallRunner({
    shell: {
      resolve: () => {
        throw new Error(
          'sandbox mode "workspace-write" is requested but no sandbox backend is usable: ' +
            'windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\Program Files\\DSH Desktop)',
        );
      },
      execute: async () => ({ result: async () => ({ exitCode: 0 }) }),
    },
    prefix,
  });
  check('a policy failure does not throw out of start()', (() => {
    try {
      brokenShell.start();
      return true;
    } catch {
      return false;
    }
  })());
  check(
    'a policy failure becomes a failed run with the command',
    brokenShell.status()?.state === 'failed' &&
      brokenShell.status()?.message?.includes('普通终端') === true &&
      brokenShell.status()?.message?.includes('windows-acl-run') === true,
    JSON.stringify(brokenShell.status()),
  );

  const noShell = createInstallRunner({ shell: null, prefix });
  noShell.start();
  check('a deployment with no shell reports unavailable', noShell.status()?.state === 'unavailable');
  check(
    'the unavailable message tells the operator to run it themselves',
    noShell.status()?.message?.includes('手动执行') === true,
  );
}
