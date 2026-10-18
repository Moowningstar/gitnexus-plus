/**
 * Whether GitNexus is actually available on this machine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin declares **no runtime dependencies** and never imports `gitnexus` as a
 * module. It reads an index another tool produced and, when it can, deep-imports the
 * upstream scan primitives at runtime. That design keeps the plugin a pure observer —
 * but it means "the operator has no GitNexus" is a first-class reachable state, not
 * an edge case, and nothing was checking for it.
 *
 * The consequence was not a crash. The engine degrades: `loadScanPrimitives` returns
 * `null`, the local walker takes over, and the size caps fall back to their built-in
 * defaults. The damage was in what the operator was **told**: with no index, the panel
 * handed over `gitnexus analyze --index-only …` — a command that fails with
 * `command not found` on a machine that has no GitNexus, presented as the next step.
 *
 * TWO SEPARATE QUESTIONS
 * ----------------------
 * The library tree and the CLI are different things and are reported separately,
 * because they gate different promises:
 *
 *   - **package root** — can this plugin reuse GitNexus's own scan rules and language
 *     detector, and are the numbers therefore authoritative?
 *   - **CLI on PATH** — will the maintenance command the panel hands over actually
 *     run when the operator pastes it?
 *
 * A `gitnexus` installed as a dependency but never linked globally satisfies the
 * first and not the second, and collapsing them into one boolean would make the
 * panel either over- or under-promise in that case.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findGitnexusRoot, readGitnexusVersion } from './root.js';

/**
 * Filenames a `gitnexus` CLI shim can have, in probe order **per platform**.
 *
 * Written out rather than derived from `PATHEXT`, for the reason `root.ts` already
 * documents: under nvm-for-windows the shim is `gitnexus.ps1`, and `PATHEXT` does not
 * list `.ps1`, so extension-driven discovery silently finds nothing on exactly the
 * machines where the CLI is installed.
 *
 * ORDER IS PLATFORM-SPECIFIC, AND THAT IS THE WHOLE POINT
 * ------------------------------------------------------
 * npm writes three shims side by side: `gitnexus` (a `#!/bin/sh` script), `gitnexus.cmd`
 * and `gitnexus.ps1`. The extensionless one is the POSIX entry point; on Windows it is
 * inert. Measured on the reference machine:
 *
 *     gitnexus      -> no output, no exit status
 *     gitnexus.ps1  -> 1.6.12, exit 0
 *     gitnexus.cmd  -> 1.6.12, exit 0
 *
 * A single order listing the extensionless name first — which is the natural way to
 * write it — therefore selects a shim that cannot run on Windows, and the `.ps1`
 * fix above it never gets a chance to help. The runner would build a command around
 * that path and report a failure that has nothing to do with the repository.
 *
 * `.cmd` leads on Windows because it is the one a batch *or* a PowerShell host can
 * spawn; `.ps1` follows for installs that ship only that.
 */
const WINDOWS_SHIM_NAMES: readonly string[] = [
  'gitnexus.cmd',
  'gitnexus.exe',
  'gitnexus.bat',
  'gitnexus.ps1',
  'gitnexus',
];

const POSIX_SHIM_NAMES: readonly string[] = ['gitnexus'];

/** The probe order for a platform. Exported so a test can assert the ordering. */
export function cliShimNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? WINDOWS_SHIM_NAMES : POSIX_SHIM_NAMES;
}

/**
 * The POSIX probe order, kept exported under its original name.
 *
 * Callers that need the real answer must use {@link cliShimNames}; this is the list
 * for a platform where the extensionless shim is the correct one.
 */
export const CLI_SHIM_NAMES: readonly string[] = POSIX_SHIM_NAMES;

