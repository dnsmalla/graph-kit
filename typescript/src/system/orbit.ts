// Deterministic 3D "orbit" layout for the Agentic-OS visual: a dense spherical
// point cloud (the core, grouped by community) with a flat ring of recent
// activity orbiting it. Pure and seeded; no I/O, no dependencies. Relaxation is
// O(E + N) per step (no all-pairs repulsion), so it stays cheap at ~20k nodes.

import type { OrbitLayout, OrbitOptions, SystemGraph, Vec3 } from "./types.js";


const TAU = Math.PI * 2;
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** Per-step pull of each node toward its weighted neighbour mean. Kept small so edges only bias neighbours locally. */
const EDGE_PULL = 0.02;
/** Per-step spring pulling each node back toward its initial scattered position. */
const ANCHOR_PULL = 0.05;
/** Max per-step expansion factor applied to a community whose RMS radius is below its target. */
const MAX_VOLUME_GAIN = 1.2;

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
 * Lay out a SystemGraph in 3D. Core nodes start scattered in a ball around their
 * community center (ball radius grows with community size). Each relaxation step:
 * edges pull endpoints gently toward their weighted neighbour mean (weight capped
 * at 4), every node is spring-anchored to its initial scattered position so the
 * clusters keep their volume, a community whose RMS radius falls below its target
 * ball radius is expanded back toward that target, and anything outside the core
 * sphere is projected back onto its surface. Ring items sit evenly on a circle in
 * the XZ plane; item 0 (newest) is at angle 0 and the rest follow at 2π/n over the
 * unique ids. Output is deterministic for a given graph and options.
 */
