import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { runStateLabel, runStateTone } from '../format';
import { Button, HAIRLINE, MUTED, SOFT_BG, StateDot, Tag, h, styles } from '../primitives';
import { ClientAnalyzeRun, ClientDelta, ClientMaintenance, ClientMaintenanceCommand } from '../types';

/**
 * Which write the operator asked for. One union rather than booleans because the three
 * are mutually exclusive: `--force` and `--repair-fts` together are contradictory, and
 * the route models them as a mode for the same reason.
 */
export type MaintenanceStartMode = 'refresh' | 'force' | 'repair-fts';

/**
 * The maintenance commands, shown verbatim rather than executed.
 *
 * The plugin deliberately does not run these. Spawning `gitnexus analyze` from a
 * plugin bypasses the host's permission system: nothing would ask the operator
 * whether a thirty-minute write against their working tree was intended. Handing
 * over the exact command keeps the decision — and the approval — on the path the
 * product already audits.
 *
 * Which one is *relevant* depends on whether an index exists, so the applicable
 * command is marked. Presenting both with equal weight on an already-indexed
 * project reads as "you may need to initialize this", which is not true.
 *
 * @param {{maintenance: any, projectPath: string | null, indexed: boolean}} props
 */

export function MaintenanceSection({
  maintenance,
  projectPath,
  indexed,
  run,
  runError,
  delta,
  deltaError,
  now,
  onStartRun,
  onCancelRun,
}: {
  maintenance: ClientMaintenance;
  projectPath: string | null;
  indexed: boolean;
  run: ClientAnalyzeRun | null;
  runError: string | null;
  /**
   * The host's Tier 0 verdict, or null while it is unknown. This is what turns the
   * refresh button from "always enabled" into "enabled because something changed".
   */
  delta?: ClientDelta | null;
  /** Why the delta could not be read, when it failed for a reason worth showing. */
  deltaError?: string | null;
  now: number;
  onStartRun: (mode?: MaintenanceStartMode) => void;
  onCancelRun: () => void;
}) {
  // `projectPath` is part of the prop set for the header, which builds the commands
  // from it; the body does not read it.
  void projectPath;
  const [copied, setCopied] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<'init' | 'full' | 'repair-fts' | null>(null);
  // `RiskConfirmation`'s checkbox is controlled, so the tick has to live here. Without
  // this the box renders but never moves, which is how it looked the first time.
  const [acknowledged, setAcknowledged] = React.useState(false);
  const commands = (Array.isArray(maintenance?.commands) ? maintenance.commands : []).filter(
    // The host only sends the repair command when the index says FTS is missing, but a
    // client that hot-reloaded ahead of the host could still receive it from a host
    // whose route does not understand the mode. Do not offer a control that would
    // silently run a plain refresh under a "repair" label.
    (command) => command.mode !== 'repair-fts' || maintenance.supportsRepair === true,
  );
  if (commands.length === 0) return null;

  // The incremental command is the normal action on both states: it initialises a
  // missing index and refreshes a present one. The full rebuild is an escape hatch
  // for a hung refresh, never "what applies" — marking it applicable on every
  // indexed repository recommended the destructive path by default.
  const applicable = 'init';
  const fullConfirm = confirming === 'full';
  const repairConfirm = confirming === 'repair-fts';
  const confirmCommand = commands.find((c) => c.mode === (confirming ?? 'init'));

  /**
   * The Tier 0 gate.
   *
   * Three states, and the difference between them is the point:
   *   known + clean   → the button says why it is not needed, with an escape hatch
   *   known + dirty   → the button says what changed, then asks
   *   unknown         → no gate at all: a legacy index or a host without the route
   *                     must keep the old behaviour rather than block a refresh it
   *                     cannot justify
   */
  const gate = delta ?? null;
  // `certain` is what separates "measured against the index snapshot" from "the working
  // tree happens to be clean". Only the first can support a 无需刷新 verdict: a manifest
  // without a recorded commit cannot see a commit made after it was written, so treating
  // the second as clean is how a stale index gets reported as current.
  const gateKnown = gate !== null && gate.comparable && gate.certain !== false;
  const gateClean = gateKnown && gate.needsRefresh === false;
  const changed = gate === null ? [] : gate.entries.filter((entry) => entry.kind !== 'excluded');
  const excludedCount = gate?.counts.excluded ?? 0;
  // `supportsForce` is also the host-generation marker: the same 0.1.2 release
  // added the adaptive FTS decision and the project-local GITNEXUS_HOME. An older
  // host's runner does not include either fix, so a refresh can fail on the FTS
  // install or the registry write. Refuse to start it and say why, rather than
  // leaving a button that is known to be wrong on this host.
  const hostCurrent = maintenance.supportsForce === true;
  // Normalised rather than trusted. The declared type says `ClientAnalyzeRun | null`,
  // but a React element built without the prop arrives as `undefined` — which is
  // exactly what happened the first time this component was rendered by a caller that
  // predated the prop. `run === null` alone crashed on it.
  const activeRun = run ?? null;
  const running = activeRun?.state === 'running';
  const at = typeof now === 'number' ? now : Date.now();
  const elapsed =
    activeRun === null ? 0 : Math.max(0, Math.round(((activeRun.finishedAt ?? at) - activeRun.startedAt) / 1000));

  const copy = (command: ClientMaintenanceCommand): void => {
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (text: string) => navigator.clipboard?.writeText(text);
    try {
      const outcome = write(command.shell);
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(() => setCopied(command.mode)).catch(() => setCopied(null));
      } else {
        setCopied(command.mode);
      }
    } catch {
      setCopied(null);
    }
  };

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
    // The old line said "复制后到会话执行". That stopped being the whole story once the
    // plugin could start the run itself, so the sentence says which parts it runs and
    // which it only hands over.
    h(
      'div',
      { style: MUTED },
      hostCurrent
        ? '下面列出的命令都可由本插件执行（走 DSH 的 shell 执行器，沙箱与其它命令一致，本插件不申请扩权）。' +
            '全量重建只应在增量刷新卡死或结果反常时使用。'
        : '当前宿主是旧版本（不包含 FTS 自适应与注册表重定向修复）；重启 DSH 后再执行维护。命令仍可复制。',
    ),

    // The run sits above the commands rather than under one of them: the host holds a
    // single run per repository, and nesting it would imply the two variants have
    // separate ones.
    activeRun === null
      ? null
      : h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '6px 8px',
              border: HAIRLINE,
              borderRadius: '6px',
              background: SOFT_BG,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h(StateDot, { state: runStateTone(activeRun.state) }),
            h('span', { style: { fontWeight: 600 } }, runStateLabel(activeRun.state)),
            activeRun.force === true ? h(Tag, { tone: 'outline' }, '全量') : null,
            activeRun.repairFts === true ? h(Tag, { tone: 'outline' }, '修复 FTS') : null,
            h('span', { style: MUTED }, activeRun.state === 'running' ? `已运行 ${elapsed}s` : `${elapsed}s`),
            h('span', { style: { flex: 1 } }),
            running
              ? h(Button, { variant: 'ghost', onClick: onCancelRun }, '取消')
              // Wrapped, not passed directly: once `onStartRun` takes a mode argument,
              // React's click event would arrive as that argument and every "run again"
              // would become a forced rebuild. Repeating the last mode is also the
              // honest reading of "run again" after a repair or a full rebuild.
              : h(
                  Button,
                  {
                    variant: 'ghost',
                    disabled: !hostCurrent,
                    onClick: () =>
                      onStartRun(
                        activeRun.repairFts === true
                          ? 'repair-fts'
                          : activeRun.force === true
                            ? 'force'
                            : 'refresh',
                      ),
                  },
                  '再次执行',
                ),
          ),
          activeRun.message === null ? null : h('div', { style: MUTED }, activeRun.message),
          // The output is the evidence. A run that reports success with a warning in
          // its log is a different outcome from one that does not, and hiding the text
          // would leave the panel's own verdict as the only thing to check.
          activeRun.output === ''
            ? null
            : h(
                'pre',
                {
                  style: {
                    ...styles.mono,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    maxHeight: '9em',
                    overflow: 'auto',
                  },
                },
                activeRun.output,
              ),
        ),

    runError === null
      ? null
      : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, runError),

    // The Tier 0 verdict sits directly above the buttons it governs. Showing "dirty"
    // without the reason would be the same opacity the gate exists to remove, and
    // showing "clean" without an escape hatch would take a decision away from the
    // operator who has a reason the hashes cannot see (a schema change, a repair).
    deltaError !== null && deltaError !== undefined
      ? h('div', { style: MUTED }, `差量检查失败：${deltaError} —— 刷新仍可直接执行。`)
      : gateKnown
        ? gateClean
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h(StateDot, { state: 'done' }),
                h('span', { style: { fontWeight: 600 } }, '无需刷新'),
                h(Tag, { tone: 'solid' }, '索引已是最新'),
                h('span', { style: MUTED }, gate?.notes[0] ?? ''),
                h('span', { style: { flex: 1 } }),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    disabled: running || !hostCurrent,
                    // Not a bypass of the gate: it is the documented way to refresh when
                    // the operator knows something the content hashes cannot.
                    title: '内容没有变化，但仍要重跑分析（例如索引结构或 schema 变化）',
                    onClick: () => setConfirming('init'),
                  },
                  '仍然刷新',
                ),
              ),
              // The clean verdict can still have changed files — ones the index's own
              // policy skips. Saying "no refresh" without that explanation would read as
              // "git says nothing changed", which is not what was measured.
              excludedCount > 0
                ? h(
                    'div',
                    { style: MUTED },
                    `${excludedCount} 个改动属索引排除范围（超大文件等），刷新也不会收录，因此不计入刷新依据。`,
                  )
                : null,
            )
          : h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '6px 8px',
                  border: HAIRLINE,
                  borderRadius: '6px',
                  background: SOFT_BG,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h(StateDot, { state: 'warning' }),
                h('span', { style: { fontWeight: 600 } }, '索引内容已落后'),
                h(
                  'span',
                  { style: MUTED },
                  `${gate?.counts.modified ?? 0} 改 / ${gate?.counts.added ?? 0} 增 / ` +
                    `${gate?.counts.deleted ?? 0} 删` +
                    (excludedCount > 0 ? ` · ${excludedCount} 个被排除` : '') +
                    ` · 检查用时 ${gate?.durationMs ?? 0}ms`,
                ),
                h('span', { style: { flex: 1 } }),
                gate?.truncated === true ? h(Tag, { tone: 'outline' }, '候选已截断') : null,
              ),
              h(
                'div',
                {
                  style: {
                    ...styles.mono,
                    maxHeight: '7em',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  },
                },
                changed
                  .slice(0, 8)
                  .map((entry) =>
                    `${entry.kind === 'modified' ? 'M' : entry.kind === 'added' ? 'A' : 'D'} ${entry.path}`,
                  )
                  .join('\n') + (changed.length > 8 ? `\n…还有 ${changed.length - 8} 个` : ''),
              ),
              excludedCount > 0
                ? h(
                    'div',
                    { style: MUTED },
                    `${excludedCount} 个改动属索引排除范围（超大文件等），刷新也不会收录，因此不计入刷新依据。`,
                  )
                : null,
            )
        : gate !== null && Array.isArray(gate.notes) && gate.notes.length > 0
          ? // No gate: either the comparison was impossible (legacy manifest, no git) or
            // it was not anchored to the index's commit. Both are "cannot prove it is
            // current", and the notes say which — print them all, because the first one
            // alone explains the cause but not the consequence.
            h(
              'div',
              { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '2px' } },
              gate.notes.slice(0, 3).map((note, index) => h('div', { key: index }, `· ${note}`)),
            )
          : null,

    commands.map((command) => {
      // The host's wording is written for the no-index state ("初始化索引", "该项目还没有
      // … 索引时使用"). Reusing it on an indexed project told the operator to initialise
      // an index that already existed. Only the label and the "when" line are stateful;
      // the command itself is identical.
      const shown =
        command.mode === 'init' && indexed
          ? {
              ...command,
              label: '增量刷新',
              when: '索引落后或有文件改动时使用；未变更文件的解析产物会复用。',
            }
          : command;
      return h(
        'div',
        {
          key: command.mode,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            // The inapplicable ones stay visible — an operator may still want the
            // text — but recede. Repair is not "inapplicable": it is offered precisely
            // because the index says FTS is missing, so it keeps full weight.
            opacity: command.mode === applicable || command.mode === 'repair-fts' ? 1 : 0.55,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { fontWeight: 600 } }, shown.label),
          command.mode === applicable ? h(Tag, { tone: 'solid' }, '当前适用') : null,
          command.destructive ? h(Tag, { tone: 'outline' }, '破坏性') : null,
          h('span', { style: { flex: 1 } }),
          // Each command is executable now, each behind its own confirmation. The
          // force button exists because the host route implements `--force`; a button
          // labelled "全量重建" that quietly ran an incremental refresh would be the
          // exact failure the earlier revision refused to ship.
          command.mode === 'init'
            ? h(
                Button,
                {
                  variant: 'ghost',
                  // The gate is the whole point of Tier 0: a clean tree disables the
                  // normal action and says so, and "仍然刷新" is the way past it.
                  disabled: running || !hostCurrent || gateClean,
                  onClick: () => setConfirming('init'),
                },
                running
                  ? '运行中'
                  : gateClean
                    ? '无需刷新'
                    : hostCurrent
                      ? '执行增量刷新'
                      : '执行增量刷新（需重启）',
              )
            : command.mode === 'repair-fts'
              ? h(
                  Button,
                  { variant: 'ghost', disabled: running || !hostCurrent, onClick: () => setConfirming('repair-fts') },
                  running ? '运行中' : '修复搜索索引',
                )
              : hostCurrent
                ? h(
                    Button,
                    { variant: 'ghost', disabled: running, onClick: () => setConfirming('full') },
                    running ? '运行中' : '全量重建',
                  )
                : h(
                    Button,
                    {
                      variant: 'ghost',
                      disabled: true,
                      title: '当前宿主版本尚未支持 force=1；重启 DSH 后再试，或复制命令执行',
                    },
                    '全量重建（需重启）',
                  ),
          h(
            Button,
            { variant: 'ghost', onClick: () => copy(command) },
            copied === command.mode ? '已复制' : '复制',
          ),
        ),
        h(
          'code',
          {
            style: {
              ...styles.mono,
              display: 'block',
              padding: '6px 8px',
                border: HAIRLINE,
                borderRadius: '6px',
                background: SOFT_BG,
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            },
            command.shell,
          ),
          h('div', { style: MUTED }, shown.when),
          command.caveat !== null && command.caveat !== undefined
            ? h('div', { style: MUTED }, command.caveat)
            : null,
      );
    }),
    Array.isArray(maintenance?.rationale) && maintenance.rationale.length > 0
        ? h(
            'div',
            { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '2px' } },
            maintenance.rationale.map((note, index) => h('div', { key: index }, `· ${note}`)),
          )
        : null,

    // The confirmation. Everything the operator needs before a process touches their
    // working tree goes in `description`, because that is the prop the modal renders:
    // an earlier revision passed this as children and the dialog opened with an empty
    // body and two unlabelled buttons.
    //
    // One dialog, two modes. The full rebuild gets its own title, wording and
    // acknowledgement because it is a different risk: it discards the graph and FTS
    // and can take minutes, while the incremental path reuses unchanged files.
    h(primitives.RiskConfirmation, {
      open: confirming !== null,
      title: repairConfirm ? '修复搜索索引（FTS）？' : fullConfirm ? '执行全量重建？' : '执行增量刷新？',
      description: repairConfirm
        ? '将执行：\n\n' +
          (confirmCommand?.shell ?? 'gitnexus analyze --index-only --repair-fts') +
          '\n\n' +
          '只重建搜索索引（FTS），不重跑分析、不改图，耗时通常在秒级。' +
          '只写入 .gitnexus/，不改动源文件。' +
          '如果 FTS 扩展文件本身缺失（Windows 上常见），修复也会失败 —— 那是上游安装问题，不是索引坏了。' +
          '命令由 DSH 的 shell 执行器运行，沙箱与其它命令一致 —— 本插件不申请扩权。'
        : fullConfirm
          ? '将执行强制全量重建：\n\n' +
            (confirmCommand?.shell ?? 'gitnexus analyze --index-only --force') +
            '\n\n' +
            '这会重建图与 FTS；未变更文件的解析产物仍会复用。' +
            '但耗时以分钟计，索引很大时更久（上限 10 分钟，可随时取消）。' +
            '重建期间索引可能短暂不可用。' +
            '只写入 .gitnexus/，不改动源文件，也不会重写 AGENTS.md / CLAUDE.md。' +
            '命令由 DSH 的 shell 执行器运行，沙箱与其它命令一致 —— 本插件不申请扩权。'
          : '将在项目目录下运行：\n\n' +
            (confirmCommand?.shell ?? 'gitnexus analyze --index-only') +
            '\n\n' +
            '只写入 .gitnexus/，不改动任何源文件，也不会重写 AGENTS.md / CLAUDE.md。' +
            '耗时取决于改动量：无改动时约 7 秒，改动几个文件时实测可到 3 分钟，' +
            '大仓库的初始化或刷新可能更久（上限 10 分钟，可随时取消）。' +
            '命令由 DSH 的 shell 执行器运行，沙箱与其它命令一致 —— 本插件不申请扩权。',
      acknowledgeLabel: fullConfirm
        ? '我了解这会重建图与 FTS、耗时数分钟，并可能让索引短暂不可用'
        : '我了解这会运行一个进程并写入 .gitnexus/',
      cancelLabel: '取消',
      confirmLabel: repairConfirm ? '开始修复' : fullConfirm ? '开始重建' : '执行',
      closeLabel: '关闭',
      // The checkbox is controlled, so it needs state of its own, and it is reset on
      // close: the acknowledgement is per-action rather than remembered.
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => {
        setConfirming(null);
        setAcknowledged(false);
      },
      onConfirm: () => {
        const mode: MaintenanceStartMode = repairConfirm ? 'repair-fts' : fullConfirm ? 'force' : 'refresh';
        setConfirming(null);
        setAcknowledged(false);
        onStartRun(mode);
      },
    }),
  );
}