export interface CliProbeFound {
  present: true;
  /**
   * Absolute path to the thing that runs the CLI.
   *
   * A `.js` script when it came from the declared `gitnexus` dependency — that
   * package's `bin` is `dist/cli/index.js` — and a shim path when it came from PATH.
   * `viaNode` says which, because the two need different command shapes: a script is
   * spawned as `node <path>`, a shim is spawned directly (and on Windows needs the
   * shell's call operator).
   */
  cliPath: string;
  /** Whether `cliPath` has to be run through `node`. */
  viaNode: boolean;
  /** Where this came from, so an unexpected pick can be diagnosed. */
  source: 'override' | 'dependency' | 'path';
  /** The package root it was resolved from, when it came from a dependency. */
  packageRoot: string | null;
}

export interface CliProbeMissing {
  present: false;
  /** How many PATH entries were examined — evidence the probe actually ran. */
  probedDirs: number;
}

/**
 * How much of GitNexus is available.
 *
 * `library-only` is the case worth naming: analysis is authoritative, but a handed-over
 * command will not run as typed.
 */
export type ToolchainVerdict =
  /** Both the library tree and a CLI shim are present. Every promise holds. */
  | 'ready'
  /** The library tree is present but no CLI shim was found on PATH. */
  | 'library-only'
  /** Neither was found: the plugin falls back to its own scan rules. */
  | 'absent';

export interface ToolchainStatus {
  /** Where the GitNexus package tree was found, if anywhere. */
  packageRoot: string | null;
  /** Version read from that tree's manifest, for provenance. */
  packageVersion: string | null;
  /** Whether a `gitnexus` executable is reachable through PATH. */
  cli: CliProbeFound | CliProbeMissing;
  verdict: ToolchainVerdict;
}

export interface ToolchainOptions {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  /** Platform whose shim naming applies. Defaults to the running one. */
  platform?: NodeJS.Platform;
  /** Skips discovery entirely, returning an `absent` verdict — for tests. */
  discover?: boolean;
}

/**
 * The effective `PATH`, whatever the platform spells it.
 *
 * `process.env` is a case-insensitive proxy — `process.env.PATH` resolves on Windows
 * even though the variable is stored as `Path`. **Spreading it into a plain object
 * drops that**, so `{ ...process.env }.PATH` is `undefined` on the default Windows
 * layout and the probe walks zero directories while reporting a plausible-looking
 * miss. That is how this was found: the runner reported "no gitnexus" on a machine
 * where `gitnexus` runs, with `probedDirs: 0` as the only clue.
 *
 * Caller-supplied values still win, checked in the same three spellings so an
 * override cannot be lost the same way.
 */
function effectivePath(override: NodeJS.ProcessEnv | undefined): string {
  const pick = (source: NodeJS.ProcessEnv | undefined): string | undefined => {
    if (source === undefined) return undefined;
    return source.PATH ?? source.Path ?? source.path;
  };
  return pick(override) ?? pick(process.env) ?? '';
}

/**
 * Resolve the `gitnexus` CLI this plugin will run.
 *
 * ORDER: explicit override, then the declared dependency, then PATH.
 *
 * The dependency comes first because the plugin now declares `gitnexus` as one, so it
 * is present by construction and no PATH search is needed — the "is GitNexus installed"
 * question stops being a runtime check and becomes an install-time guarantee. That was
 * the whole point of taking the dependency: a check that always succeeds is not a check.
 *
 * PATH remains as the fallback rather than the primary, because a normal `npm install`
 * of this plugin puts `gitnexus` beside it in `node_modules`, where PATH never looks.
 * Keeping the search means a machine with a global install still works if the
 * dependency somehow did not land, and it keeps this repository's own tests runnable
 * without a 1 GB install.
 *
 * Does not execute anything. Spawning the CLI to ask its version would be the direct
 * test, but a confined DSH process denies piped stdio (`spawn EPERM`), which is the
 * same constraint that shaped the maintenance commands — so a probe that only stats the
 * filesystem is the one that works everywhere this plugin runs.
 */