export function orbitLayout(graph: SystemGraph, opts: OrbitOptions = {}): OrbitLayout {
  const coreRadius = positive(opts.coreRadius, 100);
  const ringRadius = positive(opts.ringRadius, 170);
  const iterations = nonNegInt(opts.iterations, 60);
  const rng = mulberry32(opts.seed ?? 1);

  // ---- Core: index nodes (first occurrence wins on duplicate ids).
  const index = new Map<string, number>();
  const ids: string[] = [];
  const rawCommunity: number[] = [];
  for (const node of graph.core) {
    if (index.has(node.id)) continue;
    index.set(node.id, ids.length);
    ids.push(node.id);
    rawCommunity.push(nonNegInt(node.community, 0));
  }
  const n = ids.length;

  // Compact community ids: distinct values present, ascending -> 0..k-1.
  const distinct = Array.from(new Set(rawCommunity)).sort((a, b) => a - b);
  const compact = new Map<number, number>();
  distinct.forEach((v, i) => compact.set(v, i));
  const k = distinct.length;
  const community = rawCommunity.map((v) => compact.get(v)!);

  const sizes = new Array<number>(k).fill(0);
  for (const c of community) sizes[c] = (sizes[c] ?? 0) + 1;
  const largest = sizes.reduce((m, s) => Math.max(m, s), 0);

  // Community centers: a single community sits at the origin.
  const communityCenters: Vec3[] =
    k === 1 ? [ORIGIN] : fibonacciSphere(k, coreRadius * 0.7);
  // 0.7 (not 0.55): with the uniform-ball scatter, 0.55 left mean inter-community
  // distance only ~2.7x the mean intra distance; 0.7 keeps clusters clearly apart.
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const center = communityCenters[community[i] ?? 0] ?? ORIGIN;
    cx[i] = center.x;
    cy[i] = center.y;
    cz[i] = center.z;
  }

  // Edges as index pairs (self-loops, dangling endpoints and non-finite or
  // non-positive weights are dropped; a non-finite weight counts as 0).
  const ea: number[] = [];
  const eb: number[] = [];
  const ew: number[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const w = Number.isFinite(e.weight) ? Math.min(Math.max(e.weight, 0), 4) : 0;
    if (w <= 0) continue;
    ea.push(a);
    eb.push(b);
    ew.push(w);
  }
  const edgeCount = ea.length;

  // Initial scatter: uniform in a ball whose radius grows with community size.
  const ballRadius = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    ballRadius[c] = Math.sqrt((sizes[c] ?? 1) / Math.max(largest, 1)) * coreRadius * 0.35;
  }
  // RMS radius of a uniform ball of radius R is R * sqrt(3/5): that is the volume target.
  const targetRms = new Float64Array(k);
  for (let c = 0; c < k; c++) targetRms[c] = ballRadius[c]! * Math.sqrt(3 / 5);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r0 = ballRadius[community[i] ?? 0] ?? 0;
    const u = rng();
    const dz = 2 * rng() - 1;
    const phi = TAU * rng();
    const rxy = Math.sqrt(Math.max(0, 1 - dz * dz));
    const r = r0 * Math.cbrt(u);
    px[i] = cx[i]! + r * rxy * Math.cos(phi);
    py[i] = cy[i]! + r * rxy * Math.sin(phi);
    pz[i] = cz[i]! + r * dz;
  }
  // Anchor positions: the scatter, held by a spring each step.
  const ax = Float64Array.from(px);
  const ay = Float64Array.from(py);
  const az = Float64Array.from(pz);

  // Relaxation (Jacobi-style: accumulate per step, then apply).
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sz = new Float64Array(n);
  const sw = new Float64Array(n);
  // Per-community scratch: mean position and RMS radius, reused every step.
  const mx = new Float64Array(k);
  const my = new Float64Array(k);
  const mz = new Float64Array(k);
  const rms = new Float64Array(k);
  const gain = new Float64Array(k);
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
        px[i]! += (EDGE_PULL * sx[i]!) / sw[i]!;
        py[i]! += (EDGE_PULL * sy[i]!) / sw[i]!;
        pz[i]! += (EDGE_PULL * sz[i]!) / sw[i]!;
      }
      px[i]! += ANCHOR_PULL * (ax[i]! - px[i]!);
      py[i]! += ANCHOR_PULL * (ay[i]! - py[i]!);
      pz[i]! += ANCHOR_PULL * (az[i]! - pz[i]!);
    }

    // Volume term: a community whose RMS radius is below its target ball radius
    // has its offsets from the centroid scaled back out (centroid is preserved).
    if (k > 0) {
      mx.fill(0); my.fill(0); mz.fill(0); rms.fill(0);
      for (let i = 0; i < n; i++) {
        const c = community[i]!;
        mx[c]! += px[i]!; my[c]! += py[i]!; mz[c]! += pz[i]!;
      }
      for (let c = 0; c < k; c++) {
        const s = sizes[c]!;
        if (s > 0) { mx[c]! /= s; my[c]! /= s; mz[c]! /= s; }
      }
      for (let i = 0; i < n; i++) {
        const c = community[i]!;
        const dx = px[i]! - mx[c]!;
        const dy = py[i]! - my[c]!;
        const dz = pz[i]! - mz[c]!;
        rms[c]! += dx * dx + dy * dy + dz * dz;
      }
      for (let c = 0; c < k; c++) {
        const s = sizes[c]!;
        const r = s > 0 ? Math.sqrt(rms[c]! / s) : 0;
        gain[c] = r > 0 && r < targetRms[c]! ? Math.min(targetRms[c]! / r, MAX_VOLUME_GAIN) : 1;
      }
      for (let i = 0; i < n; i++) {
        const c = community[i]!;
        const g = gain[c]!;
        if (g !== 1) {
          px[i] = mx[c]! + (px[i]! - mx[c]!) * g;
          py[i] = my[c]! + (py[i]! - my[c]!) * g;
          pz[i] = mz[c]! + (pz[i]! - mz[c]!) * g;
        }
      }
    }

    // Keep every node inside the core sphere.
    for (let i = 0; i < n; i++) {
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

  // ---- Ring: unique ids evenly spaced in the XZ plane, newest at angle 0.
  const ring = new Map<string, Vec3>();
  const uniqueRing: string[] = [];
  const seenRing = new Set<string>();
  for (const item of graph.ring) {
    if (seenRing.has(item.id)) continue;
    seenRing.add(item.id);
    uniqueRing.push(item.id);
  }
  const m = uniqueRing.length;
  for (let i = 0; i < m; i++) {
    const angle = (TAU * i) / m;
    const p = { x: ringRadius * Math.cos(angle), y: 0, z: ringRadius * Math.sin(angle) };
    ring.set(uniqueRing[i]!, p);
    radius = Math.max(radius, norm(p));
  }

  return { core, ring, communityCenters, bounds: { radius } };
}
