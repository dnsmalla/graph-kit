#!/usr/bin/env node
// Generates the parity golden cases for the Rust port of the OS graph core
// (rust/os-graph). The oracle is the BUILT TypeScript in dist/src/system/:
// run `npx tsc -p tsconfig.json` first (see rust/README.md).
//
// Each golden file is { input, systemGraph, orbit } where
//   input       = { snapshot, project, buildOptions, orbitOptions }
//   systemGraph = buildSystemGraph(snapshot, project, buildOptions)
//   orbit       = orbitLayout(systemGraph, orbitOptions), with the Maps
//                 serialized as arrays of [id, {x, y, z}] in insertion order.
// A case with `rawSystemGraph` in its input skips the builder: the raw object (possibly
// with odd numbers and missing fields) goes straight to orbitLayout, and Rust reads it
// through the lenient orbit JSON boundary (api::orbit_layout_json).
//
// Cases are written with JSON-serializable values only (undefined keys are simply left
// out, as JSON.stringify would drop them), so the Rust side sees exactly what the TS saw.
//
// Usage: node typescript/scripts/gen-os-golden.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemGraph, orbitLayout } from "../dist/src/system/index.js";
import { osSnapshotFixture } from "../dist/test/fixtures/osSnapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../rust/os-graph/tests/golden");

// Independent seeded PRNG for the synthetic graph (mulberry32, written inline).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const node = (id, kind = "file", metadata = {}, title = undefined) => ({
  id,
  title: title ?? (id.split("/").pop() ?? id),
  kind,
  metadata,
});
const edge = (fromId, toId, kind = "imports") => ({ fromId, toId, kind, confidence: "EXTRACTED" });
const project = (nodes, edges = []) => ({ nodes, edges, layers: [], tour: [] });

// ---- case 2: every category, duplicate edges, self-loop, dangling, duplicate id.
const categoriesProject = project(
  [
    node("src/core/engine.ts", "function", { source_file: "src/core/engine.ts" }),
    node("src/core/util.ts"),
    node("src/ui/view.ts", "symbol", { path: "src/ui/view.ts" }),
    node("tests/engine.test.ts"),
    node("src/x.spec.ts", "file", { source_path: "tests/x.ts" }),
    node("docs/guide.md", "docPage"),
    node("docs/spec/arch.md"),
    node("notes/n1", "noteDecision", {}, "unit-test plan"),
    node("claim:1", "claim"),
    node("skills/s", "skill"),
    node("misc", "other"),
    node("src/plan.ts", "function", {}, "unit-test plan"),
    node("src/core/util.ts", "function", {}, "Duplicate title (dropped)"),
    node("cfg/app.yaml", "config", { file: "src/app.yaml" }),
    node("src/app/latest.ts"),
    node("lib/__tests__/a.ts", "function"),
    node("docs/readme.txt"),
    node("api/handler.ts", "endpoint", { path: "api/handler.ts", file: "" }),
    node("Tests/Helper.ts"),
  ],
  [
    edge("src/core/engine.ts", "src/core/util.ts"),
    edge("src/core/util.ts", "src/core/engine.ts"),
    edge("src/core/engine.ts", "src/core/util.ts", "calls"),
    edge("src/ui/view.ts", "src/core/engine.ts"),
    edge("tests/engine.test.ts", "src/core/engine.ts"),
    edge("src/x.spec.ts", "src/ui/view.ts"),
    edge("docs/guide.md", "src/core/engine.ts", "documents"),
    edge("docs/spec/arch.md", "docs/guide.md"),
    edge("notes/n1", "claim:1", "cites"),
    edge("claim:1", "docs/guide.md"),
    edge("skills/s", "misc"),
    edge("src/plan.ts", "src/app/latest.ts"),
    edge("src/app/latest.ts", "src/plan.ts"),
    edge("lib/__tests__/a.ts", "src/app/latest.ts"),
    edge("api/handler.ts", "api/handler.ts"),
    edge("api/handler.ts", "ghost.ts"),
    edge("ghost2", "api/handler.ts"),
    edge("cfg/app.yaml", "src/core/util.ts"),
    edge("Tests/Helper.ts", "src/ui/view.ts"),
    edge("docs/readme.txt", "misc"),
    edge("src/core/util.ts", "src/ui/view.ts"),
  ],
);

