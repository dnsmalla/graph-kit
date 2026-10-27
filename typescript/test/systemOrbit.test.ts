import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32,
  fibonacciSphere,
  orbitLayout,
  type SystemGraph,
  type SystemCoreNode,
  type SystemCoreEdge,
  type SystemRingItem,
  type Vec3,
} from "../src/system/index.js";

const dist = (p: Vec3, q: Vec3 = { x: 0, y: 0, z: 0 }): number =>
  Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

function makeGraph(
  core: SystemCoreNode[],
  edges: SystemCoreEdge[] = [],
  ring: SystemRingItem[] = [],
): SystemGraph {
  const communities = new Set(core.map((n) => n.community)).size;
  return {
    core,
    edges,
    ring,
    truncated: { totalNodes: core.length, keptNodes: core.length, keptCommunities: communities },
  };
}

const coreNode = (id: string, community: number): SystemCoreNode => ({
  id,
  label: id,
  category: "code",
  community,
  degree: 0,
});

const ringItem = (id: string): SystemRingItem => ({
  id,
  label: id,
  kind: "note",
  at: "2026-10-27T00:00:00Z",
  link: null,
});

/** Two well-separated communities of `size` nodes, each a ring plus seeded chords. */
function twoCommunities(size: number): SystemGraph {
  const rng = mulberry32(42);
  const core: SystemCoreNode[] = [];
  const edges: SystemCoreEdge[] = [];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < size; i++) core.push(coreNode(`c${c}:${String(i).padStart(3, "0")}`, c));
    for (let i = 0; i < size; i++) {
      edges.push({ source: `c${c}:${String(i).padStart(3, "0")}`, target: `c${c}:${String((i + 1) % size).padStart(3, "0")}`, weight: 1 });
    }
    for (let i = 0; i < size * 2; i++) {
      const a = Math.floor(rng() * size);
      const b = Math.floor(rng() * size);
      if (a === b) continue;
      edges.push({ source: `c${c}:${String(a).padStart(3, "0")}`, target: `c${c}:${String(b).padStart(3, "0")}`, weight: 1 });
    }
  }
  return makeGraph(core, edges);
}

test("mulberry32: same seed gives the same sequence, different seed differs, values in [0,1)", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  assert.deepEqual(seqA, seqB);
  const c = mulberry32(8);
  const seqC = Array.from({ length: 50 }, () => c());
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("fibonacciSphere: n points all on the sphere; n=0 and n=1 handled", () => {
  assert.deepEqual(fibonacciSphere(0, 10), []);
  const one = fibonacciSphere(1, 10);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(dist(one[0]!) - 10) < 1e-9);
  const pts = fibonacciSphere(50, 37);
  assert.equal(pts.length, 50);
  for (const p of pts) {
    assert.ok(Math.abs(dist(p) - 37) < 1e-9, `distance ${dist(p)}`);
  }
});

test("orbitLayout: identical coordinates across runs", () => {
  const g = twoCommunities(40);
  const first = orbitLayout(g, { seed: 3 });
  const second = orbitLayout(g, { seed: 3 });
  assert.deepEqual([...first.core.entries()], [...second.core.entries()]);
  assert.deepEqual(first.communityCenters, second.communityCenters);
  assert.equal(first.bounds.radius, second.bounds.radius);
});

test("orbitLayout: every core point lies within coreRadius", () => {
  const g = twoCommunities(60);
  const layout = orbitLayout(g, { coreRadius: 100 });
  assert.equal(layout.core.size, g.core.length);
  for (const p of layout.core.values()) {
    assert.ok(dist(p) <= 100 + 1e-9, `outside core: ${dist(p)}`);
  }
});

test("orbitLayout: ring sits flat at ringRadius in angle order, newest at angle 0", () => {
  const ring = ["r0", "r1", "r2", "r3"].map(ringItem);
  const layout = orbitLayout(makeGraph([], [], ring), { ringRadius: 170 });
  assert.equal(layout.ring.size, 4);
  for (const p of layout.ring.values()) {
    assert.equal(p.y, 0);
    assert.ok(Math.abs(dist(p) - 170) < 1e-9);
  }
  const r0 = layout.ring.get("r0")!;
  assert.ok(Math.abs(r0.x - 170) < 1e-9 && Math.abs(r0.z) < 1e-9);
  const r1 = layout.ring.get("r1")!;
  assert.ok(Math.abs(r1.x) < 1e-9 && Math.abs(r1.z - 170) < 1e-9);
  const r2 = layout.ring.get("r2")!;
  assert.ok(Math.abs(r2.x + 170) < 1e-9 && Math.abs(r2.z) < 1e-9);
  assert.equal(layout.bounds.radius >= 170 - 1e-9, true);
});

