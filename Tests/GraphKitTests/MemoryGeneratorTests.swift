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
}