// ---- case 3: greedy fill skips the 5-clique+pair overflow and keeps the lone node.
const cliqueIds = ["c1", "c2", "c3", "c4", "c5"];
const greedyEdges = [];
for (let i = 0; i < cliqueIds.length; i++)
  for (let j = i + 1; j < cliqueIds.length; j++) greedyEdges.push(edge(cliqueIds[i], cliqueIds[j]));
greedyEdges.push(edge("s1", "s2"));
const greedyProject = project([...cliqueIds, "s1", "s2", "lone"].map((id) => node(id)), greedyEdges);

// ---- partial trim: the largest community alone exceeds the cap.
const hubProject = project(
  ["hub", "a", "b", "c", "d"].map((id) => node(id)),
  ["a", "b", "c", "d"].map((id) => edge("hub", id)),
);

// ---- synthetic 2000-node graph, seeded, cap 500, with a 30-item ring.
function syntheticCase() {
  const rng = seeded(20261027);
  const nodes = [];
  const edges = [];
  const sizes = [];
  let total = 0;
  while (total < 2000) {
    const s = Math.min(20 + Math.floor(rng() * 281), 2000 - total);
    sizes.push(s);
    total += s;
  }
  const communities = sizes.map((size, c) => {
    const members = [];
    for (let i = 0; i < size; i++) {
      const r = rng();
      let n;
      if (r < 0.6) n = node(`src/c${c}/f${i}.ts`, rng() < 0.5 ? "function" : "file", { source_file: `src/c${c}/f${i}.ts` });
      else if (r < 0.7) n = node(`tests/c${c}/t${i}.test.ts`, "file");
      else if (r < 0.8) n = node(`docs/c${c}/d${i}.md`, rng() < 0.5 ? "docPage" : "file");
      else if (r < 0.9) n = node(`n:c${c}:${i}`, "noteFact", {}, `fact ${c}.${i}`);
      else n = node(`c${c}/x${i}`, "other");
      members.push(n);
    }
    for (let i = 0; i < size; i++) {
      if (size > 1) edges.push(edge(members[i].id, members[(i + 1) % size].id));
    }
    const chords = Math.floor(size * 1.5);
    for (let k = 0; k < chords; k++) {
      const a = Math.floor(rng() * size);
      const b = Math.floor(rng() * size);
      edges.push(edge(members[a].id, members[b].id, rng() < 0.5 ? "imports" : "calls"));
    }
    nodes.push(...members);
    return members;
  });
  const all = communities.flat();
  const cross = Math.floor(edges.length * 0.03);
  for (let k = 0; k < cross; k++) {
    const a = all[Math.floor(rng() * all.length)];
    const b = all[Math.floor(rng() * all.length)];
    edges.push(edge(a.id, b.id));
  }
  for (let k = 0; k < 20; k++) edges.push(edge(all[k].id, `missing:${k}`));
  for (let k = 0; k < 10; k++) edges.push(edge(all[k * 7].id, all[k * 7].id));
  // Shuffle node order (Fisher-Yates) so the builder does not depend on input order.
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }
  const snapshot = osSnapshotFixture();
  snapshot.activity.items = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i,
    kind: i % 2 ? "loop" : "chat",
    title: `Item ${i}`,
    detail: null,
    link: i % 2 ? `/l/${i}` : null,
    createdAt: `2026-10-27 10:${String(i).padStart(2, "0")}:00`,
  }));
  return {
    snapshot,
    project: project(nodes, edges),
    buildOptions: { maxCoreNodes: 500, maxRingItems: 24 },
    orbitOptions: { seed: 7 },
  };
}

