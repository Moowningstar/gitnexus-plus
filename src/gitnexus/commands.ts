/**
 * The maintenance commands this plugin hands to the operator.
 *
 * WHY THE TEXT STILL EXISTS AFTER THE BUTTONS
 * -------------------------------------------
 * A first revision spawned `gitnexus analyze` directly from the plugin and exposed
 * it as a button. That was wrong: a plugin that spawns processes bypasses the host's
 * permission system. The correction was not "never run it" but "run it through
 * `ctx.shell`", which is what the analyze runner does. The exact command is still the
 * deliverable here because it is what the confirmation shows, what a failed run can
 * be reproduced with, and what an operator can paste when the deployment has no
 * shell executor at all. The two must not drift: the runner builds its argv from the
 * same decisions this module documents.
 *
 * WHAT MAKES THE COMMANDS NON-OBVIOUS
 * -----------------------------------
 * A bare `gitnexus analyze` does **not** work in every deployment, and the failures
 * are silent-ish. Measured on this machine, under a confined DSH process:
 *
 *   - `ensureHeap` re-spawns the CLI with a larger heap over piped stdio, which a
 *     confined sandbox denies (`spawn EPERM`). `GITNEXUS_MEMORY=off` suppresses the
 *     respawn; `NODE_OPTIONS` supplies the heap it was trying to obtain.
 *   - The FTS extension installs itself out-of-process and fails the same way.
 *     `--skip-fts` builds the index without it.
 *   - The global registry write (`~/.gitnexus/registry.json`) is outside the
 *     workspace and may be denied. `GITNEXUS_HOME` redirects it.
 *
 * `--index-only` on both commands is deliberate and not a sandbox workaround:
 * the default `analyze` also rewrites AGENTS.md, CLAUDE.md and agent skill files
 * inside the repository. A maintenance button must not edit the working tree.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Heap the CLI is given, matching what `ensureHeap` would have asked for. */
const HEAP_MB = 8192;

/**
 * Where this plugin keeps GitNexus's global registry for one repository.
 *
 * `GITNEXUS_HOME` is normally `~/.gitnexus`, outside a confined host's writable
 * scope. Pointing it at a directory inside the project's own `.gitnexus/` keeps the
 * registry write next to the index and inside the workspace — which is the scope the
 * operator already granted. The analysis itself still writes `.gitnexus/lbug`; this
 * only moves the global registry side effect.
 */
export function defaultGitnexusHome(repoPath: string): string {
  return path.join(repoPath, '.gitnexus', 'plugin-home');
}

/**
 * Whether this index says content-level FTS is available.
 *
 * A missing manifest, a legacy manifest, or a status other than `available` all mean
 * "do not attempt FTS". The read is synchronous because both the maintenance-command
 * builder and the analyze runner are synchronous; the manifest is a few kilobytes.
 */
export function ftsAvailable(repoPath: string): boolean {
  for (const name of ['gitnexus.json', 'meta.json']) {
    try {
      const raw = JSON.parse(readFileSync(path.join(repoPath, '.gitnexus', name), 'utf8')) as {
        capabilities?: { fts?: { status?: unknown } };
      };
      // The first manifest that parses is authoritative; falling through to the
      // legacy copy on a `disabled-by-flag` status could resurrect a contradictory
      // `available` from a stale `meta.json`.
      return raw.capabilities?.fts?.status === 'available';
    } catch {
      /* try the other manifest name */
    }
  }
  return false;
}

/**
 * The effective `--skip-fts` decision for one repository.
 *
 * `false` (the default) means **automatic**: skip FTS when the index does not have
 * it, so a refresh in a confined process does not die trying to install an extension
 * out-of-process. `true` forces the flag. There is deliberately no "force FTS on":
 * that is a repair action (`gitnexus analyze --repair-fts`), not an incremental
 * refresh, and hiding a repair behind a config boolean would mislead.
 *
 * The alternative — a static default — was measured wrong in both directions: `true`
 * forces a 21x full rebuild on an index that already has FTS, while `false` makes the
 * refresh fail with `spawn EPERM` on an index that does not.
 */
