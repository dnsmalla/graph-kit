import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  detectCommunities,
  buildSystemGraph,
  type SystemCoreNode,
} from "../src/system/index.js";
import type { CGData, CGNode, CGEdge } from "../src/models.js";
import { osSnapshotFixture } from "./fixtures/osSnapshot.js";

const node = (id: string, kind: CGNode["kind"] = "file", metadata: Record<string, string> = {}): CGNode => ({
  id,
  title: id.split("/").pop() ?? id,
  kind,
  metadata,
});
const edge = (fromId: string, toId: string): CGEdge => ({ fromId, toId, kind: "imports", confidence: "EXTRACTED" });
const graph = (nodes: CGNode[], edges: CGEdge[] = []): CGData => ({ nodes, edges, layers: [], tour: [] });

test("categorize: tests, docs, knowledge, code, other", () => {
  assert.equal(categorize(node("src/app/foo.test.ts")), "tests");
  assert.equal(categorize(node("tests/x.ts")), "tests");
  assert.equal(categorize(node("__tests__/x.ts")), "tests");
  assert.equal(categorize(node("spec/x.rb")), "tests");
  assert.equal(categorize(node("src/latest.ts")), "code");
  assert.equal(categorize(node("docs/readme.md", "docPage")), "docs");
  assert.equal(categorize(node("notes/intro.mdx")), "docs");
  assert.equal(categorize(node("a/b.txt", "file")), "docs");
  assert.equal(categorize(node("n:1", "noteDecision")), "knowledge");
  assert.equal(categorize(node("c:1", "claim")), "knowledge");
  assert.equal(categorize(node("src/a.ts", "function")), "code");
  assert.equal(categorize(node("src/a.ts", "file", { source_file: "tests/a.ts" })), "tests");
  assert.equal(categorize(node("misc", "other")), "other");
});

test("detectCommunities: two disconnected triangles give two communities, bigger first", () => {
  const ids = ["a1", "a2", "a3", "b1", "b2", "b3", "b4"];
  const edges = [
    { source: "a1", target: "a2" }, { source: "a2", target: "a3" }, { source: "a1", target: "a3" },
    { source: "b1", target: "b2" }, { source: "b2", target: "b3" }, { source: "b1", target: "b3" },
    { source: "b3", target: "b4" },
  ];
  const c = detectCommunities(ids, edges);
  assert.equal(c.get("b1"), 0);
  assert.equal(c.get("b4"), 0);
  assert.equal(c.get("a1"), 1);
  assert.equal(c.get("a2"), 1);
  assert.equal(new Set(c.values()).size, 2);
});

test("detectCommunities: isolated nodes get their own community; result is deterministic", () => {
  const ids = ["x", "y", "z", "lone", "p", "q", "r", "s"];
  const edges = [
    { source: "x", target: "y" }, { source: "y", target: "z" }, { source: "x", target: "z" },
    { source: "p", target: "q" }, { source: "q", target: "r" }, { source: "r", target: "s" },
    { source: "p", target: "s" }, { source: "q", target: "s" },
  ];
  const first = [...detectCommunities(ids, edges).entries()];
  const second = [...detectCommunities([...ids].reverse(), [...edges].reverse()).entries()];
  assert.deepEqual(first, second);
  const map = new Map(first);
  assert.notEqual(map.get("lone"), map.get("x"));
  assert.notEqual(map.get("lone"), map.get("p"));
  assert.equal(map.get("lone"), 2); // size-1 group sorts last
});

test("buildSystemGraph: null inputs give an empty graph", () => {
  const g = buildSystemGraph(null, null);
  assert.deepEqual(g.core, []);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.ring, []);
  assert.deepEqual(g.truncated, { totalNodes: 0, keptNodes: 0, keptCommunities: 0 });
});

test("buildSystemGraph: duplicate edges collapse to weight 2, reversed direction counts too", () => {
  const g = buildSystemGraph(null, graph(
    [node("a"), node("b")],
    [edge("a", "b"), edge("b", "a")],
  ));
  assert.deepEqual(g.edges, [{ source: "a", target: "b", weight: 2 }]);
  const a = g.core.find((n) => n.id === "a")!;
  assert.equal(a.degree, 2);
});

test("buildSystemGraph: self-loops and dangling edges are dropped", () => {
  const g = buildSystemGraph(null, graph(
    [node("a"), node("b")],
    [edge("a", "a"), edge("a", "missing"), edge("a", "b")],
  ));
  assert.deepEqual(g.edges, [{ source: "a", target: "b", weight: 1 }]);
});

