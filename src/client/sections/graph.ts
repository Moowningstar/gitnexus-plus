import * as React from 'react';
import { Button, HAIRLINE, MUTED, SOFT_BG, Tag, h } from '../primitives';
import { ClientGraphEdge, ClientGraphNode, GraphViewState } from '../types';

/**
 * The graph card: a bounded, interactive view of the index.
 *
 * WHY CANVAS AND NOT A GRAPH LIBRARY
 * ----------------------------------
 * The browser half ships as one artifact built by `tsc` alone (see
 * `scripts/build-client.mjs`), and its `require` resolves only platform baseline
 * modules. A graph library such as sigma would have to be bundled, which needs a real
 * bundler — and the bundler this project would use cannot even start in the confined
 * environment the plugin is built in (`spawn EPERM` on the native helper). Two hundred
 * circles and their edges do not justify that dependency: canvas 2D with a fixed-iteration
 * force layout is a few hundred lines, deterministic, and keeps the build chain as it is.
 *
 * WHAT IT IS HONEST ABOUT
 * -----------------------
 * The host caps nodes and edges and reports what it left out; this component prints
 * those notes instead of presenting the picture as the whole graph. The overview shows
 * communities, not symbols — 2 266 symbols cannot be drawn usefully, and community
 * structure is the level at which an index is actually read. Clicking a community
 * drills into its members, and a symbol click opens its file at its line.
 */

const WIDTH = 720;
// The drawing is laid out in this fixed space and then fitted uniformly into whatever box
// the card gives it, so a wide card gets a wider picture instead of a stretched one.
const HEIGHT = 300;
const ITERATIONS = 140;

/** A small, fixed palette so a symbol's kind keeps its colour between renders. */
const KIND_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];
const COMMUNITY_COLOR = '#7aa2f7';

/**
 * Community colours from a greedy graph colouring.
 *
 * Adjacent communities get different colours, so the cluster graph stops reading as a
 * field of identical dots. Greedy is not guaranteed to need only four colours — that is
 * a theorem about planar graphs, and a projection is not planar — so the palette extends
 * to six and then cycles. Neighbours still differ in the common case; when the graph
 * genuinely needs more than six, two distant communities may share one.
 */
const COMMUNITY_PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];

export function communityColors(
  nodes: ClientGraphNode[],
  edges: Array<{ source: string; target: string }>,
): Map<string, string> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  // Highest degree first: colouring the busiest communities while the palette is free
  // keeps the total number of colours down.
  const order = [...nodes].sort(
    (a, b) => (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0),
  );
  const assigned = new Map<string, number>();
  for (const node of order) {
    const used = new Set<number>();
    for (const neighbour of adjacency.get(node.id) ?? []) {
      const colour = assigned.get(neighbour);
      if (colour !== undefined) used.add(colour);
    }
    let colour = 0;
    while (used.has(colour)) colour += 1;
    assigned.set(node.id, colour);
  }
  const out = new Map<string, string>();
  for (const [id, colour] of assigned) {
    out.set(id, COMMUNITY_PALETTE[colour % COMMUNITY_PALETTE.length] as string);
  }
  return out;
}

interface Point {
  x: number;
  y: number;
}

function colorFor(kind: string): string {
  let hash = 0;
  for (let index = 0; index < kind.length; index += 1) hash = (hash * 31 + kind.charCodeAt(index)) >>> 0;
  return KIND_COLORS[hash % KIND_COLORS.length];
}

function radiusFor(node: ClientGraphNode): number {
  if (node.kind === 'Community') return 7 + Math.sqrt(Math.max(1, node.symbolCount ?? 1)) * 2.2;
  return 4.5;
}

/**
 * Deterministic force layout: a circle for the initial spread, then a fixed number of
 * spring/repulsion steps.
 *
 * Deterministic on purpose — no `Math.random()`. A view that reshuffles on every poll
 * makes it impossible to follow a node, and it makes the layout untestable. Seeding from
 * the node index on a circle is arbitrary but stable, which is all the layout needs.
 */
