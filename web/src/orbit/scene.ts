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
  const cap = Math.max(0, Math.floor(Number.isFinite(maxEdges) ? maxEdges : 6000));
  const weight = (w: number) => (Number.isFinite(w) ? w : 0);
  const usable = graph.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => layout.core.has(edge.source) && layout.core.has(edge.target));
  usable.sort((a, b) => weight(b.edge.weight) - weight(a.edge.weight) || a.index - b.index);
  const kept = usable.slice(0, cap);

  const out = new Float32Array(kept.length * 6);
  kept.forEach(({ edge }, k) => {
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
