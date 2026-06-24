import XCTest
@testable import GraphKit

final class MemoryGeneratorTests: XCTestCase {
    func testGeneratesChunksFromMarkdownHeadings() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-memtest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let md = """
        # Title
        Intro text.

        ## Section A
        Body A with a [[Section B]] link.

        ## Section B
        Body B.
        """
        let file = tmp.appendingPathComponent("doc.md")
        try md.write(to: file, atomically: true, encoding: .utf8)

        let result = MemoryGenerator.generate(files: [file])
        XCTAssertGreaterThan(result.chunks.count, 0, "should chunk by heading")
        XCTAssertGreaterThan(result.graph.nodes.count, 0, "should produce graph nodes")
    }

    /// The repo walker must skip generated-knowledge output (the indexer's own
    /// `system/graph`, `graphify-out`, `.code-notes`, …) and vendor dirs —
    /// otherwise the doc graph double-counts content and fills with duplicates.
    func testRepoWalkerSkipsGeneratedDirs() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-skip-\(UUID().uuidString)")
        let fm = FileManager.default
        defer { try? fm.removeItem(at: tmp) }

        func write(_ rel: String, _ body: String) throws {
            let url = tmp.appendingPathComponent(rel)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        try write("README.md", "# Real Doc\nKept.")
        try write("system/graph/index.md", "# Module (69 files)\nGenerated, must be skipped.")
        try write("graphify-out/memory/repo.md", "# Module (69 files)\nGenerated, must be skipped.")
        try write("node_modules/pkg/readme.md", "# Vendor\nSkipped.")

        let result = MemoryGenerator.generate(from: tmp)
        let titles = Set(result.graph.nodes.map { $0.title })
        XCTAssertEqual(result.docCount, 1, "only the real doc should be indexed")
        XCTAssertTrue(titles.contains("Real Doc"))
        XCTAssertFalse(titles.contains("Module (69 files)"), "generated dirs must be skipped")
    }
}
