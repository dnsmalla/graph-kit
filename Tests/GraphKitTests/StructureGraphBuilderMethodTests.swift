import XCTest
import GraphCore
@testable import GraphKit

/// Same-name methods in different types of one file used to share an id
/// (`function:f.swift:load`), so the second was dropped from the graph.
final class StructureGraphBuilderMethodTests: XCTestCase {
    func testSameNameMethodsInDifferentTypesAreBothKept() {
        let syms: [ScanResult.Symbol] = [
            .init(name: "Alpha", kind: "struct", line: 1),
            .init(name: "load", kind: "method", line: 2, parent: "Alpha"),
            .init(name: "Beta", kind: "struct", line: 4),
            .init(name: "load", kind: "method", line: 5, parent: "Beta"),
        ]
        let scan = ScanResult(files: [.init(path: "f.swift", language: "swift", loc: 6)],
                              imports: [:], symbols: ["f.swift": syms])
        let graph = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r"))
        let ids = Set(graph.nodes.map(\.id))
        XCTAssertTrue(ids.contains("method:f.swift:Alpha.load"))
        XCTAssertTrue(ids.contains("method:f.swift:Beta.load"))
        XCTAssertTrue(graph.edges.contains { $0.fromId == "class:f.swift:Alpha" && $0.toId == "method:f.swift:Alpha.load" && $0.kind == .contains })
    }

    /// The Python AST / tree-sitter scanners already emit `Cls.meth` with parent `Cls`.
    func testAlreadyQualifiedMethodNamesAreNotQualifiedTwice() {
        let syms: [ScanResult.Symbol] = [
            .init(name: "Alpha", kind: "struct", line: 1),
            .init(name: "Alpha.load", kind: "method", line: 2, parent: "Alpha"),
        ]
        let scan = ScanResult(files: [.init(path: "f.swift", language: "swift", loc: 3)],
                              imports: [:], symbols: ["f.swift": syms])
        let graph = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r"))
        let ids = Set(graph.nodes.map(\.id))
        XCTAssertTrue(ids.contains("method:f.swift:Alpha.load"))
        XCTAssertFalse(ids.contains("method:f.swift:Alpha.Alpha.load"))
    }
}
