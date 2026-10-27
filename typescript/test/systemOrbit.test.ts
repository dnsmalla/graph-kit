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
