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

// ---- The OS graph (VizGraph): kinds, status tints, sizes and labels ----------------

/**
 * Point colour per node kind. Mid-saturation hues that keep contrast on both the dark and the
 * light surface (the light theme darkens them, see vizNodeRgb). Unknown kinds use VIZ_KIND_FALLBACK.
 */
export const VIZ_KIND_COLORS: Record<string, string> = {
  hub: "#66b8d1",
  codeCluster: "#5b8def",
  sourceKind: "#c17be6",
  memoryRepo: "#4cc4d4",
  skill: "#e0b341",
  skillSource: "#d9a878",
  model: "#ef7b6b",
  provider: "#f2a0c6",
  caller: "#8f9bff",
  endpoint: "#a4d65e",
  chatTurn: "#4fbf86",
  agentRun: "#3fa7a0",
  liveSession: "#ff8fa3",
  routine: "#9fd16b",
  kit: "#d4a84a",
  feature: "#8a93a6",
  check: "#5ec8a8",
  activity: "#e5e7ee",
};
export const VIZ_KIND_FALLBACK = "#8a93a6";

/** Status tints: an ok, warn or running node takes a share of its colour from its status. */
export const VIZ_STATUS_COLORS: Record<VizStatusName, string> = {
  ok: "#4fbf86",
  warn: "#e0b341",
  off: "#8a93a6",
  running: "#66b8d1",
  unknown: "#8a93a6",
};
export type VizStatusName = "ok" | "warn" | "off" | "running" | "unknown";

/** How much of a node's colour the status takes (0 = none). Off nodes are greyed instead. */
const STATUS_MIX = 0.35;
const OFF_MIX = 0.6;
/** Alpha of a node whose status is off: it is still there, just quiet. */
export const VIZ_OFF_ALPHA = 0.4;
/** Hubs are brighter: their colour mixes this much toward white (dark) or stays (light). */
const HUB_LIGHTEN = 0.25;
/** The light theme darkens every hue this much so it keeps contrast on white. */
const LIGHT_DARKEN = 0.22;

/** Pulse of a running node: alpha swings between these two values, one cycle per PULSE_MS. */
export const VIZ_PULSE_MIN = 0.45;
export const VIZ_PULSE_MS = 1400;

/** Mixes two rgb triples (0..1); t = 0 keeps `a`, t = 1 gives `b`. */
export function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The colour of a kind (VIZ_KIND_FALLBACK for an unknown one), as rgb 0..1. */
export function vizKindRgb(kind: string): [number, number, number] {
  return hexToRgb01(VIZ_KIND_COLORS[kind] ?? VIZ_KIND_FALLBACK);
}

/** A status name the page knows, or null. */
function statusName(status: string | null | undefined): VizStatusName | null {
  return status === "ok" || status === "warn" || status === "off" || status === "running" || status === "unknown"
    ? status
    : null;
}

/**
 * The point colour of one VizGraph node, as rgb 0..1. The kind gives the hue; a status tints it
 * (ok green, warn amber, running blue, off greyed); a hub is lightened; the light theme darkens
 * the result. An unknown or missing status keeps the plain kind colour.
 */
export function vizNodeRgb(node: { kind: string; status: string | null }, theme: "dark" | "light"): [number, number, number] {
  let rgb = vizKindRgb(node.kind);
  const status = statusName(node.status);
  if (status === "off") rgb = mixRgb(rgb, hexToRgb01(VIZ_STATUS_COLORS.off), OFF_MIX);
  else if (status && status !== "unknown") rgb = mixRgb(rgb, hexToRgb01(VIZ_STATUS_COLORS[status]), STATUS_MIX);
  if (node.kind === "hub") rgb = mixRgb(rgb, [1, 1, 1], HUB_LIGHTEN);
  if (theme === "light") rgb = mixRgb(rgb, [0, 0, 0], LIGHT_DARKEN);
  return rgb;
}

/** Base alpha of a VizGraph node: an off node is quiet, everything else is full. */
export function vizNodeAlpha(node: { status: string | null }): number {
  return statusName(node.status) === "off" ? VIZ_OFF_ALPHA : 1;
}

/** Hubs draw this much larger than the members they hold, so each part reads as its centre. */
export const VIZ_HUB_SCALE = 1.6;

/**
 * Point size of a VizGraph node in scene units: 1.5 + 1.3 * size (log-scaled by the core), and a
 * hub at VIZ_HUB_SCALE times that. The hub's own size (4) is what makes it the largest point.
 */
export function vizNodeSize(node: { kind: string; size: number }): number {
  const s = Number.isFinite(node.size) ? Math.max(0, node.size) : 1;
  const base = 1.5 + 1.3 * s;
  return node.kind === "hub" ? base * VIZ_HUB_SCALE : base;
}

/** Edge alpha by weight: the lightest edge keeps a third of the full alpha, the heaviest is full. */
export function vizEdgeAlphas(weights: number[]): Float32Array {
  const out = new Float32Array(weights.length);
  let max = 0;
  for (const w of weights) if (Number.isFinite(w)) max = Math.max(max, w);
  weights.forEach((w, i) => {
    const r = max > 0 && Number.isFinite(w) ? Math.min(1, Math.max(0, w / max)) : 0.5;
    out[i] = 0.33 + 0.67 * r;
  });
  return out;
}

/** Per-node rgb (0..1) of a VizGraph node list, in order, for the kind colouring. */
export function buildVizKindColors(
  nodes: Array<{ kind: string; status: string | null }>,
  theme: "dark" | "light",
): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  nodes.forEach((node, i) => out.set(vizNodeRgb(node, theme), i * 3));
  return out;
}

/** The kinds in a node list with their counts, in first-seen order (the legend's rows). */
export function vizKindSummary(nodes: Array<{ kind: string }>): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/** The labelled nodes of a node list, in order (first occurrence per id). */
export function vizLabelled<T extends { id: string; labelled: boolean }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const node of nodes) {
    if (!node.labelled || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}