export function effectiveSkipFts(repoPath: string, configured: boolean): boolean {
  return configured || !ftsAvailable(repoPath);
}

export type MaintenanceMode = 'init' | 'full' | 'repair-fts';

export interface MaintenanceCommand {
  mode: MaintenanceMode;
  label: string;
  /** When the operator should reach for this one. */
  when: string;
  /** The command alone, for reference. */
  argv: string;
  /** The command with the environment it needs, ready to paste. */
  shell: string;
  /** Whether it discards existing index work. */
  destructive: boolean;
  caveat: string | null;
}

export interface MaintenanceOptions {
  platform?: NodeJS.Platform;
  /**
   * Add `--skip-fts`. Off by default, and that default is load-bearing — see the
   * measurement in {@link maintenanceCommands}.
   */
  skipFts?: boolean;
  memoryOff?: boolean;
  gitnexusHome?: string | null;
  /**
   * Offer the FTS repair command. The caller decides from the index's own
   * `capabilities.fts.status`, because this module is deliberately filesystem-free:
   * the exact command text is what a test asserts on, and a hidden manifest read
   * would make the output depend on whatever repository happened to be on disk.
   */
  includeRepair?: boolean;
}

/** The resolved form of {@link MaintenanceOptions}, after defaults are applied. */
interface ResolvedOptions {
  platform: NodeJS.Platform;
  skipFts: boolean;
  memoryOff: boolean;
  gitnexusHome: string | null;
}

/**
 * Build the two commands for a repository.
 *
 * Pure, because the exact text is the deliverable — a reviewer should be able to
 * assert on it without spawning anything.
 *
 * WHY `--skip-fts` IS NOT A DEFAULT
 * ---------------------------------
 * It was one, on the reasoning that the FTS extension installs out-of-process and a
 * confined process denies that (`spawn EPERM`). Measured on a 39-file repository,
 * that reasoning is wrong in the case that matters:
 *
 *   index has FTS + `--skip-fts`   179.22 s   full DB wipe + bulk COPY
 *   index has FTS, no flag           8.57 s   FTS fails to load, degrades cleanly
 *   index has no FTS + `--skip-fts`  8.25 s   changed=0, 39 rows preserved
 *   same, warm                       6.56 s
 *
 * Disabling a search index the store already has forces GitNexus to rebuild the
 * whole graph store, which is the exact opposite of incremental — a 21x penalty on
 * the one transition an operator is most likely to hit. Letting FTS fail on its own
 * costs nothing: it prints a warning and indexes anyway.
 *
 * The flag remains available for the case it was written for, where the extension
 * file is *absent* and the install itself is what fails.
 */
