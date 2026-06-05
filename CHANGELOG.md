# Changelog

All notable changes to GraphKit. The Swift package and the TypeScript package
(`typescript/`) share one canonical graph schema (`schema/SCHEMA.md`); the schema's
`schemaVersion` is versioned independently of the package tags.

## [Unreleased]

### Added
- **TypeScript code → graph scanner** (`scanCode`, `graph-kit code <dir>`, `update --code <dir>`):
  TS/JS via the TypeScript compiler API — file/symbol nodes (functions, classes, methods,
  interfaces, arrow-function consts) with `contains` / `imports` (resolved relative imports) /
  `inherits` / `implements` edges. Deterministic output. `mergeGraphs` unions a code graph
  into the memory index. 4 tests (22 total). (`typescript` promoted to a runtime dependency.)
  Call-edge extraction remains a follow-up.

## [1.3.0] — 2026-06-05 — multi-language platform

### Added
- **Canonical schema** (`schema/SCHEMA.md` + `schema/graph.schema.json`, `schemaVersion: 1`):
  the language-neutral node/edge contract every implementation conforms to, plus shared
  conformance fixtures under `schema/fixtures/`.
- **Swift**: `CGNode`/`CGEdge`/`CGData`/`CGNodeKind`/`CGEdgeKind`/`CGEdgeConfidence`/`UALayer`/
  `UATourStep` are now `Codable`; new `GraphDocument` envelope (`schemaVersion` + payload) with
  canonical (sorted-key) JSON encode/decode and a future-version guard. 4 new conformance tests
  (42 total).
- **TypeScript package** (`typescript/`, `@dnsmalla/graph-kit`): the canonical model + zod
  validation, a faithful port of the text→graph `MemoryGenerator`, a markdown index generator,
  and a `graph-kit` CLI (`memory` / `index` / `validate`). 11 tests incl. cross-language
  fixture conformance against `schema/fixtures/`.

### Fixed
- **Swift**: `MemoryNotesWriter.childSymbols` now accepts both `defines` and `contains`
  edges, so a code-scan graph (which emits `contains`) renders symbols instead of an empty
  index.
- README SwiftPM install URL corrected (`graph-kit.git`, was `GraphKit.git`).

### Added — memory engine (TypeScript)
- **Incremental, idempotent index generation** (`updateMemory` + `graph-kit update`): a
  content-hash manifest re-chunks only changed files and reuses cached chunks for the rest;
  a no-op run produces byte-identical output. Reports added/updated/unchanged/removed.
- **Background regeneration**: `graph-kit watch <dir>` (debounced) for live updates; `update`
  is hook-friendly (git post-commit / file watcher) for detached background runs.
- **Local-only artifacts**: writes `graph.json` + `index.md` + `cache.json` to a `.graphkit/`
  dir that **self-gitignores** (`*`) — generated memory never gets committed or pushed.
- **Skill + agent linking**: new canonical node kinds `skill` + `agent` (Swift + TS + JSON
  Schema); `scanSkills`/`scanAgents` turn `SKILL.md` + agent definitions into nodes, and
  `mergeCapabilities` links them to the docs/code that reference them. `update --skills <dir>
  --agents <dir>` folds them into the index so agents can consult memory at low token cost.

### Notes / next
- TypeScript **code → graph** scanner (TS/JS via the TypeScript compiler API) is the next
  milestone, then consuming the engine from auto-system (as a submodule) to generate its
  index — without moving its memory into GraphKit.

## [1.1.0] — 2026-06-03
- Added the document-extraction layer (`Extract/`: PDF + Vision OCR, EPUB, chunking). macOS 13+.
  Fixed two TextChunker bugs. 38 tests.

## [1.0.1] — 2026-06-03
- Fixed a force-unwrap in `CodeNoteWriter`.

## [1.0.0] — 2026-06-03
- Initial extraction of the shared code→graph + text→graph engine from InfiniteBrain + meet-notes.
