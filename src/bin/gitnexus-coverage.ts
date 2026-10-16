#!/usr/bin/env node
/**
 * `gitnexus-coverage` — report what an index left out.
 *
 * Usage:
 *   dsh-gitnexus-coverage [repo-path | -r <alias>] [--json]
 *   dsh-gitnexus-coverage --all       # every registered repository
 *
 * Exit code is 0 even when files were skipped: a skipped bundle is a fact about
 * the repository, not a failure of this tool. Pass `--fail-on-large` to make it a
 * CI gate instead.
 */

import path from 'node:path';
import { analyzeCoverage, formatBytes, type CoverageReport } from '../gitnexus/coverage.js';
import { readRegistry } from '../gitnexus/index-meta.js';

const argv = process.argv.slice(2);

function takeFlag(name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

function takeOption(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

const asJson = takeFlag('--json');
const all = takeFlag('--all');
const failOnLarge = takeFlag('--fail-on-large');
const noLanguages = takeFlag('--no-languages');
const repoAlias = takeOption('-r') ?? takeOption('--repo');
const positional = argv.filter((a) => !a.startsWith('-'));

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (t: string): string => paint('1', t);
const dim = (t: string): string => paint('2', t);
const yellow = (t: string): string => paint('33', t);
const green = (t: string): string => paint('32', t);
const red = (t: string): string => paint('31', t);

/**
 * A repository that could not be analysed, kept in the JSON output so a batch run
 * reports every target rather than stopping at the first failure. It is a distinct
 * shape, not a half-built report: the previous version pushed a fake `CoverageReport`
 * and silenced the type error with a cast, which meant every downstream `.totals`
 * read was a potential crash.
 */
interface FailedReport {
  repo: { path: string };
  error: string;
}

function isFailure(entry: CoverageReport | FailedReport): entry is FailedReport {
  return 'error' in entry;
}

function renderHuman(report: CoverageReport): string {
  const out: string[] = [];
  const { repo, cap, totals, largeFiles, warnings, languages, index } = report;

  out.push('');
  out.push(bold(`  ${repo.name}`) + dim(`  ${repo.path}`));
  if (!repo.indexed) {
    out.push(red('  ✗ 未索引（没有 .gitnexus/gitnexus.json）'));
    out.push('');
    return out.join('\n');
  }
  out.push(
    dim(
      `  索引于 ${repo.indexedAt}  ·  ${repo.branch ?? 'unknown'}@${(repo.lastCommit || 'unknown').slice(0, 8)}` +
        `  ·  GitNexus ${report.analyzer.gitnexusVersion}` +
        (report.analyzer.primitives === 'gitnexus' ? dim(' (复用上游扫描)') : yellow(' (回退扫描)')),
    ),
  );

  out.push('');
  out.push(
    `  扫描 ${bold(String(totals.scanned))}  ·  选中 ${bold(String(totals.selected))}  ·  ` +
      `图内 ${bold(String(totals.indexedInGraph))}  ·  跳过 ${totals.large > 0 ? yellow(bold(String(totals.large))) : '0'}  ·  ` +
      `声明抑制 ${totals.suppressedDeclarations}`,
  );
  out.push(
    dim(
      `  上限 ${cap.text}${cap.source === 'index' ? '（索引记录值）' : cap.source === 'env' ? '（来自 GITNEXUS_MAX_FILE_SIZE）' : '（默认值）'}` +
        `  ·  硬上限 ${cap.maxText}`,
    ),
  );

  if (largeFiles.length > 0) {
    out.push('');
    out.push(bold('  被跳过的超大文件') + dim(`  合计 ${formatBytes(totals.largeBytes)}`));
    const width = Math.min(56, Math.max(...largeFiles.map((f) => f.path.length)));
    for (const file of largeFiles.slice(0, 25)) {
      const p = file.path.length > width ? `…${file.path.slice(-(width - 1))}` : file.path.padEnd(width);
      const label = file.language?.label ?? '';
      const share =
        file.language !== null && file.shareOfLanguage > 0
          ? dim(` ${(file.shareOfLanguage * 100).toFixed(0)}% of ${label}`)
          : '';
      const mini = file.minified?.binary
        ? dim('  ⬢ 二进制')
        : file.minified?.suspect
          ? yellow(`  ⚠ 单行~${Math.round(file.minified.avgLineLength)}字符`)
          : file.generatedHint
            ? dim('  ⚙ 构建产物路径')
            : '';
      out.push(`    ${p}  ${String(file.sizeText).padStart(9)}  ${dim(label)}${share}${mini}`);
    }
    if (largeFiles.length > 25) out.push(dim(`    …还有 ${largeFiles.length - 25} 个`));
  }

  if (languages) {
    out.push('');
    out.push(bold('  语言分布') + dim(`（索引内，按字节 · 共 ${languages.rows.length} 种）`));
    const total = languages.totalBytes || 1;
    for (const row of languages.rows.slice(0, 12)) {
      const pct = ((row.bytes / total) * 100).toFixed(1);
      const bar = '█'.repeat(Math.max(1, Math.round((row.bytes / total) * 24)));
      const band = row.klass === 'parsed' ? green('●') : row.klass === 'recognized' ? yellow('○') : dim('·');
      out.push(
        `    ${band} ${row.label.padEnd(12)} ${pct.padStart(5)}%  ${dim(bar)} ${dim(`${row.files} 文件`)}`,
      );
    }
    if (languages.rows.length > 12) out.push(dim(`    …还有 ${languages.rows.length - 12} 种`));
    out.push(dim('    ● 可解析进图   ○ 仅识别未解析   · 其他'));
  }

  const notable = warnings.filter((w) => w.level === 'warn');
  if (notable.length > 0) {
    out.push('');
    for (const w of notable) out.push(`  ${yellow('⚠')} ${w.message}`);
  }
  const info = warnings.filter((w) => w.level === 'info');
  if (info.length > 0) {
    out.push('');
    for (const w of info) out.push(dim(`  · ${w.message}`));
  }
  if (index.uncoveredCount > 0 || index.staleCount > 0) {
    out.push(
      dim(`  · 覆盖差异：扫描选中但未入索引 ${index.uncoveredCount}，索引中存在但已消失 ${index.staleCount}`),
    );
  }

  out.push('');
  return out.join('\n');
}

async function main(): Promise<void> {
  let targets: string[] = [];

  if (all) {
    const entries = await readRegistry();
    targets = entries.map((e) => e.path);
    if (targets.length === 0) {
      console.error('registry 中没有任何已索引仓库');
      process.exit(1);
    }
  } else if (repoAlias !== undefined) {
    const entries = await readRegistry();
    const hit = entries.find((e) => e.name === repoAlias);
    if (hit === undefined) {
      console.error(`找不到仓库别名: ${repoAlias}`);
      process.exit(1);
    }
    targets = [hit.path];
  } else {
    targets = [positional[0] ?? process.cwd()];
  }

  const reports: Array<CoverageReport | FailedReport> = [];
  for (const target of targets) {
    try {
      reports.push(await analyzeCoverage(path.resolve(target), { includeLanguages: !noLanguages }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!asJson) console.error(`${target}: ${message}`);
      else reports.push({ repo: { path: target }, error: message });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(all ? reports : reports[0], null, 2));
  } else {
    for (const report of reports) {
      if (isFailure(report)) continue;
      if (report.languages !== null || report.repo.indexed) console.log(renderHuman(report));
    }
  }

  if (failOnLarge && reports.some((r) => !isFailure(r) && r.totals.large > 0)) process.exit(2);
}

await main();