test("orbitLayout: empty graph gives empty maps, radius 0, no NaN", () => {
  const layout = orbitLayout(makeGraph([]));
  assert.equal(layout.core.size, 0);
  assert.equal(layout.ring.size, 0);
  assert.deepEqual(layout.communityCenters, []);
  assert.equal(layout.bounds.radius, 0);
});

test("orbitLayout: single community sits at the origin center; dangling edges ignored", () => {
  const core = [coreNode("a", 0), coreNode("b", 0)];
  const edges: SystemCoreEdge[] = [
    { source: "a", target: "b", weight: 9 },
    { source: "a", target: "ghost", weight: 1 },
    { source: "a", target: "a", weight: 1 },
  ];
  const layout = orbitLayout(makeGraph(core, edges));
  assert.deepEqual(layout.communityCenters, [{ x: 0, y: 0, z: 0 }]);
  for (const p of layout.core.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
});

test("orbitLayout: nodes sit closer to their own community center than to the other", () => {
  const g = twoCommunities(40);
  const layout = orbitLayout(g);
  const [c0, c1] = layout.communityCenters as [Vec3, Vec3];
  assert.equal(layout.communityCenters.length, 2);
  let own = 0;
  let other = 0;
  let count = 0;
  for (const node of g.core) {
    const p = layout.core.get(node.id)!;
    const mine = node.community === 0 ? c0 : c1;
    const theirs = node.community === 0 ? c1 : c0;
    own += dist(p, mine);
    other += dist(p, theirs);
    count++;
  }
  assert.ok(own / count < other / count, `own ${own / count} vs other ${other / count}`);
});

/** Five communities (400/300/200/150/100), ~deg 3 ring+chords, 5% cross edges. */
function fiveCommunities(): SystemGraph {
  const sizes = [400, 300, 200, 150, 100];
  const rng = mulberry32(7);
  const core: SystemCoreNode[] = [];
  const edges: SystemCoreEdge[] = [];
  sizes.forEach((s, c) => {
    for (let i = 0; i < s; i++) core.push(coreNode(`c${c}:${i}`, c));
    for (let i = 0; i < s; i++) edges.push({ source: `c${c}:${i}`, target: `c${c}:${(i + 1) % s}`, weight: 1 });
    for (let i = 0; i < s / 2; i++) {
      const a = Math.floor(rng() * s);
      const b = Math.floor(rng() * s);
      if (a !== b) edges.push({ source: `c${c}:${a}`, target: `c${c}:${b}`, weight: 1 });
    }
  });
  const communityOf = new Map(core.map((n) => [n.id, n.community]));
  const cross = Math.round((edges.length * 0.05) / 0.95);
  for (let i = 0; i < cross; i++) {
    const a = core[Math.floor(rng() * core.length)]!;
    const b = core[Math.floor(rng() * core.length)]!;
    if (communityOf.get(a.id) !== communityOf.get(b.id)) edges.push({ source: a.id, target: b.id, weight: 1 });
  }
  return makeGraph(core, edges);
}

test("orbitLayout: clusters keep volume (mean spread >= 10 for communities >= 100 nodes)", () => {
  const g = fiveCommunities();
  const layout = orbitLayout(g, { coreRadius: 100 });
  const byComm = new Map<number, Vec3[]>();
  for (const node of g.core) {
    const list = byComm.get(node.community) ?? [];
    list.push(layout.core.get(node.id)!);
    byComm.set(node.community, list);
  }
  for (const [c, pts] of byComm) {
    if (pts.length < 100) continue;
    const centroid = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
    };
    const spread = pts.reduce((s, p) => s + dist(p, centroid), 0) / pts.length;
    assert.ok(spread >= 10, `community ${c} spread ${spread}`);
  }
});