export function maintenanceCommands(repoPath: string, options: MaintenanceOptions = {}): MaintenanceCommand[] {
  const resolved: ResolvedOptions = {
    platform: options.platform ?? process.platform,
    skipFts: options.skipFts === true,
    memoryOff: options.memoryOff !== false,
    gitnexusHome: options.gitnexusHome ?? null,
  };
  const { platform, skipFts, memoryOff, gitnexusHome } = resolved;

  const common = ['analyze', '--index-only'];
  if (skipFts) common.push('--skip-fts');

  const quote = (value: string): string =>
    platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;

  /** Environment assignments, in the syntax of the operator's shell. */
  const envPrefix = (): string => {
    const pairs: Array<[string, string]> = [];
    if (memoryOff) pairs.push(['GITNEXUS_MEMORY', 'off']);
    pairs.push(['NODE_OPTIONS', `--max-old-space-size=${HEAP_MB}`]);
    if (gitnexusHome !== null && gitnexusHome !== '') pairs.push(['GITNEXUS_HOME', gitnexusHome]);

    if (platform === 'win32') {
      return `${pairs.map(([k, v]) => `$env:${k}=${quote(v)}`).join('; ')}; `;
    }
    return `${pairs.map(([k, v]) => `${k}=${quote(v)}`).join(' ')} `;
  };

  const line = (extra: readonly string[]): string => {
    const args = [...common, ...extra, quote(repoPath)];
    return `gitnexus ${args.join(' ')}`;
  };

  return [
    {
      mode: 'init',
      label: '初始化索引',
      when: '该项目还没有 .gitnexus 索引时使用。',
      argv: line([]),
      shell: envPrefix() + line([]),
      destructive: false,
      caveat: skipFts
        ? '--skip-fts 会让一个已有 FTS 的索引清库重建（实测 179s vs 8.5s），非必要不要加。'
        : // The measured range, not the best case. An earlier wording said "秒级（约 7s）"
          // on the strength of a no-change run; five changed files on the same repository
          // took 171 s. Understating this is how an operator concludes the button hung.
          '耗时随改动量增长：无改动约 7s，5 个文件实测约 171s。日志会写 changed/added/deleted。',
    },
    {
      mode: 'full',
      label: '强制全量重构',
      when: '增量刷新卡死或结果反常时的逃生舱。重建图与 FTS，耗时数分钟；未变更文件的解析产物仍会复用。',
      argv: line(['--force']),
      shell: envPrefix() + line(['--force']),
      destructive: true,
      caveat: '--force 重建图与 FTS，未变更文件的解析产物仍会复用。',
    },
    // Offered only when the index says FTS is unavailable — otherwise it is a no-op
    // that looks like a feature. Deliberately **not** built on `common`: that array
    // carries `--skip-fts` in the deployment where FTS is missing, and passing
    // `--skip-fts --repair-fts` asks to repair what it was just told to skip.
    ...(options.includeRepair === true
      ? [
          {
            mode: 'repair-fts' as const,
            label: '修复搜索索引（FTS）',
            when: '面板显示 FTS 不可用、关键词搜索只能按名称匹配时使用。只重建搜索索引，不重跑分析。',
            argv: `gitnexus ${['analyze', '--index-only', '--repair-fts', quote(repoPath)].join(' ')}`,
            shell:
              envPrefix() +
              `gitnexus ${['analyze', '--index-only', '--repair-fts', quote(repoPath)].join(' ')}`,
            destructive: false,
            caveat:
              '只修复搜索索引，不改图。若 FTS 扩展文件本身缺失（Windows 上常见），修复也会失败 —— 那是上游安装问题。',
          },
        ]
      : []),
  ];
}

/** The options {@link commandRationale} needs — a subset of the command options. */
export type RationaleOptions = Pick<ResolvedOptions, 'skipFts' | 'memoryOff' | 'gitnexusHome'>;

/**
 * A one-line explanation of why the environment prefix is there at all, for the
 * panel to show under the commands rather than leaving them looking arbitrary.
 */
export function commandRationale(options: RationaleOptions): string[] {
  const notes: string[] = [];
  if (options.memoryOff) {
    notes.push('GITNEXUS_MEMORY=off：阻止 CLI 用管道 stdio 重启自身（受限环境下会 EPERM）。');
  }
  notes.push(`NODE_OPTIONS=--max-old-space-size=${HEAP_MB}：补上它本想通过重启获得的那份堆。`);
  if (options.skipFts) {
    notes.push('--skip-fts：FTS 扩展需在子进程安装，受限环境下会失败。');
  }
  if (options.gitnexusHome !== null && options.gitnexusHome !== '') {
    notes.push(`GITNEXUS_HOME=${options.gitnexusHome}：把全局注册表写入重定向到受控目录。`);
  }
  notes.push('--index-only：不会改动仓库内的 AGENTS.md / CLAUDE.md / skills 文件。');
  return notes;
}
