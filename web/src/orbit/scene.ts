// Pure scene data for the orbit "brain" view: point and line buffers, ring
// labels and colour helpers. No three.js import, so it is unit-testable in Node.
// Everything here is a render-time derivation of a SystemGraph + OrbitLayout;
// the graph itself is never pruned.

import type {
  CoreCategory,
  OrbitLayout,
  SystemCoreNode,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";

/** Name of the CSS custom property a host may use for each category colour. */
export function categoryColorVar(cat: CoreCategory): string {
  return `--os-cat-${cat}`;
}

/** Hex fallbacks used when the host does not supply a colour for a category. */
export const DEFAULT_CATEGORY_COLORS: Record<CoreCategory, string> = {
  code: "#5b8def",
  docs: "#e0b341",
  tests: "#4fbf86",
  knowledge: "#c17be6",
  other: "#8a93a6",
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True when `value` is a 3- or 6-digit hex colour (leading # optional). */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

/** Parse `#rrggbb` / `#rgb` into [r, g, b] in 0..1. Throws TypeError on anything else. */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = HEX.exec(hex.trim());
  if (!m) throw new TypeError(`Not a hex colour: ${hex}`);
  let digits = m[1]!;
  if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
  const n = parseInt(digits, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** Core nodes in graph order, first occurrence of each id only (matches orbitLayout). */
export function uniqueCoreNodes(graph: SystemGraph): SystemCoreNode[] {
  const seen = new Set<string>();
  const out: SystemCoreNode[] = [];
  for (const node of graph.core) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

/** Core size reference: a core of this many nodes draws at the base point size. */
const CORE_REF_COUNT = 400;

/**
 * Point-size multiplier for a core of `count` nodes: sqrt(REF / count), clamped. A sparse
 * core gets fewer, larger points; a dense one smaller points, so overlap stays readable.
 */
export function coreSizeScale(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.min(2, Math.max(0.4, Math.sqrt(CORE_REF_COUNT / count)));
}

/**
 * The radius framing fits: the 90th percentile of the core nodes' distances from the origin.
 * A few far-out nodes would otherwise shrink the whole core on screen; they may run past the edge.
 */
export function coreFramingRadius(ids: string[], layout: OrbitLayout, quantile = 0.9): number {
  const norms: number[] = [];
  for (const id of ids) {
    const p = layout.core.get(id);
    if (p) norms.push(Math.hypot(p.x, p.y, p.z));
  }
  if (norms.length === 0) return 0;
  norms.sort((a, b) => a - b);
  return norms[Math.min(norms.length - 1, Math.floor(quantile * (norms.length - 1)))] ?? 0;
}

export interface PointBuffers {
  /** x, y, z per node. */
  positions: Float32Array;
  /** r, g, b per node, 0..1. */
  colors: Float32Array;
  /** One point size per node: 1.5 + 2.5 * sqrt(degree / maxDegree). */
  sizes: Float32Array;
  /** Node ids, same order as the buffers. */
  ids: string[];
}

function rgbFor(cat: CoreCategory, colors: Record<CoreCategory, string>): [number, number, number] {
  const hex = isHexColor(colors[cat]) ? colors[cat] : DEFAULT_CATEGORY_COLORS[cat];
  return hexToRgb01(hex);
}

/**
 * Flat per-node buffers in `graph.core` order (first occurrence per id). A node
 * missing from the layout is placed at the origin rather than dropped, so the
 * buffers always line up with `ids`.
 */
export function buildPointBuffers(
  graph: SystemGraph,
  layout: OrbitLayout,
  colors: Record<CoreCategory, string>,
): PointBuffers {
  const nodes = uniqueCoreNodes(graph);
  const n = nodes.length;
  let maxDegree = 0;
  for (const node of nodes) {
    if (Number.isFinite(node.degree)) maxDegree = Math.max(maxDegree, node.degree);
  }

  const positions = new Float32Array(n * 3);
  const rgb = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const ids: string[] = [];
  nodes.forEach((node, i) => {
    const p = layout.core.get(node.id) ?? ORIGIN;
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;

    const [r, g, b] = rgbFor(node.category, colors);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;

    const degree = Number.isFinite(node.degree) ? Math.max(0, node.degree) : 0;
    const ratio = maxDegree > 0 ? Math.sqrt(degree / maxDegree) : 0;
    sizes[i] = 1.5 + 2.5 * ratio;
    ids.push(node.id);
  });
  return { positions, colors: rgb, sizes, ids };
}

/**
 * Line segments for the core edges: 6 floats per edge (x1 y1 z1 x2 y2 z2).
 * Edges whose endpoints are not in the layout are skipped. When there are more
 * than `maxEdges`, the highest-weight edges are kept (ties keep graph order).
 * This is a render-time filter only: the graph itself is never pruned.
 */
export function buildEdgeBuffer(
  graph: SystemGraph,
  layout: OrbitLayout,
  maxEdges = 6000,
): Float32Array {
  const kept = keepEdges(graph, (edge) => layout.core.has(edge.source) && layout.core.has(edge.target), maxEdges);

  const out = new Float32Array(kept.length * 6);
  kept.forEach((edge, k) => {
    const a = layout.core.get(edge.source)!;
    const b = layout.core.get(edge.target)!;
    out.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
  });
  return out;
}

export interface RingLabel {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  z: number;
}

/** Ring items with their layout positions, in item order (first occurrence per id, items without a position dropped). */
export function ringLabels(items: SystemRingItem[], positions: Map<string, Vec3>): RingLabel[] {
  const seen = new Set<string>();
  const out: RingLabel[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const p = positions.get(item.id);
    if (!p) continue;
    out.push({ id: item.id, label: item.label, kind: item.kind, x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/** Ring items with their layout positions, in `graph.ring` order (first occurrence per id). */
export function ringLabelPositions(graph: SystemGraph, layout: OrbitLayout): RingLabel[] {
  return ringLabels(graph.ring, layout.ring);
}

/** Edges that pass `accept`, highest weight first (ties keep graph order), at most `maxEdges`. */
function keepEdges(
  graph: SystemGraph,
  accept: (edge: SystemGraph["edges"][number]) => boolean,
  maxEdges: number,
): Array<SystemGraph["edges"][number]> {
  const cap = Math.max(0, Math.floor(Number.isFinite(maxEdges) ? maxEdges : 6000));
  const weight = (w: number) => (Number.isFinite(w) ? w : 0);
  const usable = graph.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => accept(edge));
  usable.sort((a, b) => weight(b.edge.weight) - weight(a.edge.weight) || a.index - b.index);
  return usable.slice(0, cap).map(({ edge }) => edge);
}

/** Number of distinct cluster colours. Cluster k uses palette slot k % CLUSTER_PALETTE_SIZE. */
export const CLUSTER_PALETTE_SIZE = 10;

/**
 * Fallback cluster palette (the dark theme's values; see --os-cluster-1..10 in os-tokens.css).
 * Ten hues that stay apart from each other and keep 3:1 against the dark surface.
 */
export const DEFAULT_CLUSTER_COLORS: readonly string[] = [
  "#5b8def",
  "#e0b341",
  "#4fbf86",
  "#c17be6",
  "#ef7b6b",
  "#4cc4d4",
  "#f2a0c6",
  "#a4d65e",
  "#8f9bff",
  "#d9a878",
];

/** Name of the CSS custom property for cluster palette slot `slot` (1-based). */
export function clusterColorVar(slot: number): string {
  return `--os-cluster-${slot}`;
}

/** Hex colour of cluster `community` (0 = largest) in `palette`. */
export function clusterColor(community: number, palette: readonly string[]): string {
  const n = palette.length || CLUSTER_PALETTE_SIZE;
  const slot = ((Math.floor(Number.isFinite(community) ? community : 0) % n) + n) % n;
  return palette[slot] ?? DEFAULT_CLUSTER_COLORS[0]!;
}

const RGB_FN = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/i;

/**
 * A CSS colour value as `#rrggbb`, or null when it is neither hex nor an rgb()/rgba()
 * form (space or comma separated, numbers or percentages). Used for the CSS custom
 * properties the view reads as its palette.
 */
export function colorToHex(value: string): string | null {
  const v = value.trim();
  if (isHexColor(v)) {
    const [r, g, b] = hexToRgb01(v).map((c) => Math.round(c * 255));
    return `#${[r!, g!, b!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  const m = RGB_FN.exec(v);
  if (!m) return null;
  const channel = (num: string, pct: string) => {
    const x = Number(num);
    if (!Number.isFinite(x)) return NaN;
    return Math.min(255, Math.max(0, Math.round(pct ? (x * 255) / 100 : x)));
  };
  const parts = [channel(m[1]!, m[2]!), channel(m[3]!, m[4]!), channel(m[5]!, m[6]!)];
  if (parts.some((c) => Number.isNaN(c))) return null;
  return `#${parts.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Per-node rgb (0..1) for the category colours, in `nodes` order. */
export function buildCategoryColors(
  nodes: Array<{ category: CoreCategory }>,
  colors: Record<CoreCategory, string>,
): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    const [r, g, b] = rgbFor(node.category, colors);
    out.set([r, g, b], i * 3);
  });
  return out;
}

/** Per-node rgb (0..1) for the cluster colours, in `nodes` order. */
export function buildClusterColors(
  nodes: Array<{ community: number }>,
  palette: readonly string[],
): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    out.set(hexToRgb01(clusterColor(node.community, palette)), i * 3);
  });
  return out;
}

/** The community indexes present among `nodes` with their node counts, in community order (0 = largest first). */
export function clusterSummary(nodes: Array<{ community: number }>): Array<{ community: number; count: number }> {
  const counts = new Map<number, number>();
  for (const node of nodes) {
    const c = Number.isFinite(node.community) ? node.community : 0;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([community, count]) => ({ community, count }));
}

export interface EdgeData {
  /** 6 floats per edge (x1 y1 z1 x2 y2 z2). */
  positions: Float32Array;
  /** Two node indexes per edge, into the core node order `nodeIndex` was built from. */
  ends: Uint32Array;
}

/**
 * Like buildEdgeBuffer, but also returns each kept edge's endpoint node indexes, so the
 * view can highlight the edges that touch a selected node. Edges with an endpoint that is
 * not in `nodeIndex` (or not in the layout) are skipped.
 */
export function buildEdgeData(
  graph: SystemGraph,
  layout: OrbitLayout,
  nodeIndex: Map<string, number>,
  maxEdges = 6000,
): EdgeData {
  const kept = keepEdges(
    graph,
    (edge) =>
      nodeIndex.has(edge.source) && nodeIndex.has(edge.target) && layout.core.has(edge.source) && layout.core.has(edge.target),
    maxEdges,
  );
  const positions = new Float32Array(kept.length * 6);
  const ends = new Uint32Array(kept.length * 2);
  kept.forEach((edge, k) => {
    const a = layout.core.get(edge.source)!;
    const b = layout.core.get(edge.target)!;
    positions.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
    ends[k * 2] = nodeIndex.get(edge.source)!;
    ends[k * 2 + 1] = nodeIndex.get(edge.target)!;
  });
  return { positions, ends };
}