test("orbitLayout: mean inter-community distance >= 3x mean intra-community distance", () => {
  const g = fiveCommunities();
  const layout = orbitLayout(g, { coreRadius: 100 });
  const pos = g.core.map((n) => layout.core.get(n.id)!);
  let intra = 0;
  let intraCount = 0;
  let inter = 0;
  let interCount = 0;
  for (let i = 0; i < g.core.length; i++) {
    for (let j = i + 1; j < g.core.length; j++) {
      const d = dist(pos[i]!, pos[j]!);
      if (g.core[i]!.community === g.core[j]!.community) {
        intra += d;
        intraCount++;
      } else {
        inter += d;
        interCount++;
      }
    }
  }
  const meanIntra = intra / intraCount;
  const meanInter = inter / interCount;
  assert.ok(meanInter >= 3 * meanIntra, `inter ${meanInter} vs intra ${meanIntra}`);
});

test("orbitLayout: core reaches at least 70% of coreRadius from the origin", () => {
  const layout = orbitLayout(fiveCommunities(), { coreRadius: 100 });
  assert.ok(layout.bounds.radius >= 0.7 * 100, `radius ${layout.bounds.radius}`);
});

test("orbitLayout: a sparse community id (1e9) lays out without throwing and fast", () => {
  const core = [coreNode("a", 0), coreNode("b", 1_000_000_000), coreNode("c", 1_000_000_000)];
  const edges: SystemCoreEdge[] = [{ source: "b", target: "c", weight: 1 }];
  const start = performance.now();
  const layout = orbitLayout(makeGraph(core, edges));
  const ms = performance.now() - start;
  assert.equal(layout.core.size, 3);
  assert.equal(layout.communityCenters.length, 2);
  assert.ok(ms < 2000, `took ${ms} ms`);
  for (const p of layout.core.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
});

test("orbitLayout: non-finite edge weights are treated as 0 (finite output)", () => {
  const core = [coreNode("a", 0), coreNode("b", 0)];
  const edges: SystemCoreEdge[] = [
    { source: "a", target: "b", weight: Number.NaN },
    { source: "a", target: "b", weight: Number.POSITIVE_INFINITY },
  ];
  const layout = orbitLayout(makeGraph(core, edges));
  for (const p of layout.core.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
});

test("orbitLayout: duplicate ring ids leave no gap (unique items evenly spaced)", () => {
  const ring = ["a", "b", "a", "c"].map(ringItem);
  const layout = orbitLayout(makeGraph([], [], ring), { ringRadius: 170 });
  assert.equal(layout.ring.size, 3);
  const a = layout.ring.get("a")!;
  const b = layout.ring.get("b")!;
  const c = layout.ring.get("c")!;
  const step = (2 * Math.PI) / 3;
  assert.ok(Math.abs(a.x - 170) < 1e-9 && Math.abs(a.z) < 1e-9);
  assert.ok(Math.abs(b.x - 170 * Math.cos(step)) < 1e-9 && Math.abs(b.z - 170 * Math.sin(step)) < 1e-9);
  assert.ok(Math.abs(c.x - 170 * Math.cos(2 * step)) < 1e-9 && Math.abs(c.z - 170 * Math.sin(2 * step)) < 1e-9);
});

test("orbitLayout: 20k nodes / 60k edges runs under 2 s", () => {
  const rng = mulberry32(99);
  const nodes = 20_000;
  const core: SystemCoreNode[] = [];
  for (let i = 0; i < nodes; i++) {
    core.push(coreNode(`n${String(i).padStart(5, "0")}`, Math.floor(rng() * 12)));
  }
  const edges: SystemCoreEdge[] = [];
  for (let i = 0; i < 60_000; i++) {
    const a = Math.floor(rng() * nodes);
    const b = Math.floor(rng() * nodes);
    edges.push({ source: core[a]!.id, target: core[b]!.id, weight: 1 + Math.floor(rng() * 3) });
  }
  const g = makeGraph(core, edges);
  const start = performance.now();
  const layout = orbitLayout(g);
  const ms = performance.now() - start;
  console.log(`orbitLayout 20k/60k: ${ms.toFixed(0)} ms`);
  assert.equal(layout.core.size, nodes);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
