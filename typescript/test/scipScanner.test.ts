import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CGNode } from "../src/models.js";
import { parseScipJson } from "../src/code/scipScanner.js";

// dist/test/scipScanner.test.js → root is two levels up
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "test", "fixtures", "scip", "sample.scip.json"), "utf8"),
);

test("parseScipJson emits one definition node per symbol with provenance", () => {
  const graph = parseScipJson(fixture);
  const add = graph.nodes.find((n: CGNode) => n.title === "add");
  assert.ok(add, "add node exists");
  assert.equal(add.kind, "function");
  assert.equal(add.metadata.source_file, "src/app.ts");
  assert.equal(add.metadata.line, "L3");
  assert.equal(add.metadata.language, "TypeScript");
  assert.equal(graph.nodes.length, 2);
});
