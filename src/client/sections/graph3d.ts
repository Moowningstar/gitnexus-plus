import * as React from 'react';
import { HAIRLINE, MUTED, SOFT_BG, h } from '../primitives';
import { ClientGraphEdge, ClientGraphNode, ClientGraphProjection } from '../types';

/**
 * The 3D community overview that replaced the 2D force layout in the sidebar card.
 *
 * WHY 3D
 * ------
 * The 2D community projection has 51 nodes and 36 edges, but 23 communities are
 * isolated and the 19-node core is dense. On a plane the dense core becomes a
 * hairball; rotating around the Z axis separates clusters by depth and lets the
 * reader follow a path through them. This is an intentional replacement, not an
 * optional full-screen demo: the card is the only place the graph lives, so the 3D
 * renderer has to work at card width.
 *
 * NO THREE.JS
 * -----------
 * The client is compiled by `tsc` into one artifact and cannot bundle a library.
 * The projection, depth sorting and labels below are canvas 2D math for a budget of
 * 220 nodes, so the build chain stays unchanged.
 *
 * WHAT IT DOES NOT DRAW
 * ---------------------
 * The host sends community nodes, not their member symbols. Member symbols remain
 * one click away in the 2D drill-down, which is why clicking a community still calls
 * the same `onOpenCommunity` callback.
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Projected {
  x: number;
  y: number;
  scale: number;
  depth: number;
}

export interface Graph3DNode extends ClientGraphNode {
  position: Vec3;
  radius: number;
  degree: number;
  color: string;
  isolated: boolean;
}

export interface Graph3DLayout {
  nodes: Graph3DNode[];
  edges: ClientGraphEdge[];
  byId: Map<string, Graph3DNode>;
  components: number;
  isolated: number;
}

interface Graph3DEdgePair {
  source: string;
  target: string;
  weight: number;
}

function hashHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

function fibPoint(index: number, count: number, radius: number): Vec3 {
  if (count <= 1) return { x: 0, y: 0, z: 0 };
  const k = index + 0.5;
  const phi = Math.acos(1 - (2 * k) / count);
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;
  return {
    x: Math.cos(theta) * Math.sin(phi) * radius,
    y: Math.cos(phi) * radius,
    z: Math.sin(theta) * Math.sin(phi) * radius,
  };
}

function edgeKey(source: string, target: string): string {
  return source < target ? `${source}|${target}` : `${target}|${source}`;
}

/**
 * Build the deterministic 3D positions.
 *
 * The largest connected component sits at the origin, so the first camera angle has
 * a centre of gravity instead of landing on an empty hemisphere. Other components
 * orbit on a sphere; isolated nodes sit on an outer shell. No `Math.random()`: a
 * view that reshuffles on every poll is impossible to follow or test.
 */
