// Deterministic 3D "orbit" layout for the Agentic-OS visual: a dense spherical
// point cloud (the core, grouped by community) with a flat ring of recent
// activity orbiting it. Pure and seeded; no I/O, no dependencies. Relaxation is
// O(E + N) per step (no all-pairs repulsion), so it stays cheap at ~20k nodes.

import type { SystemGraph } from "./builder.js";

export interface Vec3 { x: number; y: number; z: number; }

export interface OrbitOptions {
  /** Radius of the core sphere. Default 100. */
  coreRadius?: number;
  /** Radius of the activity ring (plane y = 0). Default 170. */
  ringRadius?: number;
  /** Relaxation steps over the core. Default 60. */
  iterations?: number;
  /** PRNG seed for the initial scatter. Default 1. */
  seed?: number;
}

export interface OrbitLayout {
  /** Every core node id -> position. */
  core: Map<string, Vec3>;
  /** Every ring item id -> position. */
  ring: Map<string, Vec3>;
  /** Index = community number. */
  communityCenters: Vec3[];
  /** Max distance from the origin of any core or ring point (0 when empty). */
  bounds: { radius: number };
}

const TAU = Math.PI * 2;
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` points spread evenly on a sphere of the given radius (golden-spiral). */
export function fibonacciSphere(n: number, radius: number): Vec3[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: 0, z: radius }];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2; // -1..1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({
      x: Math.cos(theta) * r * radius,
      y: y * radius,
      z: Math.sin(theta) * r * radius,
    });
  }
  return out;
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegInt(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function norm(p: Vec3): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

/**
 * Lay out a SystemGraph in 3D. Core nodes start scattered around their community
 * center, then relax: edges pull endpoints together (weight capped at 4), nodes
 * drift gently toward their community center, and anything outside the core
 * sphere is projected back onto its surface. Ring items sit evenly on a circle
 * in the XZ plane; item 0 (newest) is at angle 0 and the rest follow at 2π/n.
 * Output is deterministic for a given graph and options.
 */
export function orbitLayout(graph: SystemGraph, opts: OrbitOptions = {}): OrbitLayout {
  const coreRadius = positive(opts.coreRadius, 100);
  const ringRadius = positive(opts.ringRadius, 170);
  const iterations = nonNegInt(opts.iterations, 60);
  const rng = mulberry32(opts.seed ?? 1);

  // ---- Core: index nodes (first occurrence wins on duplicate ids).
  const index = new Map<string, number>();
  const ids: string[] = [];
  const community: number[] = [];
  for (const node of graph.core) {
    if (index.has(node.id)) continue;
    index.set(node.id, ids.length);
    ids.push(node.id);
    community.push(nonNegInt(node.community, 0));
  }
  const n = ids.length;

  let k = 0;
  for (const c of community) if (c + 1 > k) k = c + 1;
  const sizes = new Array<number>(k).fill(0);
  for (const c of community) sizes[c] = (sizes[c] ?? 0) + 1;
  const largest = sizes.reduce((m, s) => Math.max(m, s), 0);

  // Community centers: a single community sits at the origin.
  const communityCenters: Vec3[] =
    k === 1 ? [ORIGIN] : fibonacciSphere(k, coreRadius * 0.55);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const center = communityCenters[community[i] ?? 0] ?? ORIGIN;
    cx[i] = center.x;
    cy[i] = center.y;
    cz[i] = center.z;
  }

  // Edges as index pairs (self-loops and dangling endpoints dropped).
  const ea: number[] = [];
  const eb: number[] = [];
  const ew: number[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    ea.push(a);
    eb.push(b);
    ew.push(Math.min(Math.max(e.weight, 0), 4));
  }
  const edgeCount = ea.length;

  // Initial scatter: uniform in a ball whose radius grows with community size.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = community[i] ?? 0;
    const ballRadius = Math.sqrt((sizes[c] ?? 1) / Math.max(largest, 1)) * coreRadius * 0.35;
    const u = rng();
    const dz = 2 * rng() - 1;
    const phi = TAU * rng();
    const rxy = Math.sqrt(Math.max(0, 1 - dz * dz));
    const r = ballRadius * Math.cbrt(u);
    px[i] = cx[i]! + r * rxy * Math.cos(phi);
    py[i] = cy[i]! + r * rxy * Math.sin(phi);
    pz[i] = cz[i]! + r * dz;
  }

  // Relaxation (Jacobi-style: accumulate per step, then apply).
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sz = new Float64Array(n);
  const sw = new Float64Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    sx.fill(0); sy.fill(0); sz.fill(0); sw.fill(0);
    for (let e = 0; e < edgeCount; e++) {
      const a = ea[e]!;
      const b = eb[e]!;
      const w = ew[e]!;
      // Weighted pull of each endpoint toward the other.
      sx[a]! += w * (px[b]! - px[a]!); sy[a]! += w * (py[b]! - py[a]!); sz[a]! += w * (pz[b]! - pz[a]!);
      sx[b]! += w * (px[a]! - px[b]!); sy[b]! += w * (py[a]! - py[b]!); sz[b]! += w * (pz[a]! - pz[b]!);
      sw[a]! += w; sw[b]! += w;
    }
    for (let i = 0; i < n; i++) {
      if (sw[i]! > 0) {
        // Normalise by total edge weight so hubs do not overshoot.
        px[i]! += (0.15 * sx[i]!) / sw[i]!;
        py[i]! += (0.15 * sy[i]!) / sw[i]!;
        pz[i]! += (0.15 * sz[i]!) / sw[i]!;
      }
      px[i]! += 0.02 * (cx[i]! - px[i]!);
      py[i]! += 0.02 * (cy[i]! - py[i]!);
      pz[i]! += 0.02 * (cz[i]! - pz[i]!);
      const d = Math.sqrt(px[i]! * px[i]! + py[i]! * py[i]! + pz[i]! * pz[i]!);
      if (d > coreRadius) {
        const s = coreRadius / d;
        px[i]! *= s; py[i]! *= s; pz[i]! *= s;
      }
    }
  }

  let radius = 0;
  const core = new Map<string, Vec3>();
  for (let i = 0; i < n; i++) {
    const p = { x: px[i]!, y: py[i]!, z: pz[i]! };
    core.set(ids[i]!, p);
    radius = Math.max(radius, norm(p));
  }

  // ---- Ring: evenly spaced in the XZ plane, newest at angle 0.
  const ring = new Map<string, Vec3>();
  const ringItems = graph.ring;
  const m = ringItems.length;
  for (let i = 0; i < m; i++) {
    const item = ringItems[i]!;
    const angle = (TAU * i) / m;
    const p = { x: ringRadius * Math.cos(angle), y: 0, z: ringRadius * Math.sin(angle) };
    if (!ring.has(item.id)) ring.set(item.id, p);
    radius = Math.max(radius, norm(p));
  }

  return { core, ring, communityCenters, bounds: { radius } };
}
