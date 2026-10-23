/**
 * Graph and workspace card tests.
 *
 * Both render `GraphSection` and `WorkspaceOverview` against fixture states built here,
 * so the shared fixtures they need (`report`, `viewProps`, `project`) are passed in by
 * the caller instead of being reached through module scope.
 */

import path from 'node:path';

/** @param {{I: any, report: any, viewProps: any, project: any, maintenance: any, search: any, check: any, section: any, render: any, withHookFrame: any}} ctx */
export function graphSuite(ctx) {
  const { I, report, viewProps, project, maintenance, search, check, section, render, withHookFrame } = ctx;

  section('maintenance: the refresh is gated by the delta verdict');

  /** @param {Record<string, unknown>} patch */
  const withDelta = (patch) => ({
    indexed: true,
    comparable: true,
    basis: 'index',
    indexedCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    entries: [],
    counts: { checked: 0, hashed: 0, unchanged: 0, modified: 0, added: 0, deleted: 0, excluded: 0 },
    needsRefresh: false,
    truncated: false,
    notes: ['工作区与索引记录一致：没有任何文件相对索引提交发生改动'],
    durationMs: 12,
    readAt: new Date().toISOString(),
    ...patch,
  });

  const cleanGate = render(I.CoverageView, { report, ...viewProps, delta: withDelta({}) });
  check(
    'a clean tree disables the normal refresh and says why',
    cleanGate.text.includes('无需刷新') && cleanGate.text.includes('索引已是最新'),
    cleanGate.text.slice(-600),
  );
  check(
    'a clean tree keeps an escape hatch instead of removing the decision',
    cleanGate.text.includes('仍然刷新'),
    cleanGate.text.slice(-600),
  );

  const dirtyGate = render(I.CoverageView, {
    report,
    ...viewProps,
    delta: withDelta({
      needsRefresh: true,
      counts: { checked: 3, hashed: 2, unchanged: 1, modified: 1, added: 1, deleted: 1, excluded: 0 },
      entries: [
        { path: 'src/a.ts', kind: 'modified', reason: null },
        { path: 'src/c.ts', kind: 'added', reason: null },
        { path: 'src/b.ts', kind: 'deleted', reason: null },
      ],
      notes: ['索引内容已落后：1 个修改、1 个新增、1 个删除'],
    }),
  });
  check(
    'a dirty tree explains what changed before asking',
    dirtyGate.text.includes('索引内容已落后') && dirtyGate.text.includes('1 改 / 1 增 / 1 删'),
    dirtyGate.text.slice(-800),
  );
  check(
    'the changed paths are listed with their kind',
    dirtyGate.text.includes('M src/a.ts') &&
      dirtyGate.text.includes('A src/c.ts') &&
      dirtyGate.text.includes('D src/b.ts'),
    dirtyGate.text.slice(-800),
  );

  const excludedGate = render(I.CoverageView, {
    report,
    ...viewProps,
    delta: withDelta({
      needsRefresh: false,
      counts: { checked: 1, hashed: 0, unchanged: 0, modified: 0, added: 0, deleted: 0, excluded: 1 },
      entries: [{ path: 'assets/big.bin', kind: 'excluded', reason: '超过索引记录的大小上限（512 KB）' }],
      notes: ['工作区与索引记录一致：1 个候选文件中 0 个内容哈希匹配，1 个属索引策略排除'],
    }),
  });
  check(
    'an excluded-only change says it is not a reason to refresh',
    excludedGate.text.includes('刷新也不会收录'),
    excludedGate.text.slice(-600),
  );

  // A legacy index (or a host without the route) has no verdict. The control must keep
  // working rather than block a refresh it cannot justify.
  const unknownGate = render(I.CoverageView, {
    report,
    ...viewProps,
    delta: withDelta({
      comparable: false,
      notes: ['该索引没有记录文件哈希（旧格式 manifest），无法判断内容是否变化 —— 直接刷新'],
    }),
  });
  check(
    'an incomparable index explains itself and still allows a refresh',
    unknownGate.text.includes('没有记录文件哈希') && unknownGate.text.includes('执行增量刷新'),
    unknownGate.text.slice(-600),
  );

  const missingRoute = render(I.CoverageView, { report, ...viewProps, delta: null, deltaError: null });
  check(
    'a host without the delta route behaves as before',
    missingRoute.text.includes('执行增量刷新') && !missingRoute.text.includes('无需刷新'),
    missingRoute.text.slice(-600),
  );

  // The verdict measured on this repository: the index recorded no commit, so the
  // comparison could only see the working tree. It must not be presented as "current".
  const uncertainGate = render(I.CoverageView, {
    report,
    ...viewProps,
    delta: withDelta({
      certain: false,
      notes: [
        '索引没有记录可用的提交基线：只比较了工作区相对 HEAD 的改动，索引建立之后已提交的改动看不到',
        '工作区相对 HEAD 没有改动，但无法确认索引已包含当前提交 —— 需要刷新才能确定',
      ],
    }),
  });
  check(
    'an unanchored verdict does not claim the index is current',
    !uncertainGate.text.includes('索引已是最新') && !uncertainGate.text.includes('无需刷新'),
    uncertainGate.text.slice(-700),
  );
  check(
    'an unanchored verdict explains the missing baseline',
    uncertainGate.text.includes('提交基线') && uncertainGate.text.includes('无法确认索引'),
    uncertainGate.text.slice(-700),
  );
  check(
    'an unanchored verdict leaves the refresh enabled',
    uncertainGate.text.includes('执行增量刷新'),
    uncertainGate.text.slice(-700),
  );

  section('maintenance: FTS repair');

  const repairCommand = {
    mode: 'repair-fts',
    label: '修复搜索索引（FTS）',
    when: '面板显示 FTS 不可用、关键词搜索只能按名称匹配时使用。',
    argv: "gitnexus analyze --index-only --repair-fts 'D:\\demo'",
    shell: "$env:GITNEXUS_MEMORY='off'; gitnexus analyze --index-only --repair-fts 'D:\\demo'",
    destructive: false,
    caveat: null,
  };
  const withRepair = render(I.CoverageView, {
    report,
    ...viewProps,
    maintenance: {
      ...maintenance,
      supportsRepair: true,
      commands: [...maintenance.commands, repairCommand],
    },
    delta: withDelta({}),
  });
  check(
    'the repair control is offered when the host supports it',
    withRepair.text.includes('修复搜索索引') && withRepair.text.includes('--repair-fts'),
    withRepair.text.slice(-900),
  );

  const repairFromOldHost = render(I.CoverageView, {
    report,
    ...viewProps,
    maintenance: {
      ...maintenance,
      commands: [...maintenance.commands, repairCommand],
    },
    delta: withDelta({}),
  });
  check(
    'a host without repair support does not get a repair button',
    !repairFromOldHost.text.includes('修复搜索索引'),
    repairFromOldHost.text.slice(-900),
  );

  const repairRun = render(I.CoverageView, {
    report,
    ...viewProps,
    run: {
      state: 'done',
      force: false,
      repairFts: true,
      command: 'gitnexus analyze --index-only --repair-fts',
      startedAt: Date.now() - 3000,
      finishedAt: Date.now(),
      exitCode: 0,
      message: null,
      output: '',
    },
    delta: withDelta({}),
  });
  check('a repair run is labelled as such', repairRun.text.includes('修复 FTS'), repairRun.text.slice(-900));

  // A raw stack is evidence, not a headline: the verdict is the summary and the text is
  // one click away. The text must still be in the DOM for the disclosure to reveal it.
  const withOutput = render(I.CoverageView, {
    report,
    ...viewProps,
    run: {
      state: 'failed',
      force: false,
      repairFts: false,
      command: 'gitnexus analyze --index-only',
      startedAt: Date.now() - 3000,
      finishedAt: Date.now(),
      exitCode: 1,
      message: '沙箱拒绝了这次写入。',
      output: 'Error: EPERM 第一行\n    at second-line',
    },
    delta: withDelta({}),
  });
  check(
    'the raw output is behind a disclosure, not in front of the verdict',
    withOutput.text.includes('查看原始输出') && withOutput.text.includes('EPERM 第一行'),
    withOutput.text.slice(-600),
  );

  // An old host without the delta route used to leave the gate silently absent.
  const noDeltaRoute = render(I.CoverageView, {
    report,
    ...viewProps,
    delta: null,
    deltaError: null,
    deltaRoute: 'missing',
  });
  check(
    'a host without the delta route says so',
    noDeltaRoute.text.includes('未挂载差量路由') && noDeltaRoute.text.includes('刷新按钮仍可使用'),
    noDeltaRoute.text.slice(-600),
  );

  // ---------------------------------------------------------------------------
  // Graph card
  // ---------------------------------------------------------------------------

  section('graph: bounded projection card');

  const graphEdge = { source: 'comm_43', target: 'comm_8', type: 'CALLS', weight: 2 };
  const graphState = (patch) => ({
    projection: {
      view: 'communities',
      scope: null,
      total: 39,
      nodes: [
        { id: 'comm_43', kind: 'Community', name: 'Test', filePath: null, startLine: null, symbolCount: 26 },
        { id: 'comm_8', kind: 'Community', name: 'Routes', filePath: null, startLine: null, symbolCount: 18 },
      ],
      edges: [graphEdge],
      truncated: true,
      budget: { nodes: 220, edges: 800 },
      notes: ['共 39 个社区，显示符号数最多的 2 个'],
      readAt: new Date().toISOString(),
    },
    loading: false,
    error: null,
    routeState: 'ready',
    scope: null,
    onOpenCommunity: () => {},
    onOpenSymbols: () => {},
    onBack: () => {},
    onReload: () => {},
    onOpenSymbol: () => {},
    ...patch,
  });

  const overview = render(I.CoverageView, { report, ...viewProps, graph: graphState({}) });
  check(
    'the graph card names the overview and its coverage',
    overview.text.includes('社区总览') && overview.text.includes('2 / 39 个社区'),
    overview.text.slice(-700),
  );
  check(
    'a truncated view says how much it left out',
    overview.text.includes('已截断') && overview.text.includes('共 39 个社区'),
    overview.text.slice(-700),
  );
  check(
    'the reachable list mirrors the drawn nodes',
    overview.text.includes('Test · 26') && overview.text.includes('Routes · 18'),
    overview.text.slice(-700),
  );
  check(
    'the card explains the interaction and the budget',
    overview.text.includes('滚轮缩放') && overview.text.includes('220'),
    overview.text.slice(-700),
  );
  check(
    'the community overview uses the canvas renderer (no 3D controls) and keeps the legend',
    overview.text.includes('个社区') &&
      overview.text.includes('点一个社区看它的成员符号') &&
      !overview.text.includes('拖拽旋转'),
    overview.text.slice(-700),
  );

  const symbolsGraph = render(I.CoverageView, {
    report,
    ...viewProps,
    graph: graphState({
      projection: {
        view: 'symbols',
        scope: null,
        nodes: [
          { id: 'Function:src/a.ts:load@1:2', kind: 'Function', name: 'load', filePath: 'src/a.ts', startLine: 1 },
        ],
        edges: [],
        total: 2945,
        truncated: true,
        budget: { nodes: 220, edges: 800 },
        notes: ['共 2945 个符号，按文件顺序显示前 1 个；可用社区视图看全貌'],
        readAt: new Date().toISOString(),
      },
    }),
  });
  check(
    'the symbol view names itself and offers the community view',
    symbolsGraph.text.includes('符号全图') &&
      symbolsGraph.text.includes('社区视图') &&
      symbolsGraph.text.includes('2945') &&
      symbolsGraph.text.includes('load'),
    symbolsGraph.text.slice(-800),
  );
  check(
    'the symbol view explains its truncation',
    symbolsGraph.text.includes('按文件顺序') && symbolsGraph.text.includes('截断'),
    symbolsGraph.text.slice(-800),
  );

  const deferredGraph = render(I.CoverageView, {
    report,
    ...viewProps,
    graph: graphState({ projection: null }),
    graphVisible: false,
  });
  check(
    'a graph card that has not been reached says it is deferred',
    deferredGraph.text.includes('滚动到此处加载'),
    deferredGraph.text.slice(-500),
  );
  const visibleEmptyGraph = render(I.CoverageView, {
    report,
    ...viewProps,
    graph: graphState({ projection: null }),
    graphVisible: true,
  });
  check(
    'a reached graph card with no projection says so',
    visibleEmptyGraph.text.includes('暂无图数据') && !visibleEmptyGraph.text.includes('滚动到此处加载'),
    visibleEmptyGraph.text.slice(-500),
  );

  // Community colours come from a greedy colouring of the community graph, so adjacent
  // dots stop looking identical.
  {
    const coloured = I.communityColors(
      [
        { id: 'a', kind: 'Community' },
        { id: 'b', kind: 'Community' },
        { id: 'c', kind: 'Community' },
      ],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'a' },
      ],
    );
    check(
      'adjacent communities receive different colours',
      coloured.get('a') !== coloured.get('b') &&
        coloured.get('b') !== coloured.get('c') &&
        coloured.get('c') !== coloured.get('a'),
      JSON.stringify([...coloured]),
    );
    check(
      'the colouring covers every node',
      coloured.size === 3 && [...coloured.values()].every((c) => /^#[0-9a-f]{6}$/.test(c)),
      JSON.stringify([...coloured]),
    );
  }

  // The 3D view is not drawn by this panel any more — it embeds GitNexus's own web UI —
  // so what is left to test is the mapping from server state to a decision, and the
  // sentence the card says before anything can render.
  {
    const view = (patch) => ({
      state: 'ready',
      repoPath: 'D:/repo',
      url: 'http://127.0.0.1:4747/?repo=D%3A%2Frepo',
      port: 4747,
      owner: 'managed',
      repoResolvable: true,
      registryHome: 'D:/repo/.gitnexus/plugin-home',
      command: 'gitnexus serve --port 4747',
      startedAt: 1,
      message: null,
      output: '',
      ai: {
        injected: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.example.com/v1',
        reason: null,
      },
      ...patch,
    });

    check('web view summary: nothing known yet', I.webViewSummary(null, 'unknown').text === '未知');
    check(
      'web view summary: a host without the route is a warning',
      I.webViewSummary(null, 'missing').dot === 'warning' && I.webViewSummary(null, 'missing').text === '宿主未挂载',
    );
    check(
      'web view summary: a managed server that can see this repository is 已就绪',
      I.webViewSummary(view({}), 'present').text === '已就绪',
    );
    check(
      'web view summary: an adopted server says so',
      I.webViewSummary(view({ owner: 'adopted' }), 'present').text === '外部服务已就绪',
    );
    check(
      'web view summary: a running server with the wrong registry is a warning, not a ready',
      I.webViewSummary(view({ repoResolvable: false }), 'present').dot === 'warning',
    );
    check(
      'web view summary: a failure reads as a failure',
      I.webViewSummary(view({ state: 'failed' }), 'present').dot === 'error',
    );

    const stopped = render(I.WebViewCard, {
      // The real "stopped" status has no owner and no port, so it must not offer to stop
      // a server it does not have.
      view: view({
        state: 'stopped',
        url: null,
        owner: null,
        port: null,
        startedAt: null,
        repoResolvable: false,
        ai: {
          injected: false,
          provider: null,
          model: null,
          baseUrl: null,
          reason: '没有设置 GITNEXUS_PLUS_AI_* 环境变量，AI 设置保持原样。',
        },
      }),
      route: 'present',
      busy: null,
      error: null,
      onAct: async () => null,
    });
    check(
      'the card offers to start the server before anything is running',
      stopped.text.includes('启动并打开 3D 视图') && !stopped.text.includes('停止服务'),
      stopped.text.slice(0, 400),
    );
    check(
      'a stopped card still says what will happen to the AI settings',
      stopped.text.includes('GITNEXUS_PLUS_AI_') && !stopped.text.includes('已注入'),
      stopped.text.slice(0, 500),
    );

    const ready = render(I.WebViewCard, {
      view: view({}),
      route: 'present',
      busy: null,
      error: null,
      onAct: async () => null,
    });
    check(
      'a ready card shows the URL, both openings and the stop control',
      ready.text.includes('http://127.0.0.1:4747/?repo=') &&
        ready.text.includes('打开 3D 视图') &&
        ready.text.includes('在新标签页打开') &&
        ready.text.includes('停止服务'),
      ready.text.slice(0, 500),
    );
    check(
      'a ready card reports the seeded provider and model, and the endpoint',
      ready.text.includes('已注入：openai · gpt-4o-mini') && ready.text.includes('https://api.example.com/v1'),
      ready.text.slice(0, 500),
    );
    check(
      'the AI line never carries the key, and degrades on an old host',
      I.webViewAiLine(view({})) === '已注入：openai · gpt-4o-mini · https://api.example.com/v1' &&
        I.webViewAiLine(view({ ai: undefined })) === '未注入 AI 设置。' &&
        I.webViewAiLine(
          view({ ai: { injected: false, provider: null, model: null, baseUrl: null, reason: '外部启动的服务' } }),
        ) === '外部启动的服务',
      I.webViewAiLine(view({})),
    );

    const adopted = render(I.WebViewCard, {
      view: view({ owner: 'adopted' }),
      route: 'present',
      busy: null,
      error: null,
      onAct: async () => null,
    });
    check(
      'an adopted server is never offered for stopping, and the card says why',
      adopted.text.includes('外部启动的服务') && !adopted.text.includes('停止服务'),
      adopted.text.slice(0, 500),
    );

    const failed = render(I.WebViewCard, {
      view: view({ state: 'failed', url: null, message: '等待 GitNexus Web 服务响应超时（25 秒）', output: 'Error: boom' }),
      route: 'present',
      busy: null,
      error: null,
      onAct: async () => null,
    });
    check(
      'a failed card repeats the host message and keeps the output reachable',
      failed.text.includes('等待 GitNexus Web 服务响应超时') && failed.text.includes('服务输出'),
      failed.text.slice(0, 500),
    );

    const missing = render(I.WebViewCard, {
      view: null,
      route: 'missing',
      busy: null,
      error: null,
      onAct: async () => null,
    });
    check(
      'a host that predates this route is named as such',
      missing.text.includes('没有挂载 3D 视图的服务端'),
      missing.text.slice(0, 300),
    );

    // The dialog is its own component so the size policy can be exercised without opening
    // the card: the helpers are pure, and the render only needs the URL it would show.
    const laptop = { width: 1280, height: 800 };
    check(
      'overlay size: clamped up to the minimum and down to the viewport',
      JSON.stringify(I.clampOverlaySize({ width: 100, height: 100 }, laptop)) ===
        JSON.stringify({ width: 560, height: 400 }) &&
        JSON.stringify(I.clampOverlaySize({ width: 5000, height: 5000 }, laptop)) ===
          JSON.stringify({ width: 1232, height: 752 }),
      JSON.stringify(I.clampOverlaySize({ width: 5000, height: 5000 }, laptop)),
    );
    check(
      'overlay size: presets are fractions of the usable viewport, 铺满 fills it',
      JSON.stringify(I.overlayPresetSize('full', laptop)) === JSON.stringify({ width: 1232, height: 752 }) &&
        JSON.stringify(I.overlayPresetSize('compact', laptop)) === JSON.stringify({ width: 739, height: 496 }),
      JSON.stringify(I.overlayPresetSize('compact', laptop)),
    );
    check(
      'overlay size: a remembered size is used only when it parses and is positive',
      JSON.stringify(I.parseOverlaySize('{"width":900,"height":700}')) ===
        JSON.stringify({ width: 900, height: 700 }) &&
        I.parseOverlaySize('not json') === null &&
        I.parseOverlaySize('{"width":-1,"height":700}') === null &&
        I.parseOverlaySize('{"width":900}') === null &&
        I.parseOverlaySize(null) === null,
      JSON.stringify(I.parseOverlaySize('{"width":-1,"height":700}')),
    );
    check(
      'overlay size: the header label is the pixel size',
      I.overlaySizeLabel({ width: 1060, height: 662 }) === '1060 × 662',
      I.overlaySizeLabel({ width: 1060, height: 662 }),
    );

    const overlay = render(I.WebViewOverlay, { src: 'http://127.0.0.1:4747/?repo=D%3A%2Frepo', onClose: () => {} });
    check(
      'the overlay offers all three sizes and shows the current one',
      overlay.text.includes('紧凑') &&
        overlay.text.includes('标准') &&
        overlay.text.includes('铺满') &&
        overlay.text.includes('1060 × 662') &&
        overlay.text.includes('关闭'),
      overlay.text.slice(0, 400),
    );
    check(
      'the overlay embeds the SPA in a frame',
      overlay.tags.includes('iframe'),
      overlay.tags.join(','),
    );

    // The grip carries no text, so it is found by role: a drag handle that assistive tech
    // can name, and one the browser shows as a diagonal resize cursor.
    const withRole = (node, role, out = []) => {
      if (node === null || node === undefined || typeof node === 'boolean') return out;
      if (Array.isArray(node)) {
        for (const child of node) withRole(child, role, out);
        return out;
      }
      if (typeof node !== 'object' || node.type === undefined) return out;
      if (node.props?.role === role) out.push(node);
      withRole(node.props?.children, role, out);
      return out;
    };
    const grips = withRole(withHookFrame(() => I.WebViewOverlay({ src: 'http://127.0.0.1:4747/', onClose: () => {} })), 'separator');
    check(
      'the overlay has one labelled resize grip',
      grips.length === 1 &&
        grips[0].props['aria-label'] === '拖动调整窗口大小' &&
        grips[0].props.style.cursor === 'nwse-resize',
      JSON.stringify(grips.map((grip) => grip.props.style?.cursor)),
    );

    // The stateful wrapper is only asserted on its first paint: it fetches on mount, and
    // this renderer deliberately does not run effects.
    const section = render(I.WebViewSection, { projectPath: 'D:/repo' });
    check(
      'the section starts from the unknown state and describes itself',
      section.text.includes('3D 视图') &&
        section.text.includes('未知') &&
        section.text.includes('GitNexus 自带的 Web 端'),
      section.text.slice(0, 300),
    );
  }

  const drilled = render(I.CoverageView, {
    report,
    ...viewProps,
    graph: graphState({
      scope: 'comm_43',
      projection: {
        view: 'community',
        scope: 'comm_43',
        total: 26,
        nodes: [
          {
            id: 'Function:test/run.mjs:check',
            kind: 'Function',
            name: 'check',
            filePath: 'test/run.mjs',
            startLine: 30,
          },
        ],
        edges: [],
        truncated: false,
        budget: { nodes: 220, edges: 800 },
        notes: [],
        readAt: new Date().toISOString(),
      },
    }),
  });
  check(
    'a drill-down names its scope and offers a way back',
    drilled.text.includes('社区 comm_43') && drilled.text.includes('← 全部社区'),
    drilled.text.slice(-700),
  );
  check(
    'a symbol member is listed with its name',
    drilled.text.includes('check'),
    drilled.text.slice(-700),
  );
  check(
    'the drill-down explains that a symbol opens its file',
    drilled.text.includes('打开它并定位到行'),
    drilled.text.slice(-700),
  );

  const graphFailed = render(I.CoverageView, { report, ...viewProps, graph: graphState({ projection: null, error: '图查询失败：索引被占用' }) });
  check('a graph error is surfaced', graphFailed.text.includes('图查询失败'), graphFailed.text.slice(-500));

  const graphLoading = render(I.CoverageView, { report, ...viewProps, graph: graphState({ projection: null, loading: true }) });
  check('an empty graph says it is still reading', graphLoading.text.includes('读取中'), graphLoading.text.slice(-500));

  // The state that was actually observed: a client that reloaded ahead of the host. A 404
  // used to leave `projection: null` with no error, so the card sat on 读取中… forever and
  // read as a hang. It must name the cause instead.
  const graphRouteMissing = render(I.CoverageView, {
    report,
    ...viewProps,
    graph: graphState({ projection: null, routeState: 'missing' }),
  });
  check(
    'a host without the graph route says to restart DSH',
    graphRouteMissing.text.includes('重启 DSH') && graphRouteMissing.text.includes('宿主未挂载图路由'),
    graphRouteMissing.text.slice(-600),
  );
  check(
    'a missing route does not pretend to still be loading',
    !graphRouteMissing.text.includes('正在读取图'),
    graphRouteMissing.text.slice(-600),
  );

  // A host without the route leaves the state undefined; the card must simply not appear
  // rather than showing an empty frame in every profile that has not restarted yet.
  const noGraph = render(I.CoverageView, { report, ...viewProps });
  check('a host without the graph route renders no graph card', !noGraph.text.includes('社区总览'));

  // ---------------------------------------------------------------------------
  // Workspace aggregate
  // ---------------------------------------------------------------------------

  section('workspace: aggregate projects');

  const wsProject = (patch) => ({
    path: '/workspace/a',
    name: 'a',
    relPath: 'a',
    kind: 'index',
    hasGit: true,
    direction: 'descendant',
    depth: 1,
    indexedAt: '2026-10-21T00:00:00Z',
    lastCommit: 'abc1234',
    branch: 'main',
    stats: { files: 10, nodes: 20, edges: 30, communities: 4, processes: 5, embeddings: 0 },
    complete: true,
    metaFile: '/workspace/a/.gitnexus/gitnexus.json',
    ...patch,
  });
  const wsProjects = [
    wsProject({}),
    wsProject({
      path: '/workspace/b',
      name: 'b',
      relPath: 'b',
      stats: { files: 5, nodes: 5, edges: 7, communities: 1, processes: 2, embeddings: 3 },
      complete: false,
    }),
    wsProject({
      path: '/workspace/c',
      name: 'c',
      relPath: 'c',
      kind: 'git',
      stats: null,
      complete: false,
    }),
  ];
  const wsTotals = I.aggregateProjects(wsProjects);
  check(
    'workspace totals sum indexed projects and count unindexed ones',
    wsTotals.indexed === 2 &&
      wsTotals.unindexed === 1 &&
      wsTotals.files === 15 &&
      wsTotals.nodes === 25 &&
      wsTotals.edges === 37 &&
      wsTotals.communities === 5 &&
      wsTotals.processes === 7 &&
      wsTotals.embeddings === 3,
    JSON.stringify(wsTotals),
  );
  const wsView = render(I.WorkspaceOverview, {
    projects: wsProjects,
    activePath: '/workspace/a',
    onSelectProject: () => {},
  });
  check(
    'the workspace card names the aggregate and its projects',
    wsView.text.includes('工作区概览') &&
      wsView.text.includes('2 个已索引') &&
      wsView.text.includes('1 个未索引') &&
      wsView.text.includes('合计 15 个文件') &&
      wsView.text.includes('a') &&
      wsView.text.includes('b'),
    wsView.text,
  );
  const wsSingle = render(I.WorkspaceOverview, {
    projects: [wsProject({})],
    activePath: '/workspace/a',
  });
  check('a single-project workspace renders no aggregate card', !wsSingle.text.includes('工作区概览'), wsSingle.text);
}
