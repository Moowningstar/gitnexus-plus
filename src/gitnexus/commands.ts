/**
 * The maintenance commands this plugin hands to the operator.
 *
 * WHY THE PLUGIN DOES NOT RUN THESE ITSELF
 * ---------------------------------------
 * A first revision spawned `gitnexus analyze` directly from the plugin and exposed
 * it as a button. That was wrong, for a reason that has nothing to do with
 * convenience: a plugin that spawns processes bypasses the host's permission
 * system. Nothing would ask the operator whether a thirty-minute write against
 * their working tree was intended, and nothing would leave an audit trail of the
 * escalation. Presenting the command and letting it run through the normal tool
 * path keeps the decision — and the approval — where the product put it.
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

/** Heap the CLI is given, matching what `ensureHeap` would have asked for. */
const HEAP_MB = 8192;

export type MaintenanceMode = 'init' | 'full';

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
        : '增量刷新在稳态下是秒级（小仓库实测约 7s，日志会写 changed/added/deleted）——不需要为了"刷新"而加 --force。',
    },
    {
      mode: 'full',
      label: '强制全量重构',
      when: '增量刷新卡死或结果反常时的逃生舱。会丢弃可复用的解析产物，耗时数分钟。',
      argv: line(['--force']),
      shell: envPrefix() + line(['--force']),
      destructive: true,
      caveat: '--force 重建图与 FTS，未变更文件的解析产物仍会复用。',
    },
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