function layout(nodes: ClientGraphNode[], edges: ClientGraphEdge[]): Map<string, Point> {
  const points = new Map<string, Point>();
  const count = Math.max(1, nodes.length);
  const radius = Math.min(WIDTH, HEIGHT) * 0.38;
  nodes.forEach((node, index) => {
    const angle = (index / count) * Math.PI * 2;
    points.set(node.id, { x: WIDTH / 2 + Math.cos(angle) * radius, y: HEIGHT / 2 + Math.sin(angle) * radius });
  });

  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const positions = nodes.map((node) => ({ ...(points.get(node.id) as Point) }));
  const links = edges
    .map((edge) => ({ a: index.get(edge.source), b: index.get(edge.target), weight: edge.weight }))
    .filter((link): link is { a: number; b: number; weight: number } => link.a !== undefined && link.b !== undefined);

  for (let step = 0; step < ITERATIONS; step += 1) {
    const delta = positions.map(() => ({ x: 0, y: 0 }));

    // Repulsion. O(n²) is deliberate: the budget is 220 nodes, so this is ~24k pairs
    // per step and finishes in tens of milliseconds — a quadtree would be more code
    // for a bound this small.
    for (let a = 0; a < positions.length; a += 1) {
      for (let b = a + 1; b < positions.length; b += 1) {
        const dx = positions[a].x - positions[b].x;
        const dy = positions[a].y - positions[b].y;
        const distanceSq = dx * dx + dy * dy + 0.01;
        const force = 900 / distanceSq;
        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance;
        const ny = dy / distance;
        delta[a].x += nx * force;
        delta[a].y += ny * force;
        delta[b].x -= nx * force;
        delta[b].y -= ny * force;
      }
    }

    // Attraction along edges, saturating so an aggregated weight of 40 does not
    // collapse two communities into one point.
    for (const link of links) {
      const dx = positions[link.b].x - positions[link.a].x;
      const dy = positions[link.b].y - positions[link.a].y;
      const distance = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const pull = (distance - 90) * 0.004 * Math.min(3, Math.max(1, link.weight));
      const nx = (dx / distance) * pull;
      const ny = (dy / distance) * pull;
      delta[link.a].x += nx;
      delta[link.a].y += ny;
      delta[link.b].x -= nx;
      delta[link.b].y -= ny;
    }

    for (let position = 0; position < positions.length; position += 1) {
      // Gentle gravity toward the centre keeps disconnected nodes on screen.
      delta[position].x += (WIDTH / 2 - positions[position].x) * 0.0025;
      delta[position].y += (HEIGHT / 2 - positions[position].y) * 0.0025;
      // Cap the step so one bad frame cannot fling a node out of the viewport.
      const step_ = Math.sqrt(delta[position].x ** 2 + delta[position].y ** 2);
      const scale = step_ > 18 ? 18 / step_ : 1;
      positions[position].x += delta[position].x * scale;
      positions[position].y += delta[position].y * scale;
    }
  }

  nodes.forEach((node, position) => points.set(node.id, positions[position]));
  return points;
}