export function findGitnexusCli(options: ToolchainOptions = {}): CliProbeFound | CliProbeMissing {
  if (options.discover === false) return { present: false, probedDirs: 0 };

  const platform = options.platform ?? process.platform;

  // An explicit override wins, so a machine with a non-standard layout — or a test —
  // can name the executable directly.
  const explicit = options.env?.GITNEXUS_CLI ?? process.env.GITNEXUS_CLI;
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) {
    return {
      present: true,
      cliPath: explicit,
      viaNode: explicit.endsWith('.js'),
      source: 'override',
      packageRoot: null,
    };
  }

  const fromDependency = resolveDependencyCli(options);
  if (fromDependency !== null) return fromDependency;

  const entries = effectivePath(options.env).split(path.delimiter).filter((dir) => dir !== '');
  for (const dir of entries) {
    for (const name of cliShimNames(platform)) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate)) {
          return { present: true, cliPath: candidate, viaNode: false, source: 'path', packageRoot: null };
        }
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }

  return { present: false, probedDirs: entries.length };
}

/**
 * The CLI shipped inside the `gitnexus` dependency, if it is installed.
 *
 * Resolved by walking up from this module rather than by asking Node to resolve the
 * package name, because these modules are CommonJS-compiled and a bare `require` of an
 * ESM-only package would throw for a reason unrelated to whether the file exists. Each
 * candidate is a plain `node_modules/gitnexus` directory on the way to the filesystem
 * root, which is exactly where npm and pnpm put it.
 */
function resolveDependencyCli(options: ToolchainOptions): CliProbeFound | null {
  const startDir = options.moduleUrl === undefined ? undefined : safeDirname(options.moduleUrl);
  let dir = startDir ?? undefined;

  // `import.meta.url` is only available in the host half, so the caller may not pass
  // one; without a starting point there is nothing to walk and PATH is the answer.
  if (dir === undefined) return null;

  for (let depth = 0; depth < 24; depth += 1) {
    const candidateRoot = path.join(dir, 'node_modules', 'gitnexus');
    const manifest = path.join(candidateRoot, 'package.json');
    const script = path.join(candidateRoot, 'dist', 'cli', 'index.js');
    try {
      if (existsSync(manifest) && existsSync(script)) {
        return {
          present: true,
          cliPath: script,
          viaNode: true,
          source: 'dependency',
          packageRoot: candidateRoot,
        };
      }
    } catch {
      /* unreadable directory — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Directory of one module url, or `undefined` when it cannot be read as a path. */
function safeDirname(moduleUrl: string): string | undefined {
  try {
    return path.dirname(fileURLToPath(moduleUrl));
  } catch {
    return undefined;
  }
}

/** Resolve the full picture: library tree, CLI shim, and the verdict they imply. */
export function readToolchainStatus(options: ToolchainOptions = {}): ToolchainStatus {
  const packageRoot = findGitnexusRoot(options);
  const packageVersion = packageRoot === null ? null : readGitnexusVersion(packageRoot);
  const cli = findGitnexusCli(options);

  const verdict: ToolchainVerdict =
    packageRoot !== null && cli.present ? 'ready' : packageRoot !== null ? 'library-only' : 'absent';

  return { packageRoot, packageVersion, cli, verdict };
}

/**
 * The one-line explanation the panel and the CLI show, or `null` when everything is
 * present and there is nothing to warn about.
 *
 * Kept here rather than in the browser half so the CLI and the panel cannot describe
 * the same machine state two different ways.
 */
export function toolchainNotice(status: ToolchainStatus): string | null {
  switch (status.verdict) {
    case 'ready':
      return null;
    case 'library-only':
      return (
        '本机有 GitNexus 库但没有 gitnexus 命令（可能只作为依赖安装、未全局链接）。' +
        '下面的命令需要先 `npm i -g gitnexus` 才能直接执行。'
      );
    case 'absent':
      return (
        '本机没有 GitNexus。扫描规则来自本插件内置的回退实现，' +
        '与 GitNexus 自身的忽略规则不完全一致，覆盖差异数字仅供参考。' +
        '初始化索引需要先安装：`npm i -g gitnexus`。'
      );
  }
}