// ---- serialization helpers
function finiteCheck(v, where) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`non-finite number at ${where}: ${v}`);
  return v;
}
function serializeVec(p, where) {
  return { x: finiteCheck(p.x, where), y: finiteCheck(p.y, where), z: finiteCheck(p.z, where) };
}
function serializeOrbit(o) {
  return {
    core: [...o.core.entries()].map(([id, p]) => [id, serializeVec(p, `core ${id}`)]),
    ring: [...o.ring.entries()].map(([id, p]) => [id, serializeVec(p, `ring ${id}`)]),
    communityCenters: o.communityCenters.map((p, i) => serializeVec(p, `center ${i}`)),
    bounds: { radius: finiteCheck(o.bounds.radius, "bounds") },
  };
}


// ---- model leniency: null / non-object metadata, missing title and edge fields, a
// missing fromId (dropped), a non-string metadata value and an empty path.
const leniencyProject = {
  nodes: [
    { id: "m/null.ts", kind: "file", metadata: null },
    { id: "m/array.ts", kind: "file", metadata: ["docs/x.md"] },
    { id: "t/untitled.ts", kind: "file", metadata: {} },
    { id: "t/nokind" , metadata: { path: "tests/nokind.ts" } },
    { id: "m/mixed.ts", kind: "function", metadata: { path: 5, source_file: "", file: "docs/m.md", source_path: "tests/m.ts" } },
    { id: "m/tests.ts", title: "Tests", kind: "function", metadata: { source_path: "src/m.test.ts" } },
    { id: "n/bare", title: "bare" },
    { id: "a.ts", title: "a", kind: "file", metadata: {} },
    { id: "b.ts", title: "b", kind: "file", metadata: {} },
  ],
  edges: [
    { fromId: "m/null.ts", toId: "m/array.ts" },
    { fromId: "m/null.ts", toId: "m/array.ts", kind: "imports" },
    { toId: "m/mixed.ts", kind: "imports", confidence: "EXTRACTED" },
    { fromId: "t/untitled.ts", toId: "t/nokind" },
    { fromId: "a.ts", toId: "b.ts" },
    { fromId: "b.ts", toId: "m/tests.ts", kind: "calls" },
    { fromId: "m/mixed.ts", toId: "n/bare" },
  ],
  layers: [],
  tour: [],
};

// ---- metadata path keys: precedence across keys, non-string/empty values, knowledge and
// other kinds, and the test-path separators and case rules.
const precedenceProject = project(
  [
    node("src/a.ts", "file", { source_file: "src/a.ts", source_path: "tests/a.test.ts" }),
    node("src/b.ts", "file", { source_file: "tests/b.ts", path: "docs/b.md" }),
    node("src/c.ts", "file", { file: "notes/c.TXT" }),
    node("x/d", "file", { source_file: 5, path: null, file: "", source_path: "tests/d.ts" }),
    node("x/e", "function", { source_file: "docs/e.md" }),
    node("x/f", "function", { path: ["x.md"] }),
    node("docs/g.rst", "function", { path: "" }),
    node("h.ts", "file", { source_file: "src/h.ts", path: "", file: "src/h.ts" }, "unit-test helper"),
    node("kn/1", "noteConcept", { path: "tests/k.ts" }, "unit-test concept"),
    node("kn/2", "notePlaybook", { source_file: "tests/k2.ts" }),
    node("kn/3", "noteHypothesis"),
    node("kn/4", "noteEvent"),
    node("kn/5", "noteSource"),
    node("kn/6", "article", { path: "docs/k6.md" }),
    node("kn/7", "entity"),
    node("kn/8", "topic"),
    node("dp/1", "docPage", { path: "src/dp1.ts" }),
    node("dp/2", "memoryDoc"),
    node("dp/3", "memoryChunk", { file: "tests/dp3.ts" }),
    node("sk/1", "skill"),
    node("ag/1", "agent", { path: "tests/ag1.ts" }),
    node("ot/1", "other"),
    node("ep/1", "endpoint", { path: "api/ep1.ts" }),
    node("cl/1", "class"),
    node("Src/Spec-Utils.ts", "file"),
    node("x_test_y.ts", "file"),
    node("contest.ts", "file"),
    node("testing/a.ts", "file"),
    node("my.TESTS.js", "file"),
    node("lib/__tests__/z.ts", "file"),
    node("a/SPEC", "file"),
    node("tests", "file"),
    node("src/latest.ts", "file"),
    node("src/contest-plan.md", "file"),
  ],
  [
    edge("src/a.ts", "src/b.ts"),
    edge("kn/1", "src/a.ts", "cites"),
    edge("sk/1", "ot/1"),
    edge("ep/1", "cl/1"),
    edge("Src/Spec-Utils.ts", "contest.ts"),
    edge("x_test_y.ts", "my.TESTS.js"),
    edge("tests", "a/SPEC"),
    edge("testing/a.ts", "src/latest.ts"),
  ],
);