export function buildGraph3DLayout(
  nodes: ReadonlyArray<ClientGraphNode>,
  edges: ReadonlyArray<ClientGraphEdge>,
): Graph3DLayout {
  const byId = new Map<string, Graph3DNode>();
  const known = new Set(nodes.map((node) => node.id));
  const pairs = new Map<string, Graph3DEdgePair>();
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());

  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target) || edge.source === edge.target) continue;
    const key = edgeKey(edge.source, edge.target);
    const pair = pairs.get(key);
    if (pair === undefined) {
      pairs.set(key, { source: edge.source, target: edge.target, weight: edge.weight });
    } else {
      pair.weight += edge.weight;
    }
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const componentIds: string[][] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const component: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length > 0) {
      const id = queue.pop() as string;
      component.push(id);
      for (const neighbour of adjacency.get(id) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
    componentIds.push(component);
  }
  componentIds.sort((a, b) => b.length - a.length);

  let isolated = 0;
  componentIds.forEach((component, componentIndex) => {
    const isIsolated = component.length === 1;
    if (isIsolated) isolated += 1;
    const count = component.length;
    const radius = isIsolated ? 640 : 500;
    let centre: Vec3 = { x: 0, y: 0, z: 0 };
    if (componentIndex > 0) {
      const base = fibPoint(componentIndex - 1, Math.max(1, componentIds.length - 1), radius);
      const wobble = ((hashHue(component[0] as string) % 100) / 100 - 0.5) * 22;
      centre = { x: base.x + wobble, y: base.y + wobble * 0.5, z: base.z - wobble * 0.5 };
    }
    const clusterRadius = count === 1 ? 0 : 60 + 28 * Math.sqrt(count);
    component.forEach((id, index) => {
      const source = nodes.find((node) => node.id === id);
      if (source === undefined) return;
      const offset = fibPoint(index, count, clusterRadius);
      const symbols = source.symbolCount ?? 1;
      const degree = adjacency.get(id)?.size ?? 0;
      byId.set(id, {
        ...source,
        position: { x: centre.x + offset.x, y: centre.y + offset.y, z: centre.z + offset.z },
        radius: 7 + Math.sqrt(Math.max(1, symbols)) * 1.8,
        degree,
        color: degree === 0 ? 'hsl(220 9% 58%)' : `hsl(${hashHue(id)} 68% 64%)`,
        isolated: degree === 0,
      });
    });
  });

  const aggregated: ClientGraphEdge[] = [];
  for (const pair of pairs.values()) {
    aggregated.push({ source: pair.source, target: pair.target, type: 'DEPENDS', weight: pair.weight });
  }

  return {
    nodes: nodes.map((node) => byId.get(node.id)).filter((node): node is Graph3DNode => node !== undefined),
    edges: aggregated,
    byId,
    components: componentIds.length,
    isolated,
  };
}

/** Shortest undirected path between two communities. */
export function graph3DPath(
  startId: string,
  endId: string,
  edges: ReadonlyArray<ClientGraphEdge>,
): string[] | null {
  if (startId === endId) return [startId];
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const existing = adjacency.get(from);
    if (existing === undefined) adjacency.set(from, [to]);
    else existing.push(to);
  };
  for (const edge of edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  const previous = new Map<string, string | null>([[startId, null]]);
  const queue: string[] = [startId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === endId) break;
    for (const neighbour of adjacency.get(id) ?? []) {
      if (previous.has(neighbour)) continue;
      previous.set(neighbour, id);
      queue.push(neighbour);
    }
  }
  if (!previous.has(endId)) return null;
  const path: string[] = [];
  let current: string | null | undefined = endId;
  while (current !== null && current !== undefined) {
    path.push(current);
    current = previous.get(current);
  }
  return path.reverse();
}

