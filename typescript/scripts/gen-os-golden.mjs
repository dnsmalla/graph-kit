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
  const systemGraph = buildSystemGraph(input.snapshot, input.project, input.buildOptions);
  const orbit = serializeOrbit(orbitLayout(systemGraph, input.orbitOptions));
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ input, systemGraph, orbit }, null, 1) + "\n");
  const t = systemGraph.truncated;
  console.log(
    `${name}: nodes=${t.totalNodes} kept=${t.keptNodes} communities=${t.keptCommunities} ` +
      `core=${systemGraph.core.length} edges=${systemGraph.edges.length} ring=${systemGraph.ring.length}`,
  );
}