// ---- non-BMP ids: UTF-16 code-unit order differs from code-point order here (U+1F600 sorts
// before U+FFFD and U+E000 in JS), which decides id order, community ties and cap trimming.
const nonBmpProject = project(
  [
    node("�high.ts", "file"),
    node("\u{1F600}smile.ts", "file"),
    node("private.ts", "file"),
    node("\u{10000}linear.ts", "file"),
    node("￿.ts", "file"),
    node("plain.ts", "file"),
    node("\u{1F600}pair.ts", "file"),
    node("�other.ts", "file"),
  ],
  [
    edge("�high.ts", "\u{1F600}smile.ts"),
    edge("\u{1F600}smile.ts", "private.ts"),
    edge("private.ts", "�high.ts"),
    edge("\u{10000}linear.ts", "￿.ts"),
    edge("\u{10000}linear.ts", "plain.ts"),
    edge("\u{1F600}pair.ts", "�other.ts"),
    edge("�other.ts", "\u{1F600}smile.ts"),
  ],
);

// ---- orbit with weights > 4, custom radii and a wrapping seed. Parallel edges give
// collapsed weights 2, 5 and 9; the layout clamps each to 4.
const weightedProject = project(
  [
    ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => node(`grp/a/${id}.ts`)),
    ...["b1", "b2", "b3", "b4", "b5"].map((id) => node(`grp/b/${id}.ts`)),
    ...["c1", "c2", "c3", "c4"].map((id) => node(`grp/c/${id}.ts`)),
  ],
  [
    ...[0, 1, 2, 3, 4, 5].map((i) => edge(`grp/a/a${i + 1}.ts`, `grp/a/a${((i + 1) % 6) + 1}.ts`)),
    ...[0, 1, 2, 3, 4].map((i) => edge(`grp/b/b${i + 1}.ts`, `grp/b/b${((i + 1) % 5) + 1}.ts`)),
    ...[0, 1, 2, 3].map((i) => edge(`grp/c/c${i + 1}.ts`, `grp/c/c${((i + 1) % 4) + 1}.ts`)),
    ...Array.from({ length: 8 }, () => edge("grp/a/a1.ts", "grp/a/a4.ts")), // weight 9 -> 4
    ...Array.from({ length: 4 }, () => edge("grp/b/b1.ts", "grp/b/b3.ts")), // weight 4 + 1 = 5 -> 4
    ...Array.from({ length: 1 }, () => edge("grp/c/c1.ts", "grp/c/c3.ts")),
    edge("grp/a/a2.ts", "grp/b/b2.ts"),
    edge("grp/b/b4.ts", "grp/c/c2.ts"),
  ],
);