function project(
  point: Vec3,
  view: { yaw: number; pitch: number; dist: number },
  width: number,
  height: number,
): Projected | null {
  const cosYaw = Math.cos(view.yaw);
  const sinYaw = Math.sin(view.yaw);
  const cosPitch = Math.cos(view.pitch);
  const sinPitch = Math.sin(view.pitch);
  const x1 = point.x * cosYaw + point.z * sinYaw;
  const z1 = -point.x * sinYaw + point.z * cosYaw;
  const y2 = point.y * cosPitch - z1 * sinPitch;
  const z2 = point.y * sinPitch + z1 * cosPitch;
  const z = view.dist + z2;
  if (z < 1) return null;
  const scale = 900 / z;
  return { x: width / 2 + x1 * scale, y: height / 2 - y2 * scale, scale, depth: z };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function fileBase(filePath: string | null | undefined): string | null {
  if (filePath === null || filePath === undefined || filePath === '') return null;
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function labelFor(node: Graph3DNode): string {
  const id = `#${node.id.replace(/^comm_/, '').slice(0, 10)}`;
  const base = fileBase(node.representativeFile);
  return base === null ? `${node.name} ${id}` : `${node.name} · ${base} ${id}`;
}

const CONTROL: React.CSSProperties = {
  padding: '3px 6px',
  border: HAIRLINE,
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '10px',
  lineHeight: 1.5,
};

const ACTIVE: React.CSSProperties = {
  ...CONTROL,
  background: SOFT_BG,
  fontWeight: 600,
};

const OPTION_STYLE: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-base, #1e1e2e)',
  color: 'var(--dsw-alias-text-primary, #cdd6f4)',
};

export interface Graph3DViewProps {
  projection: ClientGraphProjection;
  onOpenCommunity: (id: string) => void;
}

export function Graph3DView({ projection, onOpenCommunity }: Graph3DViewProps): React.ReactElement {
  const layout = React.useMemo(
    () => buildGraph3DLayout(projection.nodes, projection.edges),
    [projection],
  );
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const screenRef = React.useRef<Array<{ node: Graph3DNode; p: Projected }>>([]);
  const viewRef = React.useRef({ yaw: 0.7, pitch: 0.28, dist: 3400 });
  const dragRef = React.useRef({ x: 0, y: 0, moved: false, active: false });

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [labelsMode, setLabelsMode] = React.useState<'auto' | 'all' | 'off'>('auto');
  const [showIsolated, setShowIsolated] = React.useState(true);
  const [autoRotate, setAutoRotate] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [pathMode, setPathMode] = React.useState(false);
  const [startId, setStartId] = React.useState<string | null>(null);
  const [endId, setEndId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  const selected = selectedId === null ? null : (layout.byId.get(selectedId) ?? null);
  const start = startId === null ? null : (layout.byId.get(startId) ?? null);
  const end = endId === null ? null : (layout.byId.get(endId) ?? null);
  const path = React.useMemo(() => {
    if (startId === null || endId === null) {
      return { nodes: new Set<string>(), edges: new Set<string>(), list: [] as string[], error: null as string | null };
    }
    const list = graph3DPath(startId, endId, layout.edges);
    if (list === null) {
      return { nodes: new Set<string>(), edges: new Set<string>(), list: [] as string[], error: '这两个社区不在同一连通分量，没有路径。' };
    }
    const pathNodes = new Set(list);
    const pathEdges = new Set<string>();
    for (let index = 1; index < list.length; index += 1) {
      pathEdges.add(edgeKey(list[index - 1] as string, list[index] as string));
    }
    return { nodes: pathNodes, edges: pathEdges, list, error: null };
  }, [endId, layout, startId]);

  const sortedNodes = React.useMemo(
    () => [...layout.nodes].sort((a, b) => b.degree - a.degree || (b.symbolCount ?? 0) - (a.symbolCount ?? 0) || a.id.localeCompare(b.id)),
    [layout],
  );
  const filteredNodes = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return sortedNodes;
    return sortedNodes.filter((node) => labelFor(node).toLowerCase().includes(needle));
  }, [query, sortedNodes]);
  const hovered = hoverId === null ? null : (layout.byId.get(hoverId) ?? null);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const background = context.createRadialGradient(width / 2, height / 2, 30, width / 2, height / 2, Math.max(width, height) * 0.8);
    background.addColorStop(0, '#191929');
    background.addColorStop(0.58, '#11111c');
    background.addColorStop(1, '#09090f');
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    context.save();
    context.strokeStyle = 'rgba(137,180,250,0.055)';
    context.lineWidth = 1;
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      context.beginPath();
      let started = false;
      for (let index = 0; index <= 120; index += 1) {
        const angle = (index / 120) * Math.PI * 2;
        const point: Vec3 =
          plane === 'xy'
            ? { x: Math.cos(angle) * 620, y: Math.sin(angle) * 620, z: 0 }
            : plane === 'xz'
              ? { x: Math.cos(angle) * 620, y: 0, z: Math.sin(angle) * 620 }
              : { x: 0, y: Math.cos(angle) * 620, z: Math.sin(angle) * 620 };
        const projected = project(point, viewRef.current, width, height);
        if (projected === null) {
          started = false;
          continue;
        }
        if (!started) {
          context.moveTo(projected.x, projected.y);
          started = true;
        } else {
          context.lineTo(projected.x, projected.y);
        }
      }
      context.stroke();
    }
    context.restore();

    const projected = layout.nodes
      .map((node) => ({ node, p: project(node.position, viewRef.current, width, height) }))
      .filter((entry): entry is { node: Graph3DNode; p: Projected } => entry.p !== null && (showIsolated || !entry.node.isolated));
    screenRef.current = projected;
    const projectedById = new Map(projected.map((entry) => [entry.node.id, entry]));

    const edgeLines: Array<{ source: Projected; target: Projected; weight: number; key: string; depth: number }> = [];
    for (const edge of layout.edges) {
      const source = projectedById.get(edge.source);
      const target = projectedById.get(edge.target);
      if (source === undefined || target === undefined) continue;
      edgeLines.push({
        source: source.p,
        target: target.p,
        weight: edge.weight,
        key: edgeKey(edge.source, edge.target),
        depth: source.p.depth + target.p.depth,
      });
    }
    edgeLines.sort((a, b) => b.depth - a.depth);
    for (const edge of edgeLines) {
      const isPath = path.edges.has(edge.key);
      const alpha = clamp(0.78 - (edge.depth / 2 - 700) / 2000, 0.08, 0.68);
      context.beginPath();
      context.moveTo(edge.source.x, edge.source.y);
      context.lineTo(edge.target.x, edge.target.y);
      context.strokeStyle = isPath ? 'rgba(250,179,135,0.95)' : `rgba(128,138,158,${alpha})`;
      context.lineWidth = (isPath ? 2.8 : 0.8) + Math.log2(1 + edge.weight) * (isPath ? 0.5 : 0.7);
      context.stroke();
    }

    for (const entry of projected) {
      const { node, p } = entry;
      const radius = Math.max(2.2, node.radius * p.scale);
      const isHot = node.id === selectedId || node.id === hoverId || path.nodes.has(node.id);
      context.beginPath();
      context.arc(p.x, p.y, radius + (isHot ? 4 : 0), 0, Math.PI * 2);
      context.fillStyle = isHot ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.04)';
      context.fill();
      context.beginPath();
      context.arc(p.x, p.y, radius, 0, Math.PI * 2);
      context.fillStyle = node.color;
      context.globalAlpha = clamp(0.95 - (p.depth / 2 - 700) / 2000, 0.42, 0.95);
      context.fill();
      context.globalAlpha = 1;
      if (node.id === selectedId || node.id === startId || node.id === endId) {
        context.beginPath();
        context.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
        context.strokeStyle = node.id === selectedId ? '#f5f5ff' : '#fab387';
        context.lineWidth = 2;
        context.stroke();
      }
    }

    if (labelsMode !== 'off') {
      const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
      const scored = projected
        .map((entry) => {
          const score =
            (entry.node.id === selectedId ? 1000 : 0) +
            (entry.node.id === hoverId ? 900 : 0) +
            (entry.node.id === startId || entry.node.id === endId ? 600 : 0) +
            (path.nodes.has(entry.node.id) ? 400 : 0) +
            entry.node.degree;
          return { ...entry, score };
        })
        .filter((entry) => labelsMode === 'all' || entry.score >= 4 || entry.node.id === selectedId || entry.node.id === hoverId)
        .sort((a, b) => b.score - a.score);
      const limit = labelsMode === 'all' ? scored.length : 8;
      for (const entry of scored.slice(0, limit)) {
        const { node, p } = entry;
        const text = labelFor(node);
        const force = node.id === selectedId || node.id === hoverId;
        context.font = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
        const textWidth = context.measureText(text).width;
        const boxWidth = textWidth + 6;
        const boxHeight = 14;
        const radius = Math.max(2.2, node.radius * p.scale);
        const x = clamp(p.x - boxWidth / 2, 2, Math.max(2, width - boxWidth - 2));
        const y = clamp(p.y + radius + 2, 2, Math.max(2, height - boxHeight - 2));
        const collides = boxes.some(
          (box) => x < box.x + box.w && x + boxWidth > box.x && y < box.y + box.h && y + boxHeight > box.y,
        );
        if (collides && !force) continue;
        boxes.push({ x, y, w: boxWidth, h: boxHeight });
        context.fillStyle = force ? 'rgba(30,30,45,0.94)' : 'rgba(16,16,26,0.80)';
        context.fillRect(x, y, boxWidth, boxHeight);
        context.strokeStyle = force ? 'rgba(137,180,250,0.55)' : 'rgba(42,42,61,0.8)';
        context.strokeRect(x, y, boxWidth, boxHeight);
        context.fillStyle = force ? '#ffffff' : '#e5e9f6';
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.fillText(text, x + 3, y + boxHeight / 2 + 0.5);
      }
    }
  }, [endId, hoverId, labelsMode, layout, path, selectedId, showIsolated, startId]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  React.useEffect(() => {
    if (!autoRotate) {
      draw();
      return undefined;
    }
    let frame = 0;
    const tick = (): void => {
      if (!dragRef.current.active) viewRef.current.yaw += 0.0024;
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [autoRotate, draw]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      viewRef.current.dist = clamp(viewRef.current.dist * Math.exp(event.deltaY * 0.0012), 1600, 5600);
      draw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [draw]);

  const pointOf = (event: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const nodeAt = (event: React.MouseEvent<HTMLCanvasElement>): Graph3DNode | null => {
    const point = pointOf(event);
    let best: Graph3DNode | null = null;
    let bestDistance = Infinity;
    for (const entry of screenRef.current) {
      const radius = Math.max(6, entry.node.radius * entry.p.scale + 4);
      const distance = Math.hypot(entry.p.x - point.x, entry.p.y - point.y);
      if (distance <= radius && distance < bestDistance) {
        best = entry.node;
        bestDistance = distance;
      }
    }
    return best;
  };

  const handleClick = (node: Graph3DNode): void => {
    if (!pathMode) {
      setSelectedId(node.id);
      return;
    }
    if (startId === null || (startId !== null && endId !== null)) {
      setStartId(node.id);
      setEndId(null);
      setSelectedId(node.id);
    } else if (node.id === startId) {
      setStartId(null);
      setEndId(null);
    } else {
      setEndId(node.id);
      setSelectedId(node.id);
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false, active: true };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current.active) {
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
      if (dragRef.current.moved) {
        viewRef.current.yaw += dx * 0.006;
        viewRef.current.pitch = clamp(viewRef.current.pitch + dy * 0.005, -1.2, 1.2);
        dragRef.current.x = event.clientX;
        dragRef.current.y = event.clientY;
        draw();
        return;
      }
    }
    setHoverId(nodeAt(event)?.id ?? null);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const moved = dragRef.current.moved;
    dragRef.current.active = false;
    if (moved) return;
    const node = nodeAt(event);
    if (node === null) {
      setSelectedId(null);
      return;
    }
    handleClick(node);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const node = nodeAt(event);
    if (node !== null) onOpenCommunity(node.id);
  };

  const resetView = (): void => {
    viewRef.current = { yaw: 0.7, pitch: 0.28, dist: expanded ? 3000 : 3400 };
    draw();
  };

  const cycleLabels = (): void => {
    setLabelsMode(labelsMode === 'auto' ? 'all' : labelsMode === 'all' ? 'off' : 'auto');
  };

  const canvasHeight = expanded ? 'min(56vh, 500px)' : 'clamp(240px, 28vw, 340px)';

  const pathNames = start === null || end === null ? [] : path.list.map((id) => layout.byId.get(id)).filter((node): node is Graph3DNode => node !== undefined);

  React.useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setExpanded(false);
      viewRef.current.dist = 3400;
      draw();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, draw]);

  const symbolTotal = projection.nodes.reduce((sum, node) => sum + (node.symbolCount ?? 0), 0);

  const canvasBlock = h(
    'div',
    {
      style: {
        position: 'relative',
        width: '100%',
        height: canvasHeight,
        border: HAIRLINE,
        borderRadius: '6px',
        background: '#11111c',
        overflow: 'hidden',
      },
    },
    h('canvas', {
      ref: canvasRef,
      'aria-label': '社区关系三维图：拖拽旋转，滚轮缩放，单击社区查看详情，双击进入社区',
      style: { width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onDoubleClick,
      onPointerLeave: () => {
        dragRef.current.active = false;
        setHoverId(null);
      },
    }),
    hovered === null
      ? null
      : h(
          'div',
          {
            style: {
              position: 'absolute',
              left: '6px',
              bottom: '6px',
              maxWidth: 'calc(100% - 12px)',
              padding: '3px 6px',
              borderRadius: '4px',
              background: 'rgba(13,13,23,0.9)',
              color: '#e5e9f6',
              fontSize: '10px',
              pointerEvents: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          `${labelFor(hovered)} · ${hovered.degree} 度 · ${hovered.symbolCount ?? 0} 符号`,
        ),
    layout.nodes.length === 0
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...MUTED,
              padding: '0 20px',
              textAlign: 'center',
              pointerEvents: 'none',
            },
          },
          '该视图没有可画的社区。',
        )
      : null,
  );

  const controlsRow = h(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' } },
    h(
      'select',
      {
        value: selectedId ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSelectedId(event.target.value === '' ? null : event.target.value),
        style: { flex: '1 1 120px', minWidth: 0, padding: '3px 4px', border: HAIRLINE, borderRadius: '4px', background: 'var(--dsw-alias-bg-base, #1e1e2e)', color: 'var(--dsw-alias-text-primary, #cdd6f4)', colorScheme: 'dark', fontSize: '10px' },
      },
      h('option', { value: '', style: OPTION_STYLE }, '选择社区…'),
      sortedNodes.map((node) => h('option', { key: node.id, value: node.id, style: OPTION_STYLE }, labelFor(node))),
    ),
    h('button', { type: 'button', style: pathMode ? ACTIVE : CONTROL, onClick: () => { const next = !pathMode; setPathMode(next); if (!next) { setStartId(null); setEndId(null); } } }, '路径'),
    h('button', { type: 'button', style: CONTROL, onClick: cycleLabels }, `标签：${labelsMode === 'auto' ? '自动' : labelsMode === 'all' ? '全部' : '关闭'}`),
    h('button', { type: 'button', style: showIsolated ? ACTIVE : CONTROL, onClick: () => setShowIsolated(!showIsolated) }, `孤立：${showIsolated ? '显示' : '隐藏'}`),
    h('button', { type: 'button', style: autoRotate ? ACTIVE : CONTROL, onClick: () => setAutoRotate(!autoRotate) }, '自动'),
    h('button', { type: 'button', style: expanded ? ACTIVE : CONTROL, onClick: () => { const next = !expanded; setExpanded(next); viewRef.current.dist = next ? 3000 : 3400; draw(); } }, expanded ? '收起' : '展开'),
    h('button', { type: 'button', style: CONTROL, onClick: resetView }, '适配'),
  );

  const detailBlock = selected === null
    ? h('div', { style: { ...MUTED, fontSize: '10px' } }, '拖拽旋转 Z 轴、滚轮缩放；单击看代表文件，双击进入社区。')
    : h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        h('span', { style: { width: '8px', height: '8px', flex: '0 0 8px', borderRadius: '50%', background: selected.color } }),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px' } },
          `${labelFor(selected)} · ${selected.symbolCount ?? 0} 符号`,
        ),
        h('button', { type: 'button', style: CONTROL, onClick: () => onOpenCommunity(selected.id) }, '进入社区'),
      );

  const pathBlock = pathMode
    ? h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px' } },
        h(
          'div',
          { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          h('span', { style: MUTED }, '路径'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: CONTROL, onClick: () => { setStartId(null); setEndId(null); } }, '清除'),
        ),
        start === null || end === null
          ? h('div', { style: MUTED }, '点两个社区；路径按无向关系计算。')
          : path.error === null
            ? h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', color: '#f6d5bc' } },
                pathNames.map((node) => h('span', { key: node.id, style: { padding: '1px 4px', borderRadius: '3px', background: 'rgba(250,179,135,0.12)' } }, node.name)),
              )
            : h('div', { style: { color: '#f7768e' } }, path.error),
        start !== null && end !== null && path.error === null
          ? h('button', { type: 'button', style: CONTROL, onClick: () => setSelectedId(path.list[path.list.length - 1] ?? null) }, `终点 ${end.name}`)
          : null,
      )
    : null;

  const notesBlock = projection.notes.length === 0
    ? null
    : h(
        'div',
        { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '1px', fontSize: '10px' } },
        projection.notes.map((note, index) => h('div', { key: index }, `· ${note}`)),
      );

  const footerBlock = h('div', { style: { ...MUTED, fontSize: '10px' } }, `拖拽旋转、滚轮缩放；单击选中，双击进入社区。节点与边预算 ${projection.budget.nodes}/${projection.budget.edges}，超出部分会明确标注。`);

  const listBlock = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'auto', maxHeight: 'min(38vh, 360px)', paddingRight: '2px' } },
    filteredNodes.length === 0
      ? h('div', { style: { ...MUTED, fontSize: '10px' } }, '没有匹配的社区。')
      : filteredNodes.map((node) =>
          h(
            'button',
            {
              key: node.id,
              type: 'button',
              onClick: () => {
                setSelectedId(node.id);
                setHoverId(null);
              },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                minWidth: 0,
                padding: '3px 4px',
                border: 'none',
                borderLeft: node.id === selectedId ? '2px solid #89b4fa' : '2px solid transparent',
                borderRadius: '3px',
                background: node.id === selectedId ? SOFT_BG : 'transparent',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: '10px',
              },
            },
            h('span', { style: { width: '7px', height: '7px', flex: '0 0 7px', borderRadius: '50%', background: node.color } }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, labelFor(node)),
            h('span', { style: { ...MUTED, flex: '0 0 auto' } }, String(node.symbolCount ?? 0)),
          ),
        ),
  );

  const close = (): void => {
    setExpanded(false);
    viewRef.current.dist = 3400;
    draw();
  };

  const sidebar = h(
    'aside',
    {
      'aria-label': '社区列表与选中详情',
      style: { width: 'min(320px, 36vw)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, maxHeight: '72vh', overflow: 'auto' },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '0 2px 2px' } },
      h(
        'div',
        { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontSize: '15px', fontWeight: 700, lineHeight: 1.25 } }, '社区图 3D'),
        h('div', { style: { ...MUTED, fontSize: '10px' } }, `${projection.nodes.length} / ${projection.total} 个社区`),
      ),
      h('button', { type: 'button', style: CONTROL, onClick: close }, '收起'),
    ),
    h('div', { style: { ...MUTED, fontSize: '10px' } }, `${projection.nodes.length} 社区 · ${projection.edges.length} 对关系 · ${layout.isolated} 孤立 · ${symbolTotal} 符号`),
    detailBlock,
    pathBlock,
    h('input', {
      type: 'search',
      value: query,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
      placeholder: '搜索社区 / 文件 / #id…',
      style: { padding: '4px 6px', border: HAIRLINE, borderRadius: '4px', background: 'transparent', color: 'inherit', fontSize: '10px' },
    }),
    h('div', { style: { ...MUTED, fontSize: '10px', fontWeight: 600 } }, '社区列表'),
    listBlock,
  );

  const card = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    canvasBlock,
    controlsRow,
    detailBlock,
    pathBlock,
    notesBlock,
    footerBlock,
  );

  if (!expanded) return card;

  return h(
    'div',
    {
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '18px',
        background: 'rgba(0,0,0,0.55)',
      },
      onClick: close,
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '社区图 3D 放大视图',
        style: {
          width: 'min(94vw, 1040px)',
          maxHeight: '86vh',
          overflow: 'auto',
          padding: '12px',
          border: HAIRLINE,
          borderRadius: '8px',
          background: 'var(--dsw-alias-bg-base, #11111b)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.45)',
        },
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 } },
        sidebar,
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
          h(
            'div',
            { style: { position: 'relative', minWidth: 0 } },
            canvasBlock,
            h(
              'div',
              { style: { position: 'absolute', top: '6px', left: '6px', right: '6px', display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' } },
              h('div', { style: { pointerEvents: 'auto', maxWidth: '100%' } }, controlsRow),
            ),
          ),
          notesBlock,
          footerBlock,
        ),
      ),
    ),
  );
}
