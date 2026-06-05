import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCode } from "../src/code/tsScanner.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-code-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("extracts files, functions, classes, methods with contains edges", () => {
  const dir = repo({
    "util.ts": "export function helper() { return 1; }\nexport const arrow = () => 2;\n",
    "service.ts": "export class Service {\n  run() {}\n  stop() {}\n}\n",
  });
  try {
    const g = scanCode(dir);
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.ok(ids.has("file:util.ts"));
    assert.ok(ids.has("symbol:util.ts#helper"));
    assert.ok(ids.has("symbol:util.ts#arrow"), "arrow-function const becomes a function symbol");
    assert.ok(ids.has("symbol:service.ts#Service"));
    assert.ok(ids.has("symbol:service.ts#Service.run"), "method symbol");
    // file contains its top-level symbol
    assert.ok(g.edges.some((e) => e.fromId === "file:util.ts" && e.toId === "symbol:util.ts#helper" && e.kind === "contains"));
    // class contains its method
    assert.ok(g.edges.some((e) => e.fromId === "symbol:service.ts#Service" && e.toId === "symbol:service.ts#Service.run" && e.kind === "contains"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves relative imports to file→file edges", () => {
  const dir = repo({
    "a.ts": "import { helper } from './b';\nexport const x = helper();\n",
    "b.ts": "export function helper() { return 1; }\n",
  });
  try {
    const g = scanCode(dir);
    assert.ok(
      g.edges.some((e) => e.fromId === "file:a.ts" && e.toId === "file:b.ts" && e.kind === "imports" && e.confidence === "EXTRACTED"),
      "relative import './b' resolves to file:b.ts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("class extends / implements produce inherits / implements edges", () => {
  const dir = repo({
    "base.ts": "export class Base {}\nexport interface Runnable {}\n",
    "child.ts": "import { Base, Runnable } from './base';\nexport class Child extends Base implements Runnable {}\n",
  });
  try {
    const g = scanCode(dir);
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:child.ts#Child" && e.toId === "symbol:base.ts#Base" && e.kind === "inherits"),
      "Child inherits Base",
    );
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:child.ts#Child" && e.toId === "symbol:base.ts#Runnable" && e.kind === "implements"),
      "Child implements Runnable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output is deterministic across runs", () => {
  const dir = repo({ "a.ts": "export function f(){}\nexport class C { m(){} }\n" });
  try {
    assert.deepEqual(scanCode(dir), scanCode(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