// ---- raw orbit input: sparse, negative, fractional and missing community values, weights
// that are out of range or not numbers, a duplicate core id, duplicate ring ids.
const rawOrbitGraph = {
  core: [
    { id: "p0", community: 0, category: "code", degree: 3 },
    { id: "p1", community: 7 },
    { id: "p2", community: 1e9 },
    { id: "p3", community: 2.7 },
    { id: "p4", community: -3 },
    { id: "p5", community: null },
    { id: "p6", community: "x" },
    { id: "p7" },
    { id: "p8", community: 7 },
    { id: "p1", community: 99 },
    { id: "p9", community: 1e9 },
    { id: "p10", community: 0.999 },
  ],
  edges: [
    { source: "p0", target: "p1", weight: 9 },
    { source: "p1", target: "p2", weight: 2.5 },
    { source: "p2", target: "p3", weight: -1 },
    { source: "p3", target: "p4", weight: null },
    { source: "p4", target: "p5", weight: "2" },
    { source: "p5", target: "p6", weight: 0 },
    { source: "p6", target: "p7", weight: 1 },
    { source: "p7", target: "p8", weight: 4 },
    { source: "p8", target: "p9", weight: 3.5 },
    { source: "p9", target: "p10" },
    { source: "p10", target: "ghost", weight: 1 },
    { source: "p0", target: "p0", weight: 2 },
    { source: "p2", target: "p10", weight: 0.25 },
  ],
  ring: [
    { id: "activity:1", label: "one", kind: "chat", at: "t", link: null },
    { id: "activity:2" },
    { id: "activity:1" },
    { id: "activity:3" },
    { id: "activity:2" },
  ],
};

// ---- exact-fill boundary with six communities (cliques of 5,4,3,2,2 and a singleton).
function cliqueGroups(sizes) {
  const nodesOut = [];
  const edgesOut = [];
  sizes.forEach((size, c) => {
    const ids = Array.from({ length: size }, (_, i) => `k${c}/${i}.ts`);
    nodesOut.push(...ids.map((id) => node(id)));
    for (let i = 0; i < size; i++)
      for (let j = i + 1; j < size; j++) edgesOut.push(edge(ids[i], ids[j]));
  });
  return project(nodesOut, edgesOut);
}
const sixCliques = cliqueGroups([5, 4, 3, 2, 2, 1]);

// ---- NUL in ids: "a\0b"+"c" and "a"+"b\0c" collide in the TS string key, so the TS merges
// the two edges into one of weight 2. Rust must reproduce that.
const nulProject = project(
  [node("a\u0000b"), node("c"), node("a"), node("b\u0000c"), node("d")],
  [
    edge("a\u0000b", "c"),
    edge("a", "b\u0000c"),
    edge("c", "d"),
  ],
);

// ---- ring from ids of several kinds: string, integer, fraction, exponent forms, zero.
const ringIdSnapshot = {
  activity: {
    items: [1.5, 1e21, 1e-7, "str-id", 9007199254740992, 0, 1e-6, 12345678.5].map((id, i) => ({
      id,
      kind: "chat",
      title: `Ring ${i}`,
      detail: null,
      link: null,
      createdAt: `2026-10-27 11:${String(i).padStart(2, "0")}:00`,
    })),
  },
};

// ---- ring dedupe and truncation together: the cap is applied first, then duplicates collapse.
const dedupeSnapshot = {
  activity: {
    items: [1, 1, 2, "s-3", 3, 4, 5].map((id, i) => ({
      id,
      kind: "loop",
      title: `Dup ${i}`,
      detail: null,
      link: i % 2 ? `/d/${i}` : null,
      createdAt: `2026-10-27 12:${String(i).padStart(2, "0")}:00`,
    })),
  },
};

