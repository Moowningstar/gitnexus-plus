import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { useNow } from '../clock';
import { runStateLabel, runStateTone } from '../format';
import { Button, HAIRLINE, MUTED, SOFT_BG, Section, StateDot, h, styles } from '../primitives';
import { ClientInstallRun, ClientToolchain } from '../types';

/**
 * What the panel says when GitNexus is not on this machine.
 *
 * THE ORDER IS THE DESIGN
 * -----------------------
 * The install command comes first and is copyable, because that is the answer for most
 * operators: they know their network, their registry and their toolchain, and a command
 * they can run is more useful than a download this plugin performs on their behalf. The
 * plugin-install option is second and behind a confirmation, because making a
 * several-hundred-megabyte download the path of least resistance would be the wrong
 * default for a panel whose job is to report, not to act.
 *
 * Nothing renders when the verdict is `ready` — a permanent "GitNexus is fine" banner is
 * noise in a panel whose whole purpose is to surface problems.
 */
export function ToolchainNotice({
  toolchain,
  run,
  runError,
  onInstall,
  onCancelInstall,
}: {
  toolchain: ClientToolchain | null | undefined;
  run: ClientInstallRun | null;
  runError: string | null;
  onInstall: () => void;
  onCancelInstall: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  // The clock hook runs before the early return: hooks cannot be conditional.
  const activeRun = run ?? null;
  const installing = activeRun?.state === 'running';
  const at = useNow(installing);

  if (toolchain === undefined || toolchain === null || toolchain.verdict === 'ready') return null;

  const elapsed =
    activeRun === null ? 0 : Math.max(0, Math.round(((activeRun.finishedAt ?? at) - activeRun.startedAt) / 1000));
  const libraryOnly = toolchain.verdict === 'library-only';
  const command = 'npm install -g gitnexus';

  const copy = (): void => {
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (text: string) => navigator.clipboard?.writeText(text);
    try {
      const outcome = write(command);
      if (outcome && typeof outcome.then === 'function') outcome.then(() => setCopied(true)).catch(() => setCopied(false));
      else setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return h(
    Section,
    { wide: true, title: libraryOnly ? '缺少 gitnexus 命令' : '本机没有 GitNexus' },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
      h(
        'div',
        { style: { ...MUTED, display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'warning' }),
        h(
          'span',
          null,
          libraryOnly
            ? '找到了 GitNexus 的库，但没有可执行的 gitnexus 命令（可能只作为依赖安装、未全局链接）。读取不受影响；修复后即可执行增量刷新。'
            : '本插件读取 .gitnexus/gitnexus.json —— 那份文件由 GitNexus 分析仓库产生，包含每个函数定义、符号关系与执行流。没有它就没什么可展示的。',
        ),
      ),

      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { fontWeight: 600 } }, '① 自己安装（推荐）'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h(
            'code',
            {
              style: {
                ...styles.mono,
                flex: '1 1 auto',
                padding: '6px 8px',
                border: HAIRLINE,
                borderRadius: '6px',
                background: SOFT_BG,
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            },
            command,
          ),
          h(Button, { variant: 'ghost', onClick: copy }, copied ? '已复制' : '复制'),
        ),
        h(
          'div',
          { style: MUTED },
          '用你能访问到的源安装即可 —— 本插件不假设任何网络，也不会自行下载。',
        ),
      ),

      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { fontWeight: 600 } }, '② 授权本插件安装'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          installing
            ? h(Button, { variant: 'ghost', onClick: onCancelInstall }, `取消（已进行 ${elapsed}s）`)
            : h(Button, { variant: 'ghost', onClick: () => setConfirming(true) }, '授权并安装'),
          h(
            'span',
            { style: MUTED },
            '装到插件自己的目录，用你已配置的 npm 源，不改全局前缀、不需要管理员权限；' +
              '若当前项目还没有索引，装完会继续初始化一次。',
          ),
        ),
        activeRun === null
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '2px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h(StateDot, { state: runStateTone(activeRun.state) }),
                h('span', { style: { fontWeight: 600 } }, runStateLabel(activeRun.state)),
                h('span', { style: MUTED }, installing ? `已运行 ${elapsed}s` : `${elapsed}s`),
              ),
              activeRun.message === null ? null : h('div', { style: MUTED }, activeRun.message),
              activeRun.output === ''
                ? null
                : h(
                    'pre',
                    { style: { ...styles.mono, margin: 0, whiteSpace: 'pre-wrap', maxHeight: '9em', overflow: 'auto' } },
                    activeRun.output,
                  ),
            ),
        runError === null ? null : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, runError),
      ),

      h(primitives.RiskConfirmation, {
        open: confirming,
        title: '授权本插件安装 GitNexus？',
        description:
          '本插件将执行：\n\nnpm install --prefix <插件数据目录>/gitnexus gitnexus@^1.6.12\n\n' +
          '· 从你已配置的 npm 源下载约 500 MB ~ 1 GB\n' +
          '· 需要几分钟；网络慢或需要本地编译时更久\n' +
          '· 会在本机运行这些包的安装期构建脚本（原生数据库与解析器需要本地编译）\n' +
          '· 安装到插件自己的目录，不改动你的全局 npm 前缀\n' +
          '· 安装成功后，若当前项目尚无索引，会继续运行一次 ' +
          '`gitnexus analyze --index-only`（只写 .gitnexus/，不改源文件）\n\n' +
          '命令走 DSH 的 shell 执行器，沙箱与其它命令一致 —— 本插件不申请扩权。',
        acknowledgeLabel: '我已了解这会下载数百 MB、在本机编译原生模块，并在需要时初始化当前项目',
        cancelLabel: '取消',
        confirmLabel: '授权并开始',
        closeLabel: '关闭',
        acknowledged,
        onAcknowledgedChange: setAcknowledged,
        onCancel: () => {
          setConfirming(false);
          setAcknowledged(false);
        },
        onConfirm: () => {
          setConfirming(false);
          setAcknowledged(false);
          onInstall();
        },
      }),
    ),
  );
}
