import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanCode, scanCodeWithStats } from "../src/code/tsScanner.js";

async function withTree(files: Record<string, string>, fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gk-maxfiles-"));
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

const FIVE = {
  "a.ts": "export const a = 1;\n",
  "b.ts": "export const b = 2;\n",
  "c.ts": "export const c = 3;\n",
  "d.ts": "export const d = 4;\n",
  "e.ts": "export const e = 5;\n",
};

const fileNodes = (graph: { nodes: { kind: string }[] }) => graph.nodes.filter((n) => n.kind === "file");

test("scanCodeWithStats reports truncation when the file limit cuts the walk short", async () => {
  await withTree(FIVE, async (dir) => {
    const { graph, stats } = await scanCodeWithStats(dir, { maxFiles: 3 });
    assert.equal(stats.truncated, true);
    assert.equal(stats.limit, 3);
    assert.equal(stats.files, 3);
    assert.equal(fileNodes(graph).length, 3);
  });
});

test("scanCodeWithStats is not truncated when all files fit, including exactly at the limit", async () => {
  await withTree(FIVE, async (dir) => {
    const all = await scanCodeWithStats(dir);
    assert.equal(all.stats.truncated, false);
    assert.equal(all.stats.limit, 20000, "default limit");
    assert.equal(all.stats.files, 5);
    assert.equal(fileNodes(all.graph).length, 5);

    const exact = await scanCodeWithStats(dir, { maxFiles: 5 });
    assert.equal(exact.stats.truncated, false, "a tree of exactly the limit is complete");
    assert.equal(fileNodes(exact.graph).length, 5);
  });
});

test("scanCode still returns just the graph", async () => {
  await withTree(FIVE, async (dir) => {
    const graph = await scanCode(dir, { maxFiles: 3 });
    assert.equal(fileNodes(graph).length, 3);
    assert.equal("stats" in graph, false);
  });
});

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const runCli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("graph-kit code --max-files warns on truncation and rejects a non-positive limit", async () => {
  await withTree(FIVE, (dir) => {
    const out = join(dir, "..", `gk-maxfiles-out-${process.pid}.json`);
    const limited = runCli(["code", dir, "--max-files", "2", "--out", out]);
    assert.equal(limited.status, 0);
    assert.match(
      limited.stderr,
      /graph-kit: warning: scanned 2 code files and stopped at the limit; more files exist \(raise it with --max-files\)/,
    );
    assert.match(limited.stderr, /graph-kit: \d+ nodes, \d+ edges/, "summary line is kept");
    rmSync(out, { force: true });

    const zero = runCli(["code", dir, "--max-files", "0"]);
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /graph-kit: --max-files must be a positive integer/);

    const junk = runCli(["code", dir, "--max-files", "abc"]);
    assert.equal(junk.status, 1);
    assert.match(junk.stderr, /--max-files must be a positive integer/);
  });
});
