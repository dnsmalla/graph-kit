import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanCode } from "../src/code/tsScanner.js";

async function withTree(files: Record<string, string>, fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gk-nocalls-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `run` calls `helper` across files, so the default scan has a calls edge.
const TREE = {
  "a.ts": "export function helper() { return 1; }\n",
  "b.ts": 'import { helper } from "./a";\nexport function run() { return helper(); }\n',
  "c.py": "def leaf():\n    return 2\n\ndef top():\n    leaf()\n",
};

const key = (e: { fromId: string; toId: string; kind: string }) => `${e.fromId}→${e.toId}:${e.kind}`;

test("calls: false drops every calls edge and leaves the other edges identical", async () => {
  await withTree(TREE, async (dir) => {
    const withCalls = await scanCode(dir);
    const without = await scanCode(dir, { calls: false });
    assert.ok(withCalls.edges.some((e) => e.kind === "calls"), "default scan has calls edges");
    assert.equal(without.edges.filter((e) => e.kind === "calls").length, 0, "no calls edges");
    const nonCalls = (g: typeof withCalls) => g.edges.filter((e) => e.kind !== "calls").map(key).sort();
    assert.deepEqual(nonCalls(without), nonCalls(withCalls), "other edges unchanged");
    assert.deepEqual(without.nodes.map((n) => n.id).sort(), withCalls.nodes.map((n) => n.id).sort(), "nodes unchanged");
  });
});

test("graph-kit code --no-calls writes a graph with no calls edges", async () => {
  await withTree(TREE, (dir) => {
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    const out = join(dir, "..", `gk-nocalls-out-${process.pid}.json`);
    const run = spawnSync(process.execPath, [cli, "code", dir, "--no-calls", "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /graph-kit: \d+ nodes, \d+ edges/, "summary line kept");
    const doc = JSON.parse(readFileSync(out, "utf8")) as { edges: { kind: string }[] };
    rmSync(out, { force: true });
    assert.ok(doc.edges.length > 0, "other edges are present");
    assert.equal(doc.edges.filter((e) => e.kind === "calls").length, 0);
  });
});
