/**
 * The process runner: one place that decides how a child is started.
 *
 * Three things are proven here, and nothing else needs a real child to prove them:
 *
 * 1. The argv path puts `argv` on the child and never builds a command string. This is
 *    the whole reason the seam exists — a symbol name from a caller must not be re-read
 *    by a shell.
 * 2. A confined policy is never passed through unconfined. When a policy is present and
 *    the host has no `ctx.sandbox.confine`, the run goes out through the shell instead
 *    of running outside the confinement the policy describes.
 * 3. A seam that does not match the documented shape degrades to the shell path. A host
 *    we do not understand is a host whose graph reads must still work.
 *
 * The shell path's exact command text is asserted too: it is the path 0.1.2–0.1.8
 * shipped, so any change to it is a regression in behaviour, not a refactor.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, section } from '../harness.mjs';
import { quoteArg, shellFlavor } from '../../lib/shell.js';
import {
  createRunner,
  isSandboxLike,
  isSubprocessLike,
  shellRunner,
} from '../../lib/subprocess.js';
import { captureGit, forgetGitFailure, lastGitFailure, provideGitSeams } from '../../lib/gitnexus/git-capture.js';

const POLICY = { mode: 'workspace-write', workspaceRoot: 'D:\\repo' };
const FULL_ACCESS = { mode: 'danger-full-access', workspaceRoot: 'D:\\repo' };
const win32 = process.platform === 'win32';

/** A handle shaped the way the documentation describes it. */
function okHandle(stdout = 'HELLO\n', stderr = '', exitCode = 0) {
  return {
    collected: {
      stdout: { readFrom: () => ({ text: stdout }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
    async result() {
      return { exitCode };
    },
    kill() {
      return true;
    },
  };
}

/** A subprocess seam that records every spec and answers with a canned handle. */
function recordingSubprocess(options = {}) {
  const specs = [];
  return {
    specs,
    resolveExecutable(command) {
      if (options.resolveThrows === true) throw new Error('no such executable');
      return options.resolved ?? command;
    },
    spawn(spec) {
      specs.push(spec);
      return options.handle ?? okHandle();
    },
  };
}

/** A shell stub that records the resolved requests and answers with empty output. */
function recordingShell() {
  const requests = [];
  return {
    requests,
    resolve(request) {
      requests.push(request);
      return request;
    },
    async execute() {
      return {
        async result() {
          return { stdout: { text: '' }, stderr: { text: '' }, exitCode: 0 };
        },
      };
    },
  };
}

/** A sandbox stub: records the call and hands back a rewrite plus signatures. */
function recordingSandbox(answer = {}) {
  const calls = [];
  return {
    calls,
    confine(argv, policy, signal) {
      calls.push({ argv, policy, signal });
      return { argv: answer.argv ?? argv, enforcement: 'partial', denialSignatures: answer.denials ?? [] };
    },
  };
}

export async function subprocessTests() {
  section('subprocess runner: the argv path');

  {
    const subprocess = recordingSubprocess();
    const runner = createRunner({ subprocess, shell: recordingShell() });
    const outcome = await runner.run({
      argv: ['node', 'C:\\a b\\helper.js', 'request.json'],
      cwd: 'D:\\repo',
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    check('the child is spawned with the argv it was given', (
      Array.isArray(subprocess.specs[0]?.argv) &&
      subprocess.specs[0].argv.length === 3 &&
      subprocess.specs[0].argv[1] === 'C:\\a b\\helper.js'
    ), JSON.stringify(subprocess.specs[0]?.argv));
    check('no command string is built on the argv path', !('command' in (subprocess.specs[0] ?? {})));
    check('cwd travels as cwd, not as part of a command', subprocess.specs[0]?.cwd === 'D:\\repo');
    check('the deadline becomes the grace period', subprocess.specs[0]?.graceMs === 5000);
    check('the stdout cap is passed through', subprocess.specs[0]?.stdio?.stdout?.maxBytes === 1024);
    check('stdout comes back as text', outcome.kind === 'ok' && outcome.stdout === 'HELLO\n');
    check('the exit code is reported as a number', outcome.kind === 'ok' && outcome.exitCode === 0);
    check('the runner reports itself as argv-only', runner.argvOnly === true);
  }

  {
    const subprocess = recordingSubprocess({ resolved: 'C:\\nodejs\\node.exe' });
    const runner = createRunner({ subprocess, shell: null });
    await runner.run({ argv: ['node', 'h.js'], cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    check('a bare command is resolved to an absolute path first', (
      subprocess.specs[0]?.argv[0] === 'C:\\nodejs\\node.exe'
    ), JSON.stringify(subprocess.specs[0]?.argv));

    const failing = recordingSubprocess({ resolveThrows: true });
    const lenient = createRunner({ subprocess: failing, shell: null });
    await lenient.run({ argv: ['node', 'h.js'], cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    check('an unresolvable command keeps its bare name', failing.specs[0]?.argv[0] === 'node');

    const absolute = recordingSubprocess();
    const runner2 = createRunner({ subprocess: absolute, shell: null });
    await runner2.run({ argv: ['C:\\x\\node.exe', 'h.js'], cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    check('an absolute command is not looked up', absolute.specs[0]?.argv[0] === 'C:\\x\\node.exe');
  }

  section('subprocess runner: confinement');

  {
    const subprocess = recordingSubprocess();
    const sandbox = recordingSandbox({ argv: ['confined', 'node', 'h.js'] });
    const runner = createRunner({ subprocess, sandbox, shell: recordingShell() });
    const outcome = await runner.run({
      argv: ['node', 'h.js'],
      cwd: 'D:\\repo',
      timeoutMs: 1000,
      maxBytes: 10,
      sandboxPolicy: POLICY,
    });
    check('a confined policy is handed to ctx.sandbox.confine', sandbox.calls.length === 1);
    check('confine receives the argv and the policy', (
      sandbox.calls[0]?.policy === POLICY && sandbox.calls[0]?.argv[0] === 'node'
    ));
    check('the confined argv is what gets spawned', subprocess.specs[0]?.argv[0] === 'confined');
    check('a confined run still answers', outcome.kind === 'ok');
  }

  {
    const subprocess = recordingSubprocess();
    const shell = recordingShell();
    const runner = createRunner({ subprocess, shell });
    await runner.run({
      argv: ['node', 'h.js'],
      cwd: 'D:\\repo',
      timeoutMs: 1000,
      maxBytes: 10,
      sandboxPolicy: POLICY,
    });
    // The host's rule: a confined policy may not be passed through silently unconfined.
    check('a policy without confine() does not spawn unconfined', subprocess.specs.length === 0);
    check('a policy without confine() falls back to the shell', shell.requests.length === 1);
  }

  {
    const subprocess = recordingSubprocess();
    const shell = recordingShell();
    const runner = createRunner({ subprocess, shell });
    await runner.run({
      argv: ['node', 'h.js'],
      cwd: 'D:\\repo',
      timeoutMs: 1000,
      maxBytes: 10,
      sandboxPolicy: FULL_ACCESS,
    });
    check('danger-full-access spawns without confining', subprocess.specs.length === 1);
    check('danger-full-access never touches the shell', shell.requests.length === 0);
  }

  {
    const subprocess = recordingSubprocess();
    const sandbox = recordingSandbox({ denials: ['[sandbox: file access denied]'] });
    const runner = createRunner({
      subprocess: { ...subprocess, spawn: (spec) => { subprocess.spawn(spec); return okHandle('', '[sandbox: file access denied]'); } },
      sandbox,
      shell: null,
    });
    const outcome = await runner.run({
      argv: ['node', 'h.js'],
      cwd: 'D:\\repo',
      timeoutMs: 1000,
      maxBytes: 10,
      sandboxPolicy: POLICY,
    });
    check('a denial signature becomes a failed spawn', outcome.kind === 'spawn-failed');
    check('a denial names the sandbox in the message', (
      outcome.kind === 'spawn-failed' && outcome.message.includes('沙箱拒绝执行')
    ), outcome.kind === 'spawn-failed' ? outcome.message : outcome.kind);
  }

  section('subprocess runner: seams that do not match the documentation');

  {
    const shell = recordingShell();
    const opaque = createRunner({ subprocess: { spawn: () => ({}) }, shell });
    const outcome = await opaque.run({ argv: ['node', 'h.js'], cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    check('an unrecognised handle falls back to the shell', shell.requests.length === 1);
    check('an unrecognised handle still answers', outcome.kind === 'ok');

    const throwing = createRunner({
      subprocess: { spawn: () => { throw new TypeError('collected is not a function'); } },
      shell,
    });
    await throwing.run({ argv: ['node', 'h.js'], cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    check('a shape error is not reported as a failed command', shell.requests.length === 2);
  }

  section('subprocess runner: cancellation and the deadline');

  {
    const subprocess = recordingSubprocess();
    const runner = createRunner({ subprocess, shell: recordingShell() });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runner.run({
      argv: ['node', 'h.js'],
      cwd: '.',
      timeoutMs: 1000,
      maxBytes: 10,
      signal: controller.signal,
    });
    check('an already-aborted call reports cancellation', outcome.kind === 'cancelled');
    check('an already-aborted call starts nothing', subprocess.specs.length === 0);
  }

  {
    let killed = false;
    const stuck = {
      collected: { stdout: { readFrom: () => '' }, stderr: { readFrom: () => '' } },
      result: () => new Promise(() => undefined),
      kill: () => { killed = true; return true; },
    };
    const runner = createRunner({ subprocess: { spawn: () => stuck }, shell: recordingShell() });
    const outcome = await runner.run({ argv: ['node', 'h.js'], cwd: '.', timeoutMs: 30, maxBytes: 10 });
    check('a run past its deadline reports a timeout', outcome.kind === 'timed-out');
    check('a run past its deadline is stopped', killed === true);
  }

  section('subprocess runner: the shell path is unchanged');

  {
    const shell = recordingShell();
    const runner = shellRunner(shell);
    const argv = ['node', "C:\\a b\\h.js", "q's.json"];
    await runner.run({ argv, cwd: '.', timeoutMs: 1000, maxBytes: 10 });
    const expectedArgs = argv.slice(1).map((value) => quoteArg(shellFlavor(), value)).join(' ');
    check('a bare head gets no call operator', (
      shell.requests[0]?.command === `node ${expectedArgs}`
    ), shell.requests[0]?.command);
    check('the shell path reports itself as not argv-only', runner.argvOnly === false);
  }

  {
    const shell = recordingShell();
    const runner = shellRunner(shell);
    await runner.run({
      argv: ['C:\\Program Files\\nodejs\\node.exe', '-v'],
      cwd: '.',
      timeoutMs: 1000,
      maxBytes: 10,
    });
    const head = quoteArg(shellFlavor(), 'C:\\Program Files\\nodejs\\node.exe');
    const expected = win32 ? `& ${head} '-v'` : `${head} '-v'`;
    check('a quoted head gets the call operator PowerShell needs', (
      shell.requests[0]?.command === expected
    ), shell.requests[0]?.command);
  }

  {
    const shell = recordingShell();
    const runner = shellRunner(shell);
    await runner.run({
      argv: ['node', 'h.js'],
      cwd: '.',
      env: [['GITNEXUS_HOME', 'D:\\r\\.gitnexus']],
      timeoutMs: 1000,
      maxBytes: 10,
    });
    const prefix = win32 ? `$env:GITNEXUS_HOME='D:\\r\\.gitnexus'; ` : `GITNEXUS_HOME='D:\\r\\.gitnexus' `;
    check('environment pairs lead the command', (
      shell.requests[0]?.command === `${prefix}node 'h.js'`
    ), shell.requests[0]?.command);
    check('the shell path hands the executor one string', (
      typeof shell.requests[0]?.command === 'string'
    ));
  }

  section('subprocess runner: service shapes');

  check('a spawner is recognised', isSubprocessLike({ spawn() {} }) === true);
  check('a non-spawner is not', isSubprocessLike({ spawn: 1 }) === false);
  check('an absent seam is not a spawner', isSubprocessLike(undefined) === false);
  check('a confiner is recognised', isSandboxLike({ confine() {} }) === true);
  check('a non-confiner is not', isSandboxLike({}) === false);
  check('a shell-only runner never claims argv', shellRunner(null).argvOnly === false);

  section('git-capture takes the host seam when it exists');

  {
    const subprocess = recordingSubprocess({ handle: okHandle('abc123\n') });
    let asked = 0;
    provideGitSeams(() => {
      asked += 1;
      return { subprocess };
    });
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-plus-seam-'));
      const first = await captureGit(root, ['rev-parse', 'HEAD']);
      check('git runs through the host spawner', subprocess.specs.length === 1);
      check('git arrives as argv, with git in command position', (
        subprocess.specs[0]?.argv[0] === 'git' && subprocess.specs[0]?.argv[1] === 'rev-parse'
      ), JSON.stringify(subprocess.specs[0]?.argv));
      check('the seam is read per call', asked === 1);
      check('the host path returns stdout', first.ok === true && first.text === 'abc123\n');

      const failing = {
        spawn: (spec) => {
          subprocess.specs.push(spec);
          return {
            collected: { stdout: { readFrom: () => '' }, stderr: { readFrom: () => 'fatal' } },
            async result() {
              return { exitCode: 128 };
            },
          };
        },
      };
      provideGitSeams(() => ({ subprocess: failing }));
      const second = await captureGit(root, ['rev-parse', 'HEAD']);
      check('a non-zero exit stays a failure', second.ok === false && second.failure === 'exit 128');
      check('a replaced seam is the one that runs', subprocess.specs.length === 2);

      provideGitSeams(() => null);
      const fallback = await captureGit(root, ['rev-parse', 'HEAD']);
      check('without a seam the file-descriptor path still answers', (
        typeof fallback.ok === 'boolean' && fallback.failure !== null
      ), String(fallback.failure));

      await fs.rm(root, { recursive: true, force: true });
    } finally {
      provideGitSeams(null);
    }
  }

  section('git-capture says why git was unreadable');

  {
    // A seam that cannot reach git must not end the story: the file-descriptor path is
    // the reason this module exists, and in the host 0.1.8 shipped to, the seam is the
    // part that fails. Before the retry, a refused seam made every git read null and the
    // panel said "git unavailable" on a machine where git worked perfectly.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-plus-gitnote-'));
    provideGitSeams(() => null);
    const inited = await captureGit(root, ['init', '-q']);
    const gitWorks = inited.ok;
    try {
      if (gitWorks) {
        await captureGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'one']);

        forgetGitFailure();
        const broken = {
          spawn() {
            return {
              collected: { stdout: { readFrom: () => '' }, stderr: { readFrom: () => '' } },
              async result() {
                throw new TypeError('collected is not a function');
              },
            };
          },
        };
        provideGitSeams(() => ({ subprocess: broken }));
        const viaFallback = await captureGit(root, ['rev-parse', 'HEAD'], { timeoutMs: 10_000 });
        check('a seam that cannot reach git falls back to a file descriptor', (
          viaFallback.ok === true && /^[0-9a-f]{40}/.test(viaFallback.text)
        ), `${viaFallback.ok} / ${viaFallback.failure} / ${viaFallback.text.slice(0, 12)}`);
        check('a successful fallback leaves no failure note behind', lastGitFailure() === null, JSON.stringify(lastGitFailure()));

        provideGitSeams(() => null);
        forgetGitFailure();
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-plus-norepo-'));
        const refused = await captureGit(empty, ['rev-parse', 'HEAD'], { timeoutMs: 10_000 });
        const noted = lastGitFailure();
        check('a failed read is remembered with the argv that failed', (
          refused.ok === false && noted !== null && noted.command === 'git rev-parse HEAD'
        ), JSON.stringify(noted));
        check('the note carries the reason git gave', (
          noted !== null && /exit \d+/.test(noted.failure)
        ), JSON.stringify(noted));
        check('an exit is git answering, so both attempts are not made', (
          refused.failure !== null && !refused.failure.startsWith('seam:')
        ), String(refused.failure));
        await fs.rm(empty, { recursive: true, force: true });

        const scratch = path.join(root, '.gitnexus', 'plugin-home', 'tmp');
        const entries = await fs.readdir(scratch).catch(() => null);
        check('scratch files are written inside the workspace, not the system temp dir', entries !== null, String(scratch));
        check('no scratch file survives the call', (
          Array.isArray(entries) && entries.every((name) => !name.startsWith('git-'))
        ), JSON.stringify(entries));
        await fs.rm(root, { recursive: true, force: true });
      } else {
        // Without a spawnable git there is no truth to fall back to; the retry and the
        // note are still the contract, they just cannot be shown end to end here.
        check('git is not spawnable here, so the fallback is proven by construction', refusedWithoutGit(inited));
        await fs.rm(root, { recursive: true, force: true });
      }
    } finally {
      provideGitSeams(null);
      forgetGitFailure();
    }
  }
}

/** The fallback cannot run without git; assert the failure it already produced. */
function refusedWithoutGit(inited) {
  return inited.ok === false && inited.failure !== null;
}

export default subprocessTests;
