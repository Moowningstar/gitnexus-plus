import { compactNumber } from '../format';
import { HAIRLINE, MUTED, SOFT_BG, Section, h } from '../primitives';
import { ClientProject } from '../types';

/**
 * The workspace is often a container rather than one project. The header switcher can
 * change which one the cards describe, but it cannot answer "how big is this workspace
 * and what is in it" — every card below is scoped to the selected project. This card
 * is the one place the projects are added up together.
 *
 * It is deliberately client-side: `findIndexProjects` already returns each project's
 * manifest stats, so merging them costs no extra host round-trip and cannot disagree
 * with the switcher.
 */

export interface WorkspaceTotals {
  indexed: number;
  unindexed: number;
  files: number;
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
  embeddings: number;
}

/** Sum the manifest stats of every indexed project below the workspace. */
export function aggregateProjects(projects: ClientProject[]): WorkspaceTotals {
  const totals: WorkspaceTotals = {
    indexed: 0,
    unindexed: 0,
    files: 0,
    nodes: 0,
    edges: 0,
    communities: 0,
    processes: 0,
    embeddings: 0,
  };
  for (const project of projects) {
    if (project.kind === 'index') {
      totals.indexed += 1;
      const stats = project.stats;
      if (stats !== null && stats !== undefined) {
        totals.files += stats.files;
        totals.nodes += stats.nodes;
        totals.edges += stats.edges;
        totals.communities += stats.communities;
        totals.processes += stats.processes;
        totals.embeddings += stats.embeddings;
      }
    } else if (project.kind === 'git') {
      totals.unindexed += 1;
    }
  }
  return totals;
}

const MAX_ROWS = 8;

/**
 * Aggregate view for a multi-project workspace. Returns null for a single project:
 * there is nothing to aggregate, and the per-project cards already say the same thing.
 */
export function WorkspaceOverview({
  projects,
  activePath,
  onSelectProject,
}: {
  projects: ClientProject[];
  activePath: string | null;
  onSelectProject?: (path: string) => void;
}) {
  const indexed = projects.filter((project) => project.kind === 'index');
  if (indexed.length < 2) return null;
  const totals = aggregateProjects(projects);
  const rows = [...indexed]
    .sort((a, b) => (b.stats?.nodes ?? 0) - (a.stats?.nodes ?? 0) || a.path.localeCompare(b.path))
    .slice(0, MAX_ROWS);

  return h(
    Section,
    {
      wide: true,
      title: '工作区概览',
      meta: h(
        'span',
        { style: { ...MUTED, fontSize: '11px' } },
        `${totals.indexed} 个已索引` + (totals.unindexed > 0 ? ` · ${totals.unindexed} 个未索引` : ''),
      ),
    },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      h(
        'div',
        { style: { ...MUTED, fontSize: '11px' } },
        `合计 ${compactNumber(totals.files)} 个文件 · ${compactNumber(totals.nodes)} 个符号 · ` +
          `${compactNumber(totals.edges)} 条关系 · ${compactNumber(totals.communities)} 个社区 · ` +
          `${compactNumber(totals.processes)} 条流程`,
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        rows.map((project) =>
          h(
            'div',
            {
              key: project.path,
              role: 'button',
              tabIndex: 0,
              title: project.path,
              onClick: () => onSelectProject?.(project.path),
              onKeyDown: (event: { key: string }) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectProject?.(project.path);
              },
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
                gap: '8px',
                alignItems: 'center',
                padding: '4px 6px',
                border: HAIRLINE,
                borderRadius: '4px',
                background: project.path === activePath ? SOFT_BG : 'transparent',
                cursor: onSelectProject === undefined ? 'default' : 'pointer',
                fontSize: '11px',
              },
            },
            h(
              'span',
              { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              project.relPath === '' ? `${project.name}（本工作区）` : project.relPath,
            ),
            h('span', { style: { ...MUTED, textAlign: 'right' } }, `${compactNumber(project.stats?.nodes ?? 0)} 符号`),
            h('span', { style: { ...MUTED, textAlign: 'right' } }, `${compactNumber(project.stats?.files ?? 0)} 文件`),
            h('span', { style: { ...MUTED, textAlign: 'right' } }, project.complete ? '完整' : '缺图'),
          ),
        ),
      ),
      indexed.length > MAX_ROWS
        ? h('div', { style: { ...MUTED, fontSize: '11px' } }, `还有 ${indexed.length - MAX_ROWS} 个项目；用标题栏切换器查看。`)
        : null,
      totals.unindexed > 0
        ? h('div', { style: { ...MUTED, fontSize: '11px' } }, `${totals.unindexed} 个 git 项目尚未建索引，未计入合计。`)
        : null,
    ),
  );
}
