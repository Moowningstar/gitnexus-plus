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
import path from 'node:path';
import { findGitnexusRoot, readGitnexusVersion } from './root.js';

/**
 * Filenames a `gitnexus` CLI shim can have, in probe order.
 *
 * Written out rather than derived from `PATHEXT`, for the reason `root.ts` already
 * documents: under nvm-for-windows the shim is `gitnexus.ps1`, and `PATHEXT` does not
 * list `.ps1`, so extension-driven discovery silently finds nothing on exactly the
 * machines where the CLI is installed.
 */
export const CLI_SHIM_NAMES: readonly string[] = [
  'gitnexus',
  'gitnexus.cmd',
  'gitnexus.exe',
  'gitnexus.bat',
  'gitnexus.ps1',
];

export interface CliProbeFound {
  present: true;
  /** Absolute path to the shim that was found. */
  shimPath: string;
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
  /** Skips discovery entirely, returning an `absent` verdict — for tests. */
  discover?: boolean;
}

/**
 * Look for a `gitnexus` shim in every PATH entry.
 *
 * Does not execute anything. Spawning the CLI to ask its version would be the direct
 * test, but a confined DSH process denies piped stdio (`spawn EPERM`), which is the
 * same constraint that shaped the maintenance commands — so a probe that only stats
 * the filesystem is the one that works everywhere this plugin runs.
 */
export function findGitnexusCli(options: ToolchainOptions = {}): CliProbeFound | CliProbeMissing {
  if (options.discover === false) return { present: false, probedDirs: 0 };

  const env = { ...process.env, ...(options.env ?? {}) };
  const entries = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');

  // An explicit override wins, so a machine with a non-standard layout — or a test —
  // can name the shim directly.
  const override = env.GITNEXUS_CLI;
  if (typeof override === 'string' && override !== '' && existsSync(override)) {
    return { present: true, shimPath: override };
  }

  for (const dir of entries) {
    for (const name of CLI_SHIM_NAMES) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate)) return { present: true, shimPath: candidate };
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }

  return { present: false, probedDirs: entries.length };
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