/** Fit the drawn bounds into the canvas with a small margin. */
function fitTransform(points: Map<string, Point>): { x: number; y: number; k: number } {
  if (points.size === 0) return { x: 0, y: 0, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const margin = 28;
  const k = Math.min((WIDTH - margin * 2) / spanX, (HEIGHT - margin * 2) / spanY, 2.2);
  return {
    x: (WIDTH - spanX * k) / 2 - minX * k,
    y: (HEIGHT - spanY * k) / 2 - minY * k,
    k,
  };
}

export function GraphSection({ state }: { state: GraphViewState }) {
  const { projection, loading, error, routeState, scope, onOpenCommunity, onBack, onReload, onOpenSymbol } = state;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const transform = React.useRef<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  const drag = React.useRef<{ x: number; y: number; moved: boolean; active: boolean }>({
    x: 0,
    y: 0,
    moved: false,
    active: false,
  });
  const hovered = React.useRef<string | null>(null);
  const [hoverLabel, setHoverLabel] = React.useState<string | null>(null);

  const points = React.useMemo(
    () => layout(projection?.nodes ?? [], projection?.edges ?? []),
    [projection],
  );
  const colorsByCommunity = React.useMemo(
    () => communityColors(projection?.nodes ?? [], projection?.edges ?? []),
    [projection],
  );

  /**
   * Map a client point into the layout's 720×300 space.
   *
   * The canvas is sized by CSS and the drawing is fitted into it uniformly — a wide card
   * gets a wider picture rather than a horizontally stretched one, so pointer maths has
   * to undo both the fit and the pan/zoom.
   */
  const toLayout = React.useCallback((clientX: number, clientY: number): { x: number; y: number; fit: number } => {
    const canvas = canvasRef.current;
    if (canvas === null) return { x: 0, y: 0, fit: 1 };
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const fit = Math.min(cssW / WIDTH, cssH / HEIGHT);
    const ox = (cssW - WIDTH * fit) / 2;
    const oy = (cssH - HEIGHT * fit) / 2;
    return {
      x: (clientX - rect.left - ox) / fit,
      y: (clientY - rect.top - oy) / fit,
      fit,
    };
  }, []);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || WIDTH);
    const cssH = Math.max(1, rect.height || HEIGHT);
    const ratio = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const backingW = Math.round(cssW * ratio);
    const backingH = Math.round(cssH * ratio);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    // Uniform fit of the layout space into the CSS box: `min`, not per-axis scaling.
    const fit = Math.min(cssW / WIDTH, cssH / HEIGHT);
    const ox = (cssW - WIDTH * fit) / 2;
    const oy = (cssH - HEIGHT * fit) / 2;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const nodes = projection?.nodes ?? [];
    const edges = projection?.edges ?? [];
    const { x, y, k } = transform.current;
    const scale = fit * k;
    ctx.save();
    ctx.setTransform(
      ratio * scale,
      0,
      0,
      ratio * scale,
      ratio * (ox + fit * x),
      ratio * (oy + fit * y),
    );

    for (const edge of edges) {
      const from = points.get(edge.source);
      const to = points.get(edge.target);
      if (from === undefined || to === undefined) continue;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = `rgba(128, 138, 158, ${Math.min(0.55, 0.12 + edge.weight * 0.05)})`;
      ctx.lineWidth = Math.min(2.4, 0.6 + Math.log2(1 + edge.weight) * 0.5);
      ctx.stroke();
    }

    for (const node of nodes) {
      const point = points.get(node.id);
      if (point === undefined) continue;
      const radius = radiusFor(node);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle =
        node.kind === 'Community'
          ? colorsByCommunity.get(node.id) ?? COMMUNITY_COLOR
          : colorFor(node.kind);
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (hovered.current === node.id) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Labels only where they can be read: communities always, symbols only when the
    // view is zoomed in enough that the text does not become a grey smear.
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of nodes) {
      const point = points.get(node.id);
      if (point === undefined) continue;
      const show = node.kind === 'Community' ? k >= 0.55 : k >= 1.35 || hovered.current === node.id;
      if (!show) continue;
      ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
      ctx.fillText(node.name.slice(0, 18), point.x, point.y + radiusFor(node) + 2);
    }
    ctx.restore();
  }, [points, projection, colorsByCommunity]);

  React.useEffect(() => {
    transform.current = fitTransform(points);
    draw();
  }, [draw, points]);

  // The drawing is fitted to the canvas's CSS box, so a card resize has to redraw:
  // otherwise the bitmap keeps the previous width and the picture is distorted again
  // until the next interaction.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  // Wheel zoom is registered imperatively because React's `onWheel` is passive: without
  // `preventDefault` the sidebar scrolls while the graph zooms.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const { x: px, y: py } = toLayout(event.clientX, event.clientY);
      const current = transform.current;
      const nextK = Math.max(0.4, Math.min(4, current.k * Math.exp(-event.deltaY * 0.0012)));
      // Keep the point under the cursor fixed while zooming.
      const ratio = nextK / current.k;
      current.x = px - (px - current.x) * ratio;
      current.y = py - (py - current.y) * ratio;
      current.k = nextK;
      draw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [draw, toLayout]);

  /** Map a pointer event to the nearest node within its drawn radius, in logical units. */
  const nodeAt = (event: React.PointerEvent<HTMLCanvasElement>): ClientGraphNode | null => {
    const canvas = canvasRef.current;
    if (canvas === null || projection === null) return null;
    const { x: px, y: py } = toLayout(event.clientX, event.clientY);
    const { x, y, k } = transform.current;
    const wx = (px - x) / k;
    const wy = (py - y) / k;
    let best: ClientGraphNode | null = null;
    let bestDistance = Infinity;
    for (const node of projection.nodes) {
      const point = points.get(node.id);
      if (point === undefined) continue;
      const distance = Math.hypot(point.x - wx, point.y - wy);
      const threshold = radiusFor(node) + 4;
      if (distance < threshold && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    drag.current = { x: event.clientX, y: event.clientY, moved: false, active: true };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (drag.current.active) {
      const dx = event.clientX - drag.current.x;
      const dy = event.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      if (drag.current.moved) {
        const { fit } = toLayout(event.clientX, event.clientY);
        transform.current.x += dx / fit;
        transform.current.y += dy / fit;
        drag.current.x = event.clientX;
        drag.current.y = event.clientY;
        draw();
        return;
      }
    }
    const node = nodeAt(event);
    const next = node?.id ?? null;
    if (next !== hovered.current) {
      hovered.current = next;
      setHoverLabel(node === null ? null : node.kind === 'Community' ? `${node.name} · ${node.symbolCount ?? 0} 符号` : `${node.name}${node.filePath === null ? '' : ` · ${node.filePath}`}`);
      draw();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const wasDrag = drag.current.moved;
    drag.current.active = false;
    if (wasDrag) return;
    const node = nodeAt(event);
    if (node === null) return;
    if (node.kind === 'Community') onOpenCommunity(node.id);
    else onOpenSymbol(node);
  };

  const nodes = projection?.nodes ?? [];
  // An empty canvas with no explanation is indistinguishable from a hang — which is
  // exactly how a client running against an older host was reported. Every empty state
  // says which one it is.
  const emptyMessage =
    nodes.length > 0
      ? null
      : routeState === 'missing'
        ? '当前宿主还没有图路由：重启 DSH（不是刷新页面）后可用。'
        : loading
          ? '正在读取图…'
          : projection === null
            ? '暂无图数据。'
            : '该视图没有可画的节点。';
  // The list under the canvas is not decoration: it is the keyboard- and
  // screen-reader-reachable equivalent of the picture, and the only part of this card
  // that a non-canvas test can assert on.
  const listed = nodes.slice(0, 8);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
      scope === null
        ? h('span', { style: { fontWeight: 600 } }, '社区总览')
        : h('span', { style: { fontWeight: 600 } }, `社区 ${scope}`),
      projection === null
        ? null
        : h(
            'span',
            { style: MUTED },
            projection.view === 'communities'
              ? `${projection.nodes.length} / ${projection.total} 个社区`
              : `${projection.nodes.length} / ${projection.total} 个符号`,
          ),
      projection?.truncated === true ? h(Tag, { tone: 'outline' }, '已截断') : null,
      h('span', { style: { flex: 1 } }),
      scope === null ? null : h(Button, { variant: 'ghost', onClick: onBack }, '← 全部社区'),
      h(Button, { variant: 'ghost', onClick: onReload, disabled: loading }, loading ? '读取中…' : '重读图'),
    ),

    error === null
      ? null
      : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, error),

    h(
      'div',
      {
        style: {
          position: 'relative',
          width: '100%',
          // Responsive height: a fixed 300px box made a wide card letterbox the drawing,
          // and stretching the bitmap to fill it distorted every circle instead.
          height: 'clamp(260px, 32vw, 420px)',
          border: HAIRLINE,
          borderRadius: '6px',
          background: SOFT_BG,
          overflow: 'hidden',
        },
      },
      h('canvas', {
        ref: canvasRef,
        style: { width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerLeave: () => {
          drag.current.active = false;
          hovered.current = null;
          setHoverLabel(null);
          draw();
        },
      }),
      // An empty canvas explains itself, centred, rather than leaving a blank frame that
      // reads as a hang.
      emptyMessage === null
        ? null
        : h(
            'div',
            {
              style: {
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 24px',
                textAlign: 'center',
                ...MUTED,
                pointerEvents: 'none',
              },
            },
            emptyMessage,
          ),
      // A hover caption rather than redrawing a tooltip inside the canvas: it is
      // readable at any zoom, and it stays honest about the node's file.
      hoverLabel === null
        ? null
        : h(
            'div',
            {
              style: {
                position: 'absolute',
                left: '8px',
                bottom: '6px',
                padding: '2px 6px',
                borderRadius: '4px',
                background: 'rgba(15, 23, 42, 0.75)',
                fontSize: '11px',
                pointerEvents: 'none',
              },
            },
            hoverLabel,
          ),
    ),

    projection === null || nodes.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
          listed.map((node) =>
            h(
              Button,
              {
                key: node.id,
                variant: 'ghost',
                onClick: () => (node.kind === 'Community' ? onOpenCommunity(node.id) : onOpenSymbol(node)),
              },
              node.kind === 'Community'
                ? [
                    h('span', {
                      key: 'dot',
                      style: {
                        display: 'inline-block',
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        marginRight: '5px',
                        verticalAlign: 'middle',
                        background: colorsByCommunity.get(node.id) ?? COMMUNITY_COLOR,
                      },
                    }),
                    `${node.name} · ${node.symbolCount ?? 0}`,
                  ]
                : node.name,
            ),
          ),
          nodes.length > listed.length
            ? h('span', { style: { ...MUTED, alignSelf: 'center' } }, `…还有 ${nodes.length - listed.length} 个`)
            : null,
        ),

    projection !== null && Array.isArray(projection.notes) && projection.notes.length > 0
      ? h(
          'div',
          { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '2px' } },
          projection.notes.map((note, index) => h('div', { key: index }, `· ${note}`)),
        )
      : null,

    h(
      'div',
      { style: MUTED },
      scope === null
        ? '点一个社区看它的成员符号；滚轮缩放、拖动平移。节点数与边数由宿主限制，超出部分会明确标注。'
        : '点一个符号会在文件查看器中打开它并定位到行；滚轮缩放、拖动平移。',
    ),
  );
}