test("buildSystemGraph: core is sorted by id, edges sorted, categories and labels set", () => {
  const g = buildSystemGraph(null, graph(
    [node("z.ts"), node("a.test.ts"), node("m.md", "docPage")],
    [edge("z.ts", "m.md"), edge("a.test.ts", "z.ts")],
  ));
  assert.deepEqual(g.core.map((n) => n.id), ["a.test.ts", "m.md", "z.ts"]);
  assert.deepEqual(g.core.map((n) => n.category), ["tests", "docs", "code"]);
  assert.deepEqual(g.edges.map((e) => [e.source, e.target]), [["a.test.ts", "z.ts"], ["m.md", "z.ts"]]);
});

test("buildSystemGraph: capping keeps the largest communities and every edge between kept nodes", () => {
  // Big community: 5-clique. Small: a 2-node pair. Lone node: singleton.
  const big = ["c1", "c2", "c3", "c4", "c5"];
  const small = ["s1", "s2"];
  const nodes = [...big, ...small, "lone"].map((id) => node(id));
  const edges: CGEdge[] = [];
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++) edges.push(edge(big[i]!, big[j]!));
  edges.push(edge("s1", "s2"));

  const full = buildSystemGraph(null, graph(nodes, edges));
  assert.equal(full.truncated.totalNodes, 8);

  const capped = buildSystemGraph(null, graph(nodes, edges), { maxCoreNodes: 5 });
  assert.equal(capped.truncated.totalNodes, 8);
  assert.equal(capped.truncated.keptNodes, 5);
  assert.equal(capped.truncated.keptCommunities, 1);
  const keptIds = new Set(capped.core.map((n) => n.id));
  assert.deepEqual([...keptIds].sort(), [...big].sort());
  // every edge between kept nodes survives
  const expected = edges.filter((e) => keptIds.has(e.fromId) && keptIds.has(e.toId)).length;
  assert.equal(capped.edges.reduce((s, e) => s + e.weight, 0), expected);
  assert.equal(expected, 10);

  // 5-clique (5) + pair (2) fit in 7; the singleton does not.
  const cap7 = buildSystemGraph(null, graph(nodes, edges), { maxCoreNodes: 7 });
  assert.equal(cap7.truncated.keptNodes, 7);
  assert.equal(cap7.truncated.keptCommunities, 2);
  assert.equal(cap7.edges.reduce((s, e) => s + e.weight, 0), 11);
  const cap8 = buildSystemGraph(null, graph(nodes, edges), { maxCoreNodes: 8 });
  assert.equal(cap8.truncated.keptNodes, 8);
  assert.equal(cap8.truncated.keptCommunities, 3);
});

test("buildSystemGraph: oversized largest community is trimmed by highest degree", () => {
  const ids = ["hub", "a", "b", "c", "d"];
  const nodes = ids.map((id) => node(id));
  const edges = ["a", "b", "c", "d"].map((id) => edge("hub", id));
  const g = buildSystemGraph(null, graph(nodes, edges), { maxCoreNodes: 2 });
  assert.equal(g.truncated.keptNodes, 2);
  assert.ok(g.core.some((n: SystemCoreNode) => n.id === "hub"));
  assert.equal(g.edges.length, 1);
});

test("buildSystemGraph: ring respects maxRingItems and keeps snapshot order", () => {
  const snap = osSnapshotFixture();
  const all = buildSystemGraph(snap, null);
  assert.deepEqual(all.ring.map((r) => r.id), ["activity:3", "activity:2", "activity:1"]);
  assert.deepEqual(all.ring.map((r) => r.label), ["Third", "Second", "First"]);
  assert.equal(all.ring[1]?.link, "/x");
  assert.equal(all.ring[0]?.at, "2026-10-27 09:03:00");

  const two = buildSystemGraph(snap, null, { maxRingItems: 2 });
  assert.deepEqual(two.ring.map((r) => r.id), ["activity:3", "activity:2"]);

  const none = buildSystemGraph(snap, null, { maxRingItems: 0 });
  assert.deepEqual(none.ring, []);
});

test("OsSnapshot fixture is a typed literal and builds deterministically", () => {
  const snap = osSnapshotFixture();
  const project = graph([node("a.ts"), node("b.ts")], [edge("a.ts", "b.ts")]);
  assert.deepEqual(buildSystemGraph(snap, project), buildSystemGraph(snap, project));
});
