# GraphKit

Shared graph engine for turning **code** and **text** into a structured node/edge graph.
Extracted from InfiniteBrain + meet-notes so a single update propagates to every consumer.

UI-free (no SwiftUI) — consumers supply their own rendering. macOS 13+
(PDF extraction uses PDFKit + Vision).

## What it does

- **Document → text**: extract text from PDF (with Vision OCR fallback), EPUB, Markdown, and plain text through one dispatch point (`InputReader`), plus semantic chunking (`TextChunker`) and junk-region detection (`DocumentScanner`).
- **Code → graph**: scans a repo (Python/TypeScript/JavaScript/Kotlin via tree-sitter, Swift via regex) and produces files, classes, functions, methods, and `imports`/`contains`/`calls`/`inherits`/`implements` edges with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` confidence.
- **Text → graph**: chunks markdown by heading and links chunks via wiki-links + tags (`MemoryGenerator`).
- **Incremental cache**: content-hash based re-scan (`Fingerprint`, `ScanCache`).
- **External graph import**: parses Understand-Anything `knowledge-graph.json` (`UAParser`).

## Install

```swift
.package(url: "https://github.com/dnsmalla/GraphKit.git", from: "1.0.0")
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
