# GraphKit

Shared, **multi-language** graph engine for turning **code** and **text** into a structured
node/edge graph. Extracted from InfiniteBrain + meet-notes so a single update propagates to
every consumer.

UI-free (no SwiftUI) — consumers supply their own rendering. macOS 13+.

## Implementations

All implementations conform to one **canonical graph schema** — the language-neutral JSON
contract in [`schema/SCHEMA.md`](schema/SCHEMA.md) (validated by `schema/graph.schema.json`,
with shared conformance fixtures in `schema/fixtures/`). A graph produced in one language is
readable in another.

| Language | Location | Status |
|---|---|---|
| Swift (SwiftPM) | repo root (`Sources/GraphKit`) | code→graph, text→graph, cache |
| TypeScript (npm `@dnsmalla/graph-kit`) | [`typescript/`](typescript/) | code→graph (TS/JS, call edges), text→graph, index, schema validation, CLI |

The Swift docs below describe the Swift package; see [`typescript/README.md`](typescript/README.md)
for the TypeScript package and the `graph-kit` CLI.

## What it does

- **Code → graph**: scans a repo (Python/TypeScript/JavaScript/Kotlin via tree-sitter, Swift via regex) and produces files, classes, functions, methods, and `imports`/`contains`/`calls`/`inherits`/`implements` edges with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` confidence.
- **Text → graph**: chunks markdown by heading and links chunks via wiki-links + tags (`MemoryGenerator`).
- **Incremental cache**: content-hash based re-scan (`Fingerprint`, `ScanCache`).

## Install

```swift
.package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.0.0")
```

Then add `"GraphKit"` to your target's dependencies and `import GraphKit`.

## Python dependency (code graph)

The rich code scanner shells out to a bundled Python script that needs tree-sitter
installed on the **system** `python3` (PATH-discovered):

```bash
pip3 install tree-sitter==0.21.3 tree-sitter-languages==1.10.2
```

Without it, scanning gracefully falls back to Python-only stdlib `ast` (TS/JS/Kotlin yield no graph).

## Usage

```swift
import GraphKit

// Code → graph
let scanner = StructureScanner(launcher: SystemProcessLauncher())
let scan = await scanner.scan(repoRoot: repoURL)
let graph = StructureGraphBuilder.build(scan, repoRoot: repoURL)   // -> CGData