const cases = {
  null_inputs: {
    snapshot: null,
    project: null,
    buildOptions: {},
    orbitOptions: {},
  },
  categories_duplicates: {
    snapshot: osSnapshotFixture(),
    project: categoriesProject,
    buildOptions: {},
    orbitOptions: {},
  },
  cap_greedy_skip: {
    snapshot: null,
    project: greedyProject,
    buildOptions: { maxCoreNodes: 6 },
    orbitOptions: { seed: 3 },
  },
  cap_partial_trim: {
    snapshot: null,
    project: hubProject,
    buildOptions: { maxCoreNodes: 2 },
    orbitOptions: { coreRadius: 120, ringRadius: 200, iterations: 30 },
  },
  cap_zero_no_iterations: {
    snapshot: osSnapshotFixture(),
    project: categoriesProject,
    buildOptions: { maxCoreNodes: 0, maxRingItems: 2 },
    orbitOptions: { iterations: 0 },
  },
  synthetic_2000_cap500: syntheticCase(),
  model_leniency: {
    snapshot: null,
    project: leniencyProject,
    buildOptions: {},
    orbitOptions: { seed: 2 },
  },
  metadata_path_precedence: {
    snapshot: null,
    project: precedenceProject,
    buildOptions: {},
    orbitOptions: {},
  },
  non_bmp_ids: {
    snapshot: null,
    project: nonBmpProject,
    buildOptions: { maxCoreNodes: 5 },
    orbitOptions: { seed: 11 },
  },
  orbit_weights_radii_seed: {
    snapshot: {
      activity: {
        items: [
          { id: 40, kind: "chat", title: "Forty", detail: null, link: null, createdAt: "2026-10-27 13:00:00" },
          { id: 41, kind: "loop", title: "Forty-one", detail: null, link: "/l", createdAt: "2026-10-27 13:01:00" },
          { id: 42, kind: "chat", title: "Forty-two", detail: null, link: null, createdAt: "2026-10-27 13:02:00" },
        ],
      },
    },
    project: weightedProject,
    buildOptions: {},
    orbitOptions: { coreRadius: 37.5, ringRadius: 90, seed: 4294967301, iterations: 25 },
  },
  raw_orbit_sparse_communities: {
    snapshot: null,
    project: null,
    buildOptions: {},
    orbitOptions: { seed: 5 },
    rawSystemGraph: rawOrbitGraph,
  },
  exact_fill_six_communities_cap12: {
    snapshot: null,
    project: sixCliques,
    buildOptions: { maxCoreNodes: 12 },
    orbitOptions: {},
  },
  exact_fill_six_communities_cap13: {
    snapshot: null,
    project: sixCliques,
    buildOptions: { maxCoreNodes: 13 },
    orbitOptions: {},
  },
  ring_dedupe_and_truncation: {
    snapshot: dedupeSnapshot,
    project: null,
    buildOptions: { maxRingItems: 4 },
    orbitOptions: {},
  },
  ring_id_js_number_format: {
    snapshot: ringIdSnapshot,
    project: project([node("only.ts")], []),
    buildOptions: {},
    orbitOptions: {},
  },
  limits_fractional: {
    snapshot: ringIdSnapshot,
    project: nonBmpProject,
    buildOptions: { maxCoreNodes: 3.7, maxRingItems: 2.9 },
    orbitOptions: { iterations: 12.8, coreRadius: 50.5 },
  },
  limits_negative: {
    snapshot: ringIdSnapshot,
    project: nonBmpProject,
    buildOptions: { maxCoreNodes: -4, maxRingItems: -3 },
    orbitOptions: { iterations: -2, ringRadius: -10, seed: -7 },
  },
  nul_ids_key_collision: {
    snapshot: null,
    project: nulProject,
    buildOptions: {},
    orbitOptions: {},
  },
  duplicate_ring_ids: (() => {
    const snapshot = osSnapshotFixture();
    const [first, second] = snapshot.activity.items;
    snapshot.activity.items = [first, second, { ...second, title: "Second again" }, snapshot.activity.items[2]];
    return {
      snapshot,
      project: project([node("a.ts"), node("b.ts")], [edge("a.ts", "b.ts")]),
      buildOptions: {},
      orbitOptions: {},
    };
  })(),
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [name, input] of Object.entries(cases)) {
  const systemGraph =
    input.rawSystemGraph !== undefined
      ? input.rawSystemGraph
      : buildSystemGraph(input.snapshot, input.project, input.buildOptions);
  const orbit = serializeOrbit(orbitLayout(systemGraph, input.orbitOptions));
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ input, systemGraph, orbit }, null, 1) + "\n");
  const t = systemGraph.truncated;
  console.log(
    `${name}: nodes=${t?.totalNodes} kept=${t?.keptNodes} communities=${t?.keptCommunities} ` +
      `core=${systemGraph.core.length} edges=${systemGraph.edges.length} ring=${systemGraph.ring.length}`,
  );
}
