// Pure scene data for the orbit "brain" view: point and line buffers, ring
// labels, the native colour palette, point sizes and framing. No three.js import,
// so it is unit-testable in Node. Everything here is a render-time derivation of a
// SystemGraph + OrbitLayout; the graph itself is never pruned.
//
// The palette is the native Code graph's (mac/.../CodeGraph/Views/CGPalette.swift):
// Apple system hues on a dark neutral ground, their darker shades on white. The
// CSS custom properties in os-tokens.css carry the same values; this file mirrors
// them as defaults (tests keep the two in step).

import type {
  CoreCategory,
  OrbitLayout,
  SystemCoreNode,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";
import { KIND_HUB, KIND_SHADE, hubOf } from "../viz";

/** The kind-to-hub table (viz.ts), re-exported with the palette so the legend reads one mapping. */
export { hubOf, KIND_HUB, KIND_SHADE };

/** The theme a colour is read for. */
export type PaletteTheme = "dark" | "light";

/** Apple system hues: the dark-appearance values (the native app's dark palette). */
export const SYSTEM_HUES_DARK = {
  blue: "#0A84FF",
  purple: "#BF5AF2",
  orange: "#FF9F0A",
  green: "#30D158",
  indigo: "#5E5CE6",
  mint: "#63E6E2",
  red: "#FF453A",
  yellow: "#FFD60A",
  cyan: "#64D2FF",
  pink: "#FF375F",
  brown: "#AC8E68",
  gray: "#8E8E93",
} as const;

/** The same hues darkened to read on a white ground (the light appearance). */
export const SYSTEM_HUES_LIGHT: Record<keyof typeof SYSTEM_HUES_DARK, string> = {
  blue: "#007AFF",
  purple: "#AF52DE",
  orange: "#FF9500",
  green: "#34C759",
  indigo: "#5856D6",
  mint: "#00A99D",
  red: "#FF3B30",
  yellow: "#B38600",
  cyan: "#1E9BD7",
  pink: "#E0234F",
  brown: "#8E6F4C",
  gray: "#6E6E73",
};

export type SystemHue = keyof typeof SYSTEM_HUES_DARK;

/** A system hue as hex for the theme. */
export function systemHue(name: SystemHue, theme: PaletteTheme = "dark"): string {
  return theme === "light" ? SYSTEM_HUES_LIGHT[name] : SYSTEM_HUES_DARK[name];
}

/** The hue of each code-brain category. */
export const CATEGORY_HUE: Record<CoreCategory, SystemHue> = {
  code: "blue",
  docs: "green",
  tests: "orange",
  knowledge: "purple",
  other: "gray",
};

/** Name of the CSS custom property a host may use for each category colour. */
export function categoryColorVar(cat: CoreCategory): string {
  return `--os-cat-${cat}`;
}

/** Category colour for a theme (the CSS custom properties mirror these). */
export function brainCategoryColour(cat: CoreCategory, theme: PaletteTheme = "dark"): string {
  return systemHue(CATEGORY_HUE[cat], theme);
}

/** Hex fallbacks used when the host does not supply a colour for a category (dark theme). */
export const DEFAULT_CATEGORY_COLORS: Record<CoreCategory, string> = {
  code: brainCategoryColour("code", "dark"),
  docs: brainCategoryColour("docs", "dark"),
  tests: brainCategoryColour("tests", "dark"),
  knowledge: brainCategoryColour("knowledge", "dark"),
  other: brainCategoryColour("other", "dark"),
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

/** An rgb triple (0..1) as `#rrggbb`. */
export function rgb01ToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Mixes two rgb triples (0..1); t = 0 keeps `a`, t = 1 gives `b`. */
export function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Lightens (amount > 0, toward white) or darkens (amount < 0, toward black) an rgb triple. */
export function shadeRgb(rgb: [number, number, number], amount: number): [number, number, number] {
  if (amount === 0) return rgb;
  return amount > 0 ? mixRgb(rgb, [1, 1, 1], amount) : mixRgb(rgb, [0, 0, 0], -amount);
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

/** Core size reference: a core of this many nodes draws at its full point size. */
const CORE_REF_COUNT = 400;

/**
 * Density factor of a code-brain core of `count` nodes: 1 for a sparse core, sqrt(REF / count)
 * for a dense one, never below 0.5. Dense graphs get smaller points so they stay readable.
 */
export function coreSizeScale(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.min(1, Math.max(0.5, Math.sqrt(CORE_REF_COUNT / count)));
}

/**
 * A code-brain point's diameter in CSS pixels: 6 to 9 by the node's degree (square root of its
 * share of the largest degree), scaled down by coreSizeScale for a dense core, never below 4.
 */
export function codePointPx(degree: number, maxDegree: number, count: number): number {
  const ratio = maxDegree > 0 && Number.isFinite(degree) ? Math.sqrt(Math.max(0, degree) / maxDegree) : 0;
  const base = 6 + 3 * Math.min(1, ratio);
  return Math.max(4, base * coreSizeScale(count));
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
  /** One diameter per node in CSS pixels (see codePointPx). */
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

    sizes[i] = codePointPx(Number.isFinite(node.degree) ? node.degree : 0, maxDegree, n);
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

/**
 * The cluster palette: the native app's 15 `clusterColors` (CGPalette.swift), in order. The
 * same hex serves both themes: the native palette was chosen to hold contrast on both grounds.
 */
export const CLUSTER_COLORS: readonly string[] = [
  "#4F7AA6",
  "#F28F2B",
  "#59A14F",
  "#E05759",
  "#B07AA1",
  "#75B8B3",
  "#EDC947",
  "#FF9EA6",
  "#9C755E",
  "#8C8C94",
  "#2E87AB",
  "#8273B3",
  "#CCBA75",
  "#54A887",
  "#C44F8C",
];

/** Number of distinct cluster colours. Cluster k uses palette slot k % CLUSTER_PALETTE_SIZE. */
export const CLUSTER_PALETTE_SIZE = CLUSTER_COLORS.length;

/** Fallback cluster palette: the native 15 cluster colours (see --os-cluster-1..15 in os-tokens.css). */
export const DEFAULT_CLUSTER_COLORS: readonly string[] = CLUSTER_COLORS;

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

/**
 * The edge colour rule of the code brain's point outlines: each point's outline is a shade of
 * its fill, lighter for a hub ring (hubMask[i] = 1) and darker for every other point. Returns
 * one rgb per node, in the same order as `colors`.
 */
export function buildEdgeShades(colors: Float32Array, hubMask: Uint8Array | null): Float32Array {
  const n = colors.length / 3;
  const out = new Float32Array(colors.length);
  for (let i = 0; i < n; i++) {
    const c: [number, number, number] = [colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!];
    const hub = hubMask ? hubMask[i] === 1 : false;
    const s = hub ? shadeRgb(c, 0.35) : shadeRgb(c, -0.3);
    out.set(s, i * 3);
  }
  return out;
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

// ---- The OS graph (VizGraph): colours by hub, status rings, sizes --------------------

/** A status name the page knows. */
export type VizStatusName = "ok" | "warn" | "off" | "running" | "unknown";

function statusName(status: string | null | undefined): VizStatusName | null {
  return status === "ok" || status === "warn" || status === "off" || status === "running" || status === "unknown"
    ? status
    : null;
}

/** The grey an off node is pulled toward (the status is not a colour: an off node reads as quiet). */
const OFF_GREY: SystemHue = "gray";
const OFF_MIX = 0.5;

/** Opacity of an off node: quiet, but still there. */
export const VIZ_OFF_ALPHA = 0.55;
/** Pulse of a running node's ring: its alpha swings between these two values, one cycle per PULSE_MS. */
export const VIZ_PULSE_MIN = 0.35;
export const VIZ_PULSE_MS = 1400;

/** Hub key of a viz node: a hub node's own drill key (or the level it is drawn in), else its kind's hub. */
export function vizNodeHub(node: { kind: string; drill?: string | null }, level?: string | null): string | null {
  if (node.kind === "hub") return node.drill ?? (level ?? null);
  return hubOf(node.kind);
}

/**
 * The colour of a kind as hex: the hue of its hub (blue code, purple knowledge, ...), shaded by
 * the kind (a feature is a little lighter than its kit, a skill source a little darker). A hub
 * node takes its own hub's hue (`hub`, or the level). An unknown kind is the neutral grey.
 */
export function kindColour(kind: string, theme: PaletteTheme = "dark", hub?: string | null): string {
  const key = kind === "hub" ? hub ?? null : hubOf(kind);
  if (!key) return systemHue(OFF_GREY, theme);
  const hue = HUB_HUE[key];
  if (!hue) return systemHue(OFF_GREY, theme);
  const base = hexToRgb01(systemHue(hue, theme));
  return rgb01ToHex(kind === "hub" ? base : shadeRgb(base, KIND_SHADE[kind] ?? 0));
}

/** The hue of each hub (the native graph's colour per part). */
export const HUB_HUE: Record<string, SystemHue> = {
  code: "blue",
  knowledge: "purple",
  memory: "indigo",
  skills: "mint",
  models: "orange",
  agents: "pink",
  routines: "green",
  kits: "yellow",
  activity: "cyan",
};

/** Point colour of a VizGraph node as rgb 0..1: its kind colour, greyed when off. */
export function vizNodeRgb(
  node: { kind: string; drill?: string | null; status: string | null },
  theme: PaletteTheme = "dark",
  level?: string | null,
): [number, number, number] {
  const hub = vizNodeHub(node, level);
  let rgb = hexToRgb01(kindColour(node.kind, theme, hub));
  if (statusName(node.status) === "off") rgb = mixRgb(rgb, hexToRgb01(systemHue(OFF_GREY, theme)), OFF_MIX);
  return rgb;
}

/** The status ring of a node: its hex colour and whether it pulses, or null for no ring. */
export function statusRing(status: string | null | undefined, theme: PaletteTheme = "dark"): { hex: string; pulse: boolean } | null {
  switch (statusName(status)) {
    case "ok":
      return { hex: systemHue("green", theme), pulse: false };
    case "warn":
      return { hex: systemHue("orange", theme), pulse: false };
    case "running":
      return { hex: systemHue("cyan", theme), pulse: true };
    default:
      return null;
  }
}

/** Base alpha of a VizGraph node: an off node is quiet, everything else is full. */
export function vizNodeAlpha(node: { status: string | null }): number {
  return statusName(node.status) === "off" ? VIZ_OFF_ALPHA : 1;
}

/** Hub diameter in CSS pixels: 4.2% of the stage's shorter side, clamped to 28..44. */
export function vizHubDiameterPx(stageMin: number): number {
  const s = Number.isFinite(stageMin) ? stageMin : 0;
  return Math.min(44, Math.max(28, s * 0.042));
}

/** Member diameter in CSS pixels: 12 for a normal node, growing with its size to 18; never below 10. */
export function vizMemberDiameterPx(size: number): number {
  const s = Number.isFinite(size) ? size : 1;
  return Math.max(10, Math.min(18, 12 + 2.5 * (s - 1)));
}

/** Diameter in CSS pixels of a VizGraph node on a stage of `stageMin` pixels (its shorter side). */
export function vizNodePx(node: { kind: string; size: number }, stageMin: number): number {
  return node.kind === "hub" ? vizHubDiameterPx(stageMin) : vizMemberDiameterPx(node.size);
}

/** Alpha of a hub-member edge: quiet, the hover and selection make it bright. */
export const MEMBER_EDGE_ALPHA = 0.35;

/** Edge alpha by weight: a cross-part edge sits between 0.45 (lightest) and 0.55 (heaviest); members use MEMBER_EDGE_ALPHA. */
export function vizEdgeAlphas(weights: number[]): Float32Array {
  const out = new Float32Array(weights.length);
  let max = 0;
  for (const w of weights) if (Number.isFinite(w)) max = Math.max(max, w);
  weights.forEach((w, i) => {
    const r = max > 0 && Number.isFinite(w) ? Math.min(1, Math.max(0, w / max)) : 0.5;
    out[i] = 0.45 + 0.1 * r;
  });
  return out;
}

/** Per-node rgb (0..1) of a VizGraph node list, in order, for the kind colouring. */
export function buildVizKindColors(
  nodes: Array<{ kind: string; drill?: string | null; status: string | null }>,
  theme: PaletteTheme = "dark",
  level?: string | null,
): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  nodes.forEach((node, i) => out.set(vizNodeRgb(node, theme, level), i * 3));
  return out;
}

/**
 * Edge colours of a VizGraph, 6 floats per edge (both ends). A member edge (`member[k]`) takes the
 * colour of its member, the end that is not a hub (`hubMask`); any other edge is the mix of its two
 * ends (the hub-hue mix). `rgb` is the node colour array (3 per node, in index order).
 */
export function buildVizEdgeColors(
  ends: Uint32Array,
  rgb: Float32Array,
  hubMask: Uint8Array,
  member: boolean[],
): Float32Array {
  const edges = ends.length / 2;
  const out = new Float32Array(edges * 2 * 3);
  const colourOf = (i: number): [number, number, number] => [rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!];
  for (let k = 0; k < edges; k++) {
    const a = ends[k * 2]!;
    const b = ends[k * 2 + 1]!;
    let mix: [number, number, number];
    if (member[k]) mix = colourOf(hubMask[a] === 1 ? b : a);
    else mix = mixRgb(colourOf(a), colourOf(b), 0.5);
    out.set([...mix, ...mix], k * 6);
  }
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

// ---- Framing ------------------------------------------------------------------------

/**
 * How much of the stage's shorter side a point set fills, as seen from `eye` looking at `target`:
 * the largest screen extent of any point, as a fraction of the half of the shorter side
 * (1 = touches the edge). Points behind the eye make it Infinity.
 */
export function screenFill(
  points: Array<{ x: number; y: number; z: number }>,
  eye: Vec3,
  target: Vec3,
  tanHalfV: number,
  aspect: number,
): number {
  const f0 = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
  const len0 = Math.hypot(f0.x, f0.y, f0.z);
  if (len0 === 0) return 0;
  const f = { x: f0.x / len0, y: f0.y / len0, z: f0.z / len0 };
  // right = forward x world up, then up = right x forward: an orthonormal screen basis.
  // f x (0,1,0) = (-f.z, 0, f.x): horizontal, so it stays well defined for any view that is not vertical.
  const horiz = Math.hypot(f.z, f.x) || 1;
  const r = { x: -f.z / horiz, y: 0, z: f.x / horiz };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  let fill = 0;
  const shorter = Math.min(aspect, 1);
  for (const p of points) {
    const v = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
    const zc = v.x * f.x + v.y * f.y + v.z * f.z;
    if (zc <= 1e-9) return Infinity;
    const xc = v.x * r.x + v.y * r.y + v.z * r.z;
    const yc = v.x * u.x + v.y * u.y + v.z * u.z;
    const fx = Math.abs(xc) / (zc * tanHalfV * aspect); // fraction of the half width
    const fy = Math.abs(yc) / (zc * tanHalfV); // fraction of the half height
    fill = Math.max(fill, Math.max(fx * aspect, fy) / shorter);
  }
  return fill;
}

/**
 * The camera distance (from `target`, along the unit `dir`) at which `points` fill `fill` of the
 * stage's shorter side (see screenFill). Iterates from `startDist`; a degenerate set keeps the start.
 */
export function fitDistance(
  points: Array<{ x: number; y: number; z: number }>,
  dir: Vec3,
  target: Vec3,
  tanHalfV: number,
  aspect: number,
  fill: number,
  startDist: number,
): number {
  let d = Math.max(startDist, 1e-6);
  for (let i = 0; i < 12; i++) {
    const eye = { x: target.x + dir.x * d, y: target.y + dir.y * d, z: target.z + dir.z * d };
    const cur = screenFill(points, eye, target, tanHalfV, aspect);
    if (!Number.isFinite(cur) || cur <= 0) break;
    if (Math.abs(cur - fill) < 0.002) break;
    d *= cur / fill;
  }
  return d;
}

/**
 * The radius the camera frames a VizGraph on, for the zoom bounds. With two or more hubs (the OS)
 * it is the hubs' bounding sphere; a drill-down (one hub at the origin) uses the 90th percentile of
 * every node.
 */
export function vizFramingRadius(nodes: Array<{ id: string; kind: string }>, layout: OrbitLayout): number {
  const hubs = nodes.filter((n) => n.kind === "hub");
  if (hubs.length >= 2) {
    let max = 0;
    for (const hub of hubs) {
      const p = layout.core.get(hub.id);
      if (p) max = Math.max(max, Math.hypot(p.x, p.y, p.z));
    }
    if (max > 0) return max;
  }
  return coreFramingRadius(
    nodes.map((n) => n.id),
    layout,
  );
}

/** Identifies what a level shows: the level and its node ids (sorted). Same signature, same camera. */
export function vizLevelSignature(viz: { level: string; nodes: Array<{ id: string }> }): string {
  const ids = viz.nodes.map((n) => n.id);
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${viz.level}|${ids.join("\n")}`;
}

/**
 * The largest members of each group, as node indices: the labels a close camera adds without
 * being asked for. Hubs, group rows and nodes already labelled are not counted.
 */
export function extraLabelIndices(nodes: Array<{ kind: string; group: number; size: number; labelled: boolean }>, perGroup: number): number[] {
  const byGroup = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    if (n.kind === "hub" || n.kind === "group" || n.labelled) return;
    const list = byGroup.get(n.group) ?? [];
    list.push(i);
    byGroup.set(n.group, list);
  });
  const out: number[] = [];
  for (const list of byGroup.values()) {
    list.sort((a, b) => nodes[b]!.size - nodes[a]!.size || a - b);
    out.push(...list.slice(0, perGroup));
  }
  return out.sort((a, b) => a - b);
}

// ---- Labels -------------------------------------------------------------------------

/** Member label: 14 px text in a pill; the box height is the pill's (font line + padding). */
export const LABEL_HEIGHT_PX = 22;
/** Hub label: 16 px semibold, a taller pill. */
export const HUB_LABEL_HEIGHT_PX = 24;

/** Estimated width of a label pill in CSS pixels (the layout does not measure the DOM): 14 px or 16 px semibold text plus 8 px padding each side. */
export function labelWidth(text: string, hub = false): number {
  return Math.ceil(text.length * (hub ? 9.2 : 7.8)) + 18;
}

/** The grid cell size of the label occupancy check, in CSS pixels (finer than a label: two overlapping labels always share a cell). */
export const LABEL_GRID_PX = 32;

/** One label that may be drawn: its anchor on the stage (CSS pixels, the pill's bottom centre), its box and its priority. */
export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  priority: number;
  size: number;
}

/**
 * Chooses the labels to draw, in priority order (then size, then id). A label is kept only when
 * none of the 32 px grid cells under its box is taken; a kept label takes its cells. So two kept
 * labels never overlap, and the rest are hidden. The box sits above the anchor: its bottom edge is
 * the anchor (the page positions a label with translate(-50%, -100%)).
 */
export function pickLabels(candidates: LabelCandidate[], cell: number = LABEL_GRID_PX): Set<string> {
  const order = [...candidates].sort((a, b) => b.priority - a.priority || b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Set<string>();
  const kept = new Set<string>();
  for (const c of order) {
    const left = c.x - c.w / 2;
    const right = c.x + c.w / 2;
    const top = c.y - c.h;
    const bottom = c.y;
    const x0 = Math.floor(left / cell);
    const x1 = Math.floor(right / cell);
    const y0 = Math.floor(top / cell);
    const y1 = Math.floor(bottom / cell);
    let free = true;
    for (let cx = x0; cx <= x1 && free; cx++) {
      for (let cy = y0; cy <= y1 && free; cy++) {
        if (taken.has(`${cx},${cy}`)) free = false;
      }
    }
    if (!free) continue;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) taken.add(`${cx},${cy}`);
    }
    kept.add(c.id);
  }
  return kept;
}

/** Label colours per theme: white text on a dark translucent pill, dark text on a white one. */
export const LABEL_STYLE = {
  dark: { color: "#ffffff", background: "rgba(10, 12, 18, 0.6)" },
  light: { color: "#111622", background: "rgba(255, 255, 255, 0.8)" },
} as const;

// ---- Compatibility: the palettes the page used before the native palette --------------

/** The kind colours (dark theme) by kind, for callers that want a flat table. */
export const VIZ_KIND_COLORS: Record<string, string> = Object.fromEntries(
  Object.keys(KIND_HUB).map((kind) => [kind, kindColour(kind, "dark")]),
);
/** The colour of a kind the table does not know (the neutral grey, dark theme). */
export const VIZ_KIND_FALLBACK = systemHue(OFF_GREY, "dark");