// Text → graph
let memory = MemoryGenerator.generate(from: vaultURL)              // -> GeneratedMemory (.graph, .chunks)
```

`CGData` holds `[CGNode]` + `[CGEdge]`. Lay them out and render in your own app.

## Layout / colors

Layout (force-directed simulation) and color palettes are **per-app** — GraphKit ships only
the data model and producers, not presentation.

## Using graph-kit from another project

graph-kit is one repository with several packages. Pick the one your project needs; they
share the canonical graph schema (`schema/SCHEMA.md`), so their outputs interoperate.

| You want to… | Use | Section |
|---|---|---|
| Scan code / build a memory graph from Swift | SwiftPM products `GraphKit` (+ `GraphCore`) | [Swift](#swift-spm) |
| Read, validate, lay out or render a graph in Swift | SwiftPM product `GraphCore` | [Swift](#swift-spm) |
| Scan, merge, index or validate from Node or the shell | npm `@dnsmalla/graph-kit` (library + `graph-kit` CLI) | [TypeScript](#typescript-and-the-cli) |
| Compute the OS-view graph layout in Rust or in the browser | crate `graph-kit-os` (`rust/os-graph`) and its WASM build | [Rust](#rust-graph-kit-os) |
| Embed the OS view page in a web app | `web/` (`mountOsView`, the `OsHost` contract) | [Web page](#web-page-mountosview) |
| Produce or consume graph JSON in another language | `schema/graph.schema.json` + fixtures | [Schema](#canonical-json-schema) |

### Swift (SwiftPM)

```swift
// Package.swift of your project
dependencies: [
    .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.6.0"),
],
targets: [
    .target(name: "YourTarget", dependencies: [
        .product(name: "GraphKit", package: "graph-kit"),   // producers: scanners, memory generator
        .product(name: "GraphCore", package: "graph-kit"),  // model, JSON contract, layout
    ]),
]
```

- **`GraphCore`** is the canonical model (`CGData`, `CGNode`, `CGEdge`), its JSON contract and the
  layout engine. Depend on it alone when your app only **reads and draws** a graph someone else
  produced.
- **`GraphKit`** holds the **producers**: `StructureScanner` + `StructureGraphBuilder` (code to
  graph), `MemoryGenerator` (markdown to graph), `GraphMerger` and `ScanCache`. It builds on
  `GraphCore`, so list both products when your code imports both modules, as in the example above.
- The package has no third-party Swift dependencies. The code scanner runs a bundled Python
  script, so it needs `python3` with tree-sitter on the system PATH (see
  [Python dependency](#python-dependency-code-graph)).
- `GRAPHKIT_BUILTIN` is **not** a graph-kit setting. It is a define the LLM-IDE app target uses
  to compile its built-in engine in or out; other projects do not need it.
- Requirements: swift-tools 5.9, macOS 13+ (the `platforms` in `Package.swift`).

### TypeScript and the CLI

```bash
npm install @dnsmalla/graph-kit      # once a release is published (see Releasing)
```

```ts
import { generateFromDir, generateIndex, parseDocumentString, serializeDocument, toDocument } from "@dnsmalla/graph-kit";
const { graph } = generateFromDir("./docs");
const json = serializeDocument(toDocument(graph));
```

The CLI (`graph-kit` bin in the package): `memory`, `update`, `watch`, `code`, `merge`, `index`,
`validate`. From a checkout, without installing anything:

```bash
cd typescript && npm ci && npm run build     # builds dist/, the package's bin
node dist/src/cli.js validate ../schema/fixtures/sample.json
```

`bin/graph-kit.js` at the repository root is a single-file, minified CLI bundle with no
dependencies to install. `graph-engine.json` points at it, so the repository works as a
graph-engine plugin from a fresh clone. Rebuild it after any `typescript/src` change with
`cd typescript && npm run bundle`. The npm package ships only `dist/`, not that bundle.

Requirements: Node >= 18 (`engines`); CI tests Node 18 and 20.

### Rust (`graph-kit-os`)

`rust/os-graph` is the canonical OS-view graph core. It is JSON in, JSON out, and it is not
published to crates.io (`publish = false`), so depend on it by path or git:

```toml
[dependencies]
graph-kit-os = { path = "../graph-kit/rust/os-graph" }
```

```rust
let graph = graph_kit_os::api::build_system_graph_json(snapshot_json, project_json, opts_json);
let layout = graph_kit_os::api::orbit_layout_json(&graph, "{}");
```

The functions are in `rust/os-graph/src/api.rs`: `build_system_graph_json`, `orbit_layout_json`,
`viz_layout_json`, `build_os_view_json` and `code_summary_json`. Each returns JSON, and an error
comes back as `{"error": ...}`. Inputs are read leniently; see `rust/README.md` for the exact
boundary. Run the tests with `cd rust && cargo test --release`.

**WASM.** The same functions are exported with wasm-bindgen behind the `wasm` feature.
`scripts/build-os-wasm.sh` builds them and writes `web/src/wasm/pkg/` and `web/src/wasm/bytes.ts`
(the `.wasm` as base64, with the rustc version in a header). To embed the module without a
network fetch, import `initSync` from the glue and pass the decoded bytes, as `web/src/wasm/index.ts`
does. Wasm output is reproducible only with the rustc recorded in `bytes.ts` and only on the
platform that built it (the same toolchain gives different code on Linux x86_64 and macOS aarch64;
the JS glue and `.d.ts` are identical on both). `scripts/build-os-wasm.sh --check --strict` fails
when the local toolchain differs; CI runs it with `--glue-only` (glue and types only) and validates
the committed bytes by behaviour instead. Pin your own build to that version if you rebuild the module.

Requirements: the rustc recorded in `web/src/wasm/bytes.ts` (currently 1.99.1), the
`wasm32-unknown-unknown` target for the WASM build, and the `wasm-bindgen` CLI at the version in
`rust/Cargo.lock` (currently 0.2.129).

### Web page (`mountOsView`)

`web/` (`@dnsmalla/graph-kit-web`) is a React page for the OS view. It is `private` and consumed
**from source**: point your bundler at it (a path dependency, a git submodule, or a copied
folder) and import from its entry point:

```ts
import { mountOsView } from "@dnsmalla/graph-kit-web";   // web/src/index.ts
const handle = mountOsView(rootElement, host);            // host: an OsHost, see web/README.md
// handle.configure({ theme, projectName }), handle.notifyChange(), handle.retry(), handle.dispose()
```

Your host implements `OsHost` (`web/src/host.ts`): `loadState`, `cancel`, `watch` and `open` are
required; `openFile`, `loadFile`, `copyText`, `loadProjectGraph`, `loadSkills` and `loadRoutines` are optional. The full table is
in [`web/README.md`](web/README.md#the-oshost-contract).

Peer dependencies: `react` and `react-dom` 19.2, `three` 0.185. The page runs with the WASM core
embedded, so the host does not load a `.wasm` file. Tests: `cd web && npm ci && npm test`
(`npm run type-check` for the TypeScript check). CI runs both on Node 22.

### Canonical JSON schema

`schema/graph.schema.json` is the JSON Schema for a graph document and `schema/SCHEMA.md` describes
it. `schema/fixtures/` holds the conformance fixtures shared by the implementations. Validate any
graph with `graph-kit validate <file>` (TypeScript CLI) or with ajv:

```bash
npx --yes ajv-cli@5 validate -s schema/graph.schema.json -d "schema/fixtures/*.json" --spec=draft2020
```

### Releasing

- Every change is recorded under `## [Unreleased]` in `CHANGELOG.md`. A release moves those
  entries under a new `## [X.Y.Z] — YYYY-MM-DD` heading.
- Bump `typescript/package.json` to `X.Y.Z` in the same commit. The Swift package has no version
  field; its version is the tag.
- Tag the commit with the **plain** form, `X.Y.Z` (for example `1.7.0`). `vX.Y.Z` is accepted too,
  but plain is canonical.
- Pushing the tag runs `.github/workflows/release.yml`. It first runs the full CI matrix
  (`ci.yml`: Swift, TypeScript, schema, Rust, WASM reproducibility, web), then verifies that the tag
  matches `typescript/package.json` and that CHANGELOG has a `## [X.Y.Z]` section. Only then does it
  create the GitHub Release (notes = that CHANGELOG section) and, when the `NPM_TOKEN` secret is set,
  publish `@dnsmalla/graph-kit` to npm. Without the secret the npm step is skipped.
- Swift consumers pick up a release through `from:` in their `Package.swift`, because SwiftPM
  resolves semver tags. Nothing is published for Swift beyond the tag.
- The `rustc` version is pinned by `web/src/wasm/bytes.ts`. Changing the toolchain means rebuilding
  the WASM with `scripts/build-os-wasm.sh` and committing the regenerated files; CI reads the pinned
  version from that header.
