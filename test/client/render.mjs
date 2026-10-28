/**
 * Render tests: the pure view against every fixture state the panel can hold.
 *
 * Only `report` and `project` leave this file: the maintenance and graph suites render
 * against the same report, so they receive it instead of rebuilding it.
 */

/** @param {Record<string, any>} ctx */
export function renderSuite(ctx) {
  const { I, viewProps, search, maintenance, split, current, diverged, behind, quality, caps, plain, bare, shell, withHookFrame, check, section, render, readFileSync, path, root } = ctx;

  section('render: populated report');

  const report = {
    repo: {
      path: 'D:\\demo',
      name: 'demo',
      indexed: true,
      metaFile: 'gitnexus.json',
      indexedAt: '2026-10-16T03:31:31.049Z',
      lastCommit: 'b51f2560deadbeef',
      branch: 'main',
    },
    analyzer: { gitnexusVersion: '1.6.12', primitives: 'gitnexus' },
    cap: { bytes: 524288, text: '512.0 KB', source: 'index', defaultText: '512.0 KB', maxText: '32.0 MB' },
    totals: { scanned: 120, selected: 118, large: 2, suppressedDeclarations: 0, indexedInGraph: 118, largeBytes: 3145728, scannedBytes: 4194304 },
    largeFiles: [
      {
        path: 'dist/app.min.js',
        size: 2097152,
        sizeText: '2.0 MB',
        language: { key: 'javascript', label: 'JavaScript', color: '#f1e05a', klass: 'parsed' },
        minified: { suspect: true, avgLineLength: 120000, estimatedLines: 18 },
        generatedHint: true,
        shareOfLanguage: 0.62,
      },
      {
        path: 'CHANGELOG.old.md',
        size: 1048576,
        sizeText: '1.0 MB',
        language: { key: 'markdown', label: 'Markdown', color: '#8b949e', klass: 'recognized' },
        minified: { suspect: false, avgLineLength: 44, estimatedLines: 23000 },
        generatedHint: false,
        shareOfLanguage: 0.35,
      },
    ],
    attribution: { oversizeCount: 2, oversizeBytes: 3145728, oversizeShareOfScanned: 0.75 },
    index: { uncoveredCount: 0, uncoveredSample: [], staleCount: 0, staleSample: [], dirtyPaths: [] },
    warnings: [
      { level: 'warn', code: 'large-files-skipped', message: '2 个文件超过上限被跳过', evidence: {} },
      { level: 'warn', code: 'minified-dominates-language', message: 'dist/app.min.js 疑似压缩产物', evidence: {} },
      { level: 'info', code: 'cap-not-recorded', message: '未记录上限', evidence: {} },
    ],
    languages: {
      rows: [
        { key: 'typescript', label: 'TypeScript', color: '#3178c6', klass: 'parsed', files: 90, bytes: 1000000 },
        { key: 'javascript', label: 'JavaScript', color: '#f1e05a', klass: 'parsed', files: 10, bytes: 500000 },
        { key: 'markdown', label: 'Markdown', color: '#8b949e', klass: 'recognized', files: 20, bytes: 100000 },
      ],
      totalFiles: 120,
      totalBytes: 1600000,
      largeExcluded: [],
    },
    graph: { files: 120, nodes: 26788, edges: 46713, communities: 512, processes: 248, embeddings: 0, edgesPerNode: 1.7438 },
    capabilities: {
      graph: { provider: 'ladybugdb', status: 'available' },
      fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'extension-unavailable' },
      vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable' },
    },
    staleness: {
      state: 'diverged',
      indexedCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      aheadBehind: { behind: 2, ahead: 1 },
      gitAvailable: true,
    },
    provenance: {
      schemaFingerprint: '60fc01e4e4ed',
      contentRetention: 'full',
      ftsProfile: 'full',
      analysisFeatures: { 'graph.class-framework-annotations': 1 },
      crossLanguageProperties: 25,
      runnerCliVersion: '1.6.12',
    },
    graphQuality: { counts: { unwrap: 272, map: 163 }, totalSites: 435 },
    activity: {
      window: { sinceDays: 90, truncated: true },
      totals: { commits: 300, authors: 12, bots: 1, insertions: 12345, deletions: 6789, verdicts: { indexed: 91, excluded: 60, missing: 2 } },
      authors: [
        { name: 'Ada', email: 'ada@example.com', commits: 100, insertions: 9000, deletions: 4000, files: 80, lastCommit: '2026-10-16T00:00:00Z', bot: false },
        { name: 'dependabot[bot]', email: 'bot@github.com', commits: 80, insertions: 300, deletions: 200, files: 12, lastCommit: '2026-10-15T00:00:00Z', bot: true },
      ],
      byChanges: [
        { path: 'src/hot.ts', changes: 54, insertions: 900, deletions: 100, lastChange: '2026-10-16T00:00:00Z', indexed: true, verdict: 'indexed' },
        { path: 'src/lock.json', changes: 30, insertions: 10, deletions: 10, lastChange: '2026-10-15T00:00:00Z', indexed: false, verdict: 'excluded' },
        { path: 'src/fresh.ts', changes: 12, insertions: 50, deletions: 5, lastChange: '2026-10-16T01:00:00Z', indexed: false, verdict: 'missing' },
      ],
      byRecency: [
        { path: 'src/fresh.ts', changes: 12, insertions: 50, deletions: 5, lastChange: '2026-10-16T01:00:00Z', indexed: false, verdict: 'missing' },
      ],
      branches: [
        { name: 'main', lastCommitDate: '2026-10-16T00:00:00Z', lastAuthor: 'Ada', current: true },
        { name: 'feature/x', lastCommitDate: '2026-10-10T00:00:00Z', lastAuthor: 'Bob', current: false },
      ],
      currentBranch: 'main',
      histogram: {
        bucketDays: 7,
        buckets: [
          { label: '2026-09-25', commits: 12, insertions: 400, deletions: 90 },
          { label: '2026-10-02', commits: 0, insertions: 0, deletions: 0 },
          { label: '2026-10-09', commits: 31, insertions: 900, deletions: 120 },
        ],
      },
      cross: {
        rows: [
          { verdict: 'indexed', files: 91, changes: 210, insertions: 9000, deletions: 4000 },
          { verdict: 'excluded', files: 60, changes: 80, insertions: 300, deletions: 200 },
          { verdict: 'missing', files: 2, changes: 40, insertions: 120, deletions: 20 },
        ],
        totalFiles: 153,
        totalChanges: 330,
      },
      baseline: {
        ref: 'abc12345def67890',
        available: true,
        shortSha: 'abc12345',
        date: '2026-10-01T00:00:00Z',
        subject: 'baseline',
        author: 'Ada',
        commits: 4,
        files: 3,
        insertions: 120,
        deletions: 30,
        changedFiles: [
          { path: 'src/fresh.ts', changes: 1, insertions: 50, deletions: 5, lastChange: '2026-10-01T00:00:00Z', indexed: false, verdict: 'missing' },
        ],
      },
      timeline: [
        {
          sha: 'deadbeefcafebabe',
          shortSha: 'deadbeef',
          date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          author: 'Ada',
          subject: 'Add fresh module',
          files: 2,
          insertions: 50,
          deletions: 5,
          verdict: 'missing',
        },
      ],
    },
  };

  const repos = [
    { path: 'D:\\demo', name: 'demo' },
    { path: 'D:\\other', name: 'other' },
  ];

  const view = render(I.CoverageView, { report, ...viewProps });

  check('a settled report shows no progress bar', !view.tags.includes('progress'));

  // Regression guard for React #310: the panel renders with `report === null` while
  // the first request is in flight, then renders again with the report. A hook
  // declared after the loading/no-index early returns changes the hook count between
  // those two renders and crashes the whole sidebar.
  const panelSource = readFileSync(path.join(root, 'src/client/views/coverage-view.ts'), 'utf8');
  const activityHookAt = panelSource.indexOf('const [ownActivityDays');
  const reportGuardAt = panelSource.indexOf('if (report === null)');
  check(
    'CoverageView declares its activity state before the loading return',
    activityHookAt >= 0 && reportGuardAt >= 0 && activityHookAt < reportGuardAt,
    `hook@${activityHookAt}, guard@${reportGuardAt}`,
  );

  const loadingView = render(I.CoverageView, {
    report: null,
    ...viewProps,
    busy: true,
    error: null,
  });
  check(
    'the first read shows an indeterminate progress bar',
    loadingView.tags.includes('progress') && loadingView.text.includes('正在读取索引'),
    loadingView.text.slice(0, 300),
  );

  const numericLoadingView = render(I.CoverageView, {
    report: null,
    ...viewProps,
    busy: true,
    progress: { percent: 42, label: '扫描文件 12/30' },
  });
  check(
    'host progress is rendered as a number and a phase',
    numericLoadingView.text.includes('42%') && numericLoadingView.text.includes('扫描文件 12/30'),
    numericLoadingView.text.slice(0, 300),
  );

  const refreshingView = render(I.CoverageView, {
    report,
    ...viewProps,
    busy: true,
    error: null,
  });
  check(
    'a manual refresh shows progress above the existing report',
    refreshingView.tags.includes('progress') && refreshingView.text.includes('正在刷新索引'),
    refreshingView.text.slice(0, 300),
  );

  check('renders without throwing', view.text.length > 0);
  // A `<select>` is now the timeline range control, not a project picker. Assert the
  // resolved path and that the unresolved-workspace state is absent.
  check(
    'shows the project path instead of an unresolved workspace',
    view.text.includes('D:\\demo') && !view.text.includes('未解析到工作区'),
  );
  check('shows the maintenance commands', view.text.includes('维护命令') && view.text.includes('强制全量重构'));
  // On an indexed project the incremental command is the normal action and must not
  // read as "initialize"; the full rebuild is an escape hatch, never the applicable one.
  check('an indexed project shows 增量刷新, not 初始化索引', view.text.includes('增量刷新') && !view.text.includes('初始化索引'));
  check('marks the incremental command as applicable', view.text.includes('当前适用'));
  check('both commands remain visible', view.text.includes('增量刷新') && view.text.includes('强制全量重构'));
  check('offers an executable full rebuild', view.text.includes('全量重建'));
  check('shows the totals line', view.text.includes('扫描 120'));
  check('shows the skipped-file count', view.text.includes('被跳过的超大文件'));
  check('lists each skipped file', view.text.includes('dist/app.min.js') && view.text.includes('CHANGELOG.old.md'));
  check('flags the minified file', view.text.includes('单行'));
  // The cap now renders as a value plus a separate source hint in the metric grid,
  // rather than the two concatenated into one string.
  check(
    'shows the size cap and where it came from, in the panel language',
    view.text.includes('512.0 KB') && view.text.includes('索引记录'),
    view.text.slice(0, 400),
  );
  check('renders the keyword search card', view.text.includes('关键词搜索') && view.text.includes('搜索'));
  check('renders a search input', view.tags.includes('input'));
  const address = I.fileResourceAddress('sess-1', 'src/a b.ts');
  check(
    'builds the platform file address with line-compatible encoding',
    address === 'dsh-resource://file/session/sess-1/src/a%20b.ts',
    address,
  );
  check(
    'normalizes Windows separators in the file address',
    I.fileResourceAddress('sess-1', 'src\\client\\index.ts') ===
      'dsh-resource://file/session/sess-1/src/client/index.ts',
  );
  check('the result row offers an open action, not only copy', view.text.includes('点击结果打开文件'));
  check(
    'renders a search hit with its kind, name and path',
    view.text.includes('analyzeCoverage') && view.text.includes('src/gitnexus/coverage.ts'),
    view.text.slice(0, 500),
  );
  check('names the search scope, not a full-text claim', view.text.includes('按符号名与文件路径'));
  check('renders the language legend', view.text.includes('TypeScript') && view.text.includes('JavaScript'));
  check('renders the notable warning text', view.text.includes('2 个文件超过上限被跳过'));
  check('renders the context warning separately', view.text.includes('未记录上限'));
  check('language percentages appear', /TypeScript\s+62\.5%/.test(view.text), view.text.slice(0, 200));

  section('render: chart surfaces');
  check(
    'renders the coverage ring with its value and caption',
    view.text.includes('98.3%') && view.text.includes('覆盖'),
    view.text.slice(0, 200),
  );
  check('the ring is an svg with an accessible label', view.tags.includes('svg'));
  check('renders a metric grid of the graph composition', view.text.includes('符号') && view.text.includes('社区'));
  check('offers the language metric switch', view.text.includes('按字节') && view.text.includes('按文件'));
  check('names the active language metric in the footnote', view.text.includes('按字节计的占比'));
  check('renders the commit histogram', view.text.includes('每') && /峰值/.test(view.text), view.text.slice(-500));
  // The panel is a card grid, not a vertical stack: at a wide pane a single column of
  // full-width cards stretches every row across a metre of empty space.
  check(
    'every section renders as a card element',
    // Exactly the nine cards: 关键词搜索, 索引概览, 语言分布, 需要注意 (as applicable),
    // 解析质量与溯源, 被跳过的超大文件, Git 活动, 维护命令, 3D 视图. Pinned rather than a
    // floor, because the failure this guards against is a section quietly losing its
    // card wrapper — which shows up as a lower count, not a higher one.
    view.tags.filter((t) => t === 'section').length === 9,
    'sections=' + view.tags.filter((t) => t === 'section').length,
  );
  check(
    'the language and quality cards are adjacent (they stack beside the overview)',
    // The overview spans two grid rows; `语言分布` lands in the first and `解析质量与溯源`
    // in the second, so these two must be consecutive in render order. `需要注意` is full
    // width and comes later, so it must not sit between them. Text positions are the only
    // ordering evidence available from a rendered tree.
    view.text.indexOf('语言分布') < view.text.indexOf('解析质量与溯源') &&
      view.text.indexOf('解析质量与溯源') < view.text.indexOf('需要注意'),
    view.text.slice(0, 400),
  );
  check(
    'warnings and context warnings share one card',
    // One card, two volumes: amber boxes for the loud ones, quiet rows for the rest.
    view.text.includes('需要注意 · 3') && view.text.includes('未记录上限'),
    view.text.slice(0, 400),
  );
  check(
    'every section is expanded — nothing is hidden behind a click',
    // Three sections used to be folded away behind a disclosure row. Inside a card
    // the click bought nothing, so every section now renders its body unconditionally.
    view.text.includes('增量刷新') && view.text.includes('未解析接收者') && view.text.includes('已索引'),
    view.text.slice(0, 300),
  );
  check(
    'the summary line is not rendered twice',
    (view.text.match(/扫描 120/g) ?? []).length === 1,
    String((view.text.match(/扫描 120/g) ?? []).length),
  );

  section('render: git and graph enrichment');
  // File coverage and graph contents are one card now, split by the 文件 / 图谱
  // group labels rather than by a card border.
  check(
    'the overview card carries both file and graph metrics',
    view.text.includes('文件') && view.text.includes('图谱') && view.text.includes('26.8k'),
    view.text.slice(0, 300),
  );
  check('the merged card keeps the capability list', view.text.includes('查询能力') && view.text.includes('ladybugdb'));
  check('renders edge-per-node ratio', view.text.includes('1.74'));
  check('renders capability labels', view.text.includes('查询能力') && view.text.includes('关键词搜索'));
  check(
    'renders an unavailable capability reason',
    view.text.includes('扩展无法加载') && view.text.includes('仅按名称/路径匹配'),
    view.text.slice(0, 400),
  );
  check('renders staleness as diverged', view.text.includes('已偏离'), view.text.slice(0, 400));
  // The short verdict is in the pinned header; the full sentence stays in the body for
  // the states that need explaining. Pinning it is the point: it used to scroll away.
  check(
    'the staleness verdict sits in the pinned header, above the cards',
    view.text.indexOf('已偏离索引提交') !== -1 &&
      view.text.indexOf('已偏离索引提交') < view.text.indexOf('索引概览'),
    view.text.slice(0, 400),
  );
  check(
    'staleness does not fake a "behind N" for a diverged head',
    // Scoped to a count: the maintenance copy legitimately says "索引落后或…" without
    // claiming how far, and a bare substring check confused that with a stale index.
    !/落后\s*\d+/.test(view.text),
    view.text.slice(0, 400),
  );
  check('renders the git activity section title', view.text.includes('Git 活动'), view.text.slice(0, 400));
  // The header must name the window the reader is looking at (the timeline's 7-day
  // default), not the 90-day fetch window the data was collected over.
  check(
    'renders the git activity window in days',
    view.text.includes('Git 活动 · 近 7 天') && !view.text.includes('Git 活动 · 近 90 天'),
    view.text.slice(0, 400),
  );
  // The header picker was removed: the rows themselves are the entry point, so the header
  // stays a status line instead of a second navigation control.
  check(
    'the activity header no longer carries a file picker',
    !view.text.includes('文件时间线…') && view.text.includes('src/fresh.ts'),
    view.text.slice(0, 500),
  );
  check(
    'renders the activity × index cross-tab',
    view.text.includes('活动 × 索引交叉对比') && view.text.includes('330 次变更'),
    view.text.slice(-800),
  );
  check(
    'renders the index baseline review',
    view.text.includes('索引基线审查') && view.text.includes('abc12345') && view.text.includes('4 个提交'),
    view.text.slice(-800),
  );
  // Four lists over one window were the density problem: one renders, and the control
  // names the others with their counts so nothing is hidden without a trace.
  check(
    'the activity card renders one file list at a time',
    view.text.includes('基线以来 3') &&
      view.text.includes('改动最频繁 3') &&
      view.text.includes('最近改动 1') &&
      // A path only the by-changes list carries must stay unrendered while the baseline
      // view is selected — otherwise "one list" is a claim about styling, not about DOM.
      !view.text.includes('src/hot.ts'),
    view.text.slice(-1200),
  );
  check(
    'the cross table sits behind one disclosure',
    view.tags.includes('details') && view.text.includes('更多统计 · 活动 × 索引交叉对比、提交者'),
    view.text.slice(-500),
  );
  check(
    'the commit timeline starts folded and keeps its count visible',
    // The parts are separate spans now (caret / label / count), so the joined text carries
    // a space between them instead of the interpunct it used to carry inside one string.
    view.text.includes('提交时间线 近 7 天') &&
      // The fold is a real button now: the caret is the collapsed marker, and the label
      // carries the count instead of a second "展开" word.
      view.text.includes('▸') &&
      // The rows behind the fold must not be rendered until it is opened.
      !view.text.includes('Add fresh module'),
    view.text.slice(-800),
  );
  check(
    'offers 7/14/30-day project timeline ranges',
    view.text.includes('7 天') && view.text.includes('14 天') && view.text.includes('30 天'),
    view.text.slice(-500),
  );

  const fileTimeline = render(I.FileHistorySection, {
    filePath: 'src/fresh.ts',
    history: {
      path: 'src/fresh.ts',
      available: true,
      days: 7,
      commits: 1,
      insertions: 50,
      deletions: 5,
      timeline: [
        {
          sha: 'deadbeefcafebabe',
          shortSha: 'deadbeef',
          date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          author: 'Ada',
          subject: 'Add fresh module',
          insertions: 50,
          deletions: 5,
        },
      ],
    },
    busy: false,
    error: null,
    onClose: () => {},
  });
  check(
    'renders a selected file timeline',
    fileTimeline.text.includes('文件时间线') &&
      fileTimeline.text.includes('src/fresh.ts') &&
      fileTimeline.text.includes('deadbeef') &&
      fileTimeline.text.includes('Add fresh module') &&
      fileTimeline.text.includes('近 7 天 · 1 提交'),
    fileTimeline.text.slice(0, 500),
  );

  // A patch is a code block with history: the frame, the language tag and the copy
  // action come from how the chat renders fences; the gutters and hunk bars are what a
  // diff needs on top of that.
  const patchView = render(I.DiffView, {
    path: 'notes.md',
    busy: false,
    error: null,
    diff: {
      available: true,
      truncated: false,
      patch:
        '@@ -10,2 +10,3 @@ function main() {\n' +
        '-const a = 1;\n' +
        '+const a = 2;\n' +
        '+const b = 3;\n' +
        ' const c = 4;',
    },
  });
  check(
    'the diff header names the language and the change counts',
    patchView.text.includes('改动 · 文本') && patchView.text.includes('+2') && patchView.text.includes('−1'),
    patchView.text.slice(0, 300),
  );
  check(
    'the diff rows carry both line-number gutters',
    patchView.styles.some((style) => String(style.gridTemplateColumns || '').startsWith('3.2em 3.2em')),
    JSON.stringify(patchView.styles.slice(0, 3)),
  );
  // Every clickable piece of chrome has to be recognisable without hovering: the whole
  // point of the shared inline-button style is that border + fill + pointer travel
  // together, so a test can check the combination instead of individual words.
  check(
    'the diff copy control is dressed as a button',
    patchView.styles.some(
      (style) =>
        style.cursor === 'pointer' &&
        typeof style.border === 'string' &&
        style.border.includes('solid') &&
        typeof style.background === 'string',
    ),
    JSON.stringify(patchView.styles.slice(0, 6)),
  );
  check(
    'the diff marks added lines by background, not only by text colour',
    patchView.styles.some((style) => String(style.background || '').startsWith('rgba(63, 185, 80')),
    JSON.stringify(patchView.styles.filter((style) => style.background)),
  );
  check(
    'the diff body keeps the patch lines',
    patchView.text.includes('const b = 3;') && patchView.text.includes('@@ -10,2 +10,3 @@'),
    patchView.text.slice(0, 400),
  );

  // The diff body is tokenized by the plugin's own scanner: no highlighter is exposed to
  // plugins, and bundling one is not possible in this single-artifact build.
  section('highlight: diff line tokenizer');
  check(
    'languageOf maps extensions to a rule set',
    I.languageOf('a/b.tsx') === 'ts' &&
      I.languageOf('x.PY') === 'python' &&
      I.languageOf('run.ps1') === 'powershell' &&
      I.languageOf('README.md') === null,
    JSON.stringify([I.languageOf('a/b.tsx'), I.languageOf('x.PY'), I.languageOf('run.ps1'), I.languageOf('README.md')]),
  );
  {
    const tokens = I.highlightLine('const x = "a // b"; // tail', 'ts', { blockComment: false });
    const kinds = tokens.map((t) => t.kind).join(',');
    check('a string keeps a comment marker inside it', kinds.includes('string') && kinds.includes('comment'), kinds);
    check(
      'keywords are recognised and the tail is one comment token',
      tokens.some((t) => t.kind === 'keyword' && t.text === 'const') &&
        tokens.some((t) => t.kind === 'comment' && t.text === '// tail') &&
        tokens.some((t) => t.kind === 'string' && t.text.includes('// b')),
      JSON.stringify(tokens),
    );
  }
  {
    const state = { blockComment: false };
    const first = I.highlightLine('/* open', 'ts', state);
    const second = I.highlightLine('still */ const y = 1', 'ts', state);
    check('a block comment spans lines', state.blockComment === false && second.some((t) => t.kind === 'keyword' && t.text === 'const'), JSON.stringify(second));
    check('the open line is entirely a comment', first.length === 1 && first[0].kind === 'comment', JSON.stringify(first));
  }
  check(
    'an unknown language is left plain',
    I.highlightLine('const x = 1', null, { blockComment: false }).length === 1,
  );
  check(
    'a python comment does not need a second slash',
    I.highlightLine('x = 1  # note', 'python', { blockComment: false }).some((t) => t.kind === 'comment'),
  );
  check('renders the three-way verdict labels', view.text.includes('已索引') && view.text.includes('索引缺失') && view.text.includes('有意排除'));
  check('renders a missing-file tag', view.text.includes('缺失'));
  check('renders the author list', view.text.includes('Ada') && view.text.includes('dependabot[bot]'));
  check('marks a bot author', view.text.includes('bot'));
  check(
    'the activity card leaves the branch list to the header',
    !view.text.includes('分支 ·'),
    view.text.slice(0, 200),
  );
  const sticky = view.styles.find((style) => style?.position === 'sticky');
  check('the project header is pinned', sticky !== undefined && sticky.top === 0, JSON.stringify(sticky));
  check(
    'the pinned header is opaque, so cards cannot show through it',
    typeof sticky?.background === 'string' && sticky.background !== 'transparent' && !sticky.background.includes(', transparent)'),
    String(sticky?.background),
  );
  const branchView = render(I.CoverageView, {
    report,
    ...viewProps,
    branches: [
      { name: 'main', current: true },
      { name: 'feature/x' },
    ],
    currentBranch: 'main',
    onSwitchBranch: () => {},
  });
  check(
    'the header offers the branch switch with the current branch',
    branchView.text.includes('main') && branchView.text.includes('▾'),
    branchView.text.slice(0, 240),
  );
  // The list is a popover, not a datalist: a datalist gets filtered by the text in
  // its field, which made one pick look like the other branches had disappeared.
  check(
    'the branch list is not a datalist',
    !branchView.tags.includes('datalist'),
    branchView.tags.join(','),
  );
  check('renders the provenance block', view.text.includes('解析质量与溯源'));
  check('provenance surfaces the untyped receiver total', view.text.includes('435'), view.text.slice(-400));

  section('render: edge states');

  const empty = render(I.CoverageView, { report: { ...report, largeFiles: [], warnings: [], totals: { ...report.totals, large: 0, largeBytes: 0 } }, ...viewProps });
  check('a clean report renders without a skipped-file section', !empty.text.includes('被跳过的超大文件'));
  check('a clean report still renders languages', empty.text.includes('语言分布'));

  const noIndexReport = {
    repo: { indexed: false, path: 'D:\\demo' },
    totals: { scanned: 10, selected: 9, indexedInGraph: 0, large: 0, largeBytes: 0, suppressedDeclarations: 0, scannedBytes: 2048 },
    cap: { text: '512.0 KB', source: 'default' },
    languages: {
      rows: [{ key: 'typescript', label: 'TypeScript', color: '#3178c6', klass: 'recognized', files: 9, bytes: 2048 }],
      totalFiles: 9,
      totalBytes: 2048,
      detector: 'builtin',
    },
    toolchain: { verdict: 'ready' },
  };

  const noIndex = render(I.CoverageView, {
    report: noIndexReport,
    ...viewProps,
  });
  check('an unindexed project leads with the initialize command', noIndex.text.includes('还没有 GitNexus 索引') && noIndex.text.includes('初始化索引'));
  check('an unindexed project still shows a scan overview', noIndex.text.includes('扫描概览') && noIndex.text.includes('扫描文件'));
  check(
    'an unindexed project shows the fallback language split',
    noIndex.text.includes('语言分布') && noIndex.text.includes('TypeScript') && noIndex.text.includes('内置扩展名映射'),
    noIndex.text.slice(0, 400),
  );
  check('still marks an applicable command when unindexed', noIndex.text.includes('当前适用'));

  // A plain folder: no index and no `.git`. It is still the operator's working tree,
  // and the panel must say what can and cannot be done there instead of showing a raw
  // 404 with no numbers.
  const noGitNoIndex = render(I.CoverageView, {
    report: {
      ...noIndexReport,
      repo: { indexed: false, hasGit: false, path: 'D:\\demo' },
    },
    ...viewProps,
    maintenance: { ...maintenance, skipGit: true },
  });
  check(
    'a non-git directory with no index says so up front',
    noGitNoIndex.text.includes('不是 git 仓库') && noGitNoIndex.text.includes('没有提交基线'),
    noGitNoIndex.text.slice(0, 400),
  );
  check(
    'a non-git directory still shows the scan and the initialize action',
    noGitNoIndex.text.includes('扫描概览') && noGitNoIndex.text.includes('初始化索引'),
  );

  // An index built with `--skip-git`: there is no incremental mode, so the normal
  // action must not be labelled "增量刷新".
  const gitless = render(I.CoverageView, {
    report: { ...report, repo: { ...report.repo, hasGit: false } },
    ...viewProps,
    maintenance: { ...maintenance, skipGit: true },
  });
  check(
    'an indexed non-git directory offers re-analysis, not an incremental refresh',
    gitless.text.includes('执行重新分析') && !gitless.text.includes('执行增量刷新'),
    gitless.text.slice(0, 600),
  );

  // A workspace with more than one index: the path position becomes a switcher, and
  // the note keeps the full active path that the compact option labels omit.
  const project = (pathValue, name, relPath, indexedAt) => ({
    path: pathValue,
    name,
    relPath,
    kind: 'index',
    hasGit: true,
    direction: 'descendant',
    depth: 1,
    indexedAt,
    lastCommit: null,
    branch: null,
    stats: null,
    complete: true,
    metaFile: 'gitnexus.json',
  });
  const frontend = project('D:\\demo\\frontend', 'frontend', 'frontend', '2026-10-20T08:00:00Z');
  const backend = project('D:\\demo\\backend', 'backend', 'backend', '2026-10-19T08:00:00Z');
  const nested = render(I.CoverageView, {
    report: { ...report, repo: { ...report.repo, path: 'D:\\demo\\frontend' } },
    ...viewProps,
    projectPath: 'D:\\demo\\frontend',
    workspacePath: 'D:\\demo',
    projects: [frontend, backend],
    onSelectProject: () => {},
  });
  check('a multi-index workspace shows a project switcher', nested.tags.includes('select'), nested.tags.join(','));
  check(
    'the switcher lists every project',
    nested.text.includes('frontend') && nested.text.includes('backend'),
    nested.text.slice(0, 300),
  );
  check(
    'the header keeps the active project path and the workspace scope',
    nested.text.includes('D:\\demo\\frontend') &&
      nested.text.includes('工作区：D:\\demo · 2 个项目（2 个已索引）'),
    nested.text.slice(0, 400),
  );

  // A container whose children are git repositories but have no indexes: list them so
  // the operator can see the subprojects and initialize one, instead of a bare "none".
  const workspaceContainer = {
    ...frontend,
    path: 'D:\\demo',
    name: 'demo',
    relPath: '',
    kind: 'workspace',
    hasGit: false,
    direction: 'self',
    depth: 0,
    indexedAt: null,
    stats: null,
    complete: false,
    metaFile: null,
  };
  const adminGit = {
    ...frontend,
    path: 'D:\\demo\\admin',
    name: 'admin',
    relPath: 'admin',
    kind: 'git',
    complete: false,
    indexedAt: null,
    stats: null,
    metaFile: null,
  };
  const gitProjects = render(I.CoverageView, {
    report: { ...noIndexReport, repo: { indexed: false, hasGit: false, path: 'D:\\demo' } },
    ...viewProps,
    workspacePath: 'D:\\demo',
    projectPath: 'D:\\demo',
    projects: [workspaceContainer, adminGit],
    projectsVisited: 42,
    onSelectProject: () => {},
  });
  check(
    'a container with unindexed git projects shows a switcher',
    gitProjects.tags.includes('select'),
    gitProjects.tags.join(','),
  );
  check(
    'unindexed projects are labelled in the switcher',
    gitProjects.text.includes('admin（未索引）'),
    gitProjects.text.slice(0, 300),
  );
  check(
    'the scan state names the unindexed git projects',
    gitProjects.text.includes('1 个 git 项目尚未建索引'),
    gitProjects.text.slice(0, 500),
  );

  // No index below the workspace: the scan-only state says how far the search went,
  // instead of leaving "no index" indistinguishable from "did not look".
  const searched = render(I.CoverageView, {
    report: noIndexReport,
    ...viewProps,
    workspacePath: 'D:\\demo',
    projects: [],
    projectsVisited: 42,
    projectsTruncated: false,
  });
  check(
    'a failed search reports how many directories were checked',
    searched.text.includes('42 个目录') && searched.text.includes('没有找到'),
    searched.text.slice(0, 500),
  );
  const searchedTruncated = render(I.CoverageView, {
    report: noIndexReport,
    ...viewProps,
    workspacePath: 'D:\\demo',
    projects: [],
    projectsVisited: 4000,
    projectsTruncated: true,
  });
  check(
    'a truncated search says it may have missed a directory',
    searchedTruncated.text.includes('搜索达到上限'),
    searchedTruncated.text.slice(0, 500),
  );

  // The pure selection rule: remembered choice, then the workspace itself, then the
  // host's ranking. This is what keeps a refresh from jumping between projects.
  check(
    'a remembered project wins while it still exists',
    I.chooseProject([frontend, backend], 'D:\\demo', 'D:\\demo\\backend') === 'D:\\demo\\backend',
  );
  check(
    'a stale remembered project falls back to the ranking',
    I.chooseProject([frontend, backend], 'D:\\demo', 'D:\\demo\\gone') === 'D:\\demo\\frontend',
  );
  const workspaceProject = {
    ...frontend,
    path: 'D:\\demo',
    name: 'demo',
    relPath: '',
    depth: 0,
    direction: 'self',
  };
  check(
    'the workspace index wins by default',
    I.chooseProject([frontend, workspaceProject], 'D:\\demo', null) === 'D:\\demo',
  );
  check(
    'an indexed child wins over a container workspace',
    I.chooseProject([workspaceContainer, frontend], 'D:\\demo', null) === 'D:\\demo\\frontend',
  );
  check(
    'an unindexed container stays on the workspace overview',
    I.chooseProject([workspaceContainer, adminGit], 'D:\\demo', null) === 'D:\\demo',
  );
  check(
    'a workspace with no indexes opens on itself',
    I.chooseProject([], 'D:\\demo', null) === 'D:\\demo',
  );

  const errored = render(I.CoverageView, { report: null, ...viewProps, error: '工作区未解析' });
  check('error state surfaces the message', errored.text.includes('工作区未解析'));

  // A failed read used to render the "维护命令" heading with an empty body, because the
  // panel synthesised a maintenance payload with no commands. The heading is a promise
  // that there is something to copy; with no commands it must disappear.
  const erroredEmptyMaintenance = render(I.CoverageView, {
    report: null,
    ...viewProps,
    error: '工作区未解析',
    maintenance: { commands: [], rationale: [] },
  });
  check(
    'an empty maintenance payload does not render an empty card',
    !erroredEmptyMaintenance.text.includes('维护命令'),
    erroredEmptyMaintenance.text,
  );

  const partial = render(I.CoverageView, { report: { ...report, languages: null }, ...viewProps });
  check('missing language data degrades without crashing', partial.text.includes('被跳过的超大文件'));

  const searchEmpty = render(I.CoverageView, {
    report,
    ...viewProps,
    search: { ...search, results: [], total: 0 },
  });
  check('an empty search result says so', searchEmpty.text.includes('没有匹配'), searchEmpty.text.slice(0, 400));

  // The card must say which surfaces produced the list. "按符号名与文件路径匹配" was true
  // of every search before the FTS pass existed; saying it while FTS ran would understate
  // what was searched, and saying it while FTS failed would overstate it.
  const contentFooter = render(I.CoverageView, { report, ...viewProps, search: { ...search, contentSearch: true } });
  check(
    'a content-search run names FTS as part of the scope',
    contentFooter.text.includes('文件正文（FTS）'),
    contentFooter.text.slice(0, 500),
  );
  const namesOnlyFooter = render(I.CoverageView, {
    report,
    ...viewProps,
    search: { ...search, contentSearch: false, warning: null },
  });
  check(
    'a names-only run says the body text was not searched',
    namesOnlyFooter.text.includes('不搜索正文'),
    namesOnlyFooter.text.slice(0, 500),
  );
  check(
    'a names-only run does not claim FTS matched',
    !namesOnlyFooter.text.includes('文件正文（FTS）'),
    namesOnlyFooter.text.slice(0, 500),
  );

  const searchFailed = render(I.CoverageView, {
    report,
    ...viewProps,
    search: { ...search, results: null, error: '图查询失败' },
  });
  check('a search error is surfaced', searchFailed.text.includes('图查询失败'), searchFailed.text.slice(0, 400));

  const textFallback = render(I.CoverageView, {
    report,
    ...viewProps,
    search: {
      ...search,
      mode: 'text',
      results: [
        { kind: 'Text', name: 'const x = analyzeCoverage(y);', filePath: 'src/gitnexus/coverage.ts', startLine: 507, endLine: 507 },
      ],
      warning: '图查询不可用；已回退到索引文件的源码关键词搜索。结果来自文本，不是图谱。',
    },
  });
  check(
    'a text fallback labels itself and names its scope',
    textFallback.text.includes('源码关键词（回退）') &&
      textFallback.text.includes('处源码匹配') &&
      textFallback.text.includes('结果来自文本'),
    textFallback.text.slice(0, 500),
  );

  const oldHost = render(I.CoverageView, {
    report,
    ...viewProps,
    maintenance: { ...maintenance, supportsForce: false },
  });
  check(
    'an older host does not offer an enabled full rebuild',
    oldHost.text.includes('全量重建（需重启）'),
    oldHost.text.slice(-500),
  );
  check(
    'an older host asks for a restart before maintenance',
    oldHost.text.includes('执行增量刷新（需重启）') && oldHost.text.includes('当前宿主是旧版本'),
    oldHost.text.slice(-500),
  );

  // ---------------------------------------------------------------------------

  return { report, project, view, empty };
}
