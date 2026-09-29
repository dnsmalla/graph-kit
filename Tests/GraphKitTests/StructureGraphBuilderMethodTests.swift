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

    func testCallEdgesResolveSameFileThenImportsThenUniqueNames() {
        let files: [ScanResult.FileEntry] = ["a.swift", "b.swift", "c.swift", "d.swift"].map {
            .init(path: $0, language: "swift", loc: 3)
        }
        let symbols: [String: [ScanResult.Symbol]] = [
            "a.swift": [.init(name: "helper", kind: "function", line: 1), .init(name: "run", kind: "function", line: 2)],
            "b.swift": [.init(name: "other", kind: "function", line: 1)],
            "c.swift": [.init(name: "load", kind: "function", line: 1)],
            "d.swift": [.init(name: "load", kind: "function", line: 1), .init(name: "caller", kind: "function", line: 2)],
        ]
        let calls: [String: [ScanResult.CallRef]] = [
            "a.swift": [.init(caller: "run", callee: "helper", line: 3)],
            "b.swift": [.init(caller: "other", callee: "helper", line: 2)],   // globally unique
            "d.swift": [.init(caller: "caller", callee: "load", line: 3)],    // same file wins over c.swift
        ]
        let scan = ScanResult(files: files, imports: [:], symbols: symbols,
                              calls: calls, inherits: [:], implements: [:])
        let edges = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r")).edges
            .filter { $0.kind == .calls }
        let pairs = Set(edges.map { "\($0.fromId)>\($0.toId)" })
        XCTAssertTrue(pairs.contains("function:a.swift:run>function:a.swift:helper"))
        XCTAssertTrue(pairs.contains("function:b.swift:other>function:a.swift:helper"))
        XCTAssertTrue(pairs.contains("function:d.swift:caller>function:d.swift:load"))
        XCTAssertFalse(pairs.contains("function:d.swift:caller>function:c.swift:load"))
        XCTAssertTrue(edges.allSatisfy { $0.confidence == .inferred })
    }

    func testAmbiguousCalleeIsSkipped() {
        let files: [ScanResult.FileEntry] = ["x.swift", "y.swift", "z.swift"].map { .init(path: $0, language: "swift", loc: 2) }
        let scan = ScanResult(files: files, imports: [:],
                              symbols: ["x.swift": [.init(name: "save", kind: "function", line: 1)],
                                        "y.swift": [.init(name: "save", kind: "function", line: 1)],
                                        "z.swift": [.init(name: "go", kind: "function", line: 1)]],
                              calls: ["z.swift": [.init(caller: "go", callee: "save", line: 2)]],
                              inherits: [:], implements: [:])
        let calls = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r")).edges.filter { $0.kind == .calls }
        XCTAssertTrue(calls.isEmpty, "two files define save and z imports neither — no guess")
    }

    private func callPairs(files: [String], symbols: [String: [ScanResult.Symbol]],
                           imports: [String: [String]] = [:],
                           calls: [String: [ScanResult.CallRef]]) -> Set<String> {
        let scan = ScanResult(files: files.map { .init(path: $0, language: "swift", loc: 3) },
                              imports: imports, symbols: symbols, calls: calls,
                              inherits: [:], implements: [:])
        let edges = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r")).edges
            .filter { $0.kind == .calls }
        return Set(edges.map { "\($0.fromId)>\($0.toId)" })
    }

    func testMemberCallDoesNotUseGlobalUniqueFallback() {
        let pairs = callPairs(
            files: ["a.swift", "b.swift"],
            symbols: ["a.swift": [.init(name: "run", kind: "function", line: 1)],
                      "b.swift": [.init(name: "removeAll", kind: "function", line: 1)]],
            calls: ["a.swift": [.init(caller: "run", callee: "removeAll", line: 2, isMember: true)]])
        XCTAssertTrue(pairs.isEmpty, "arr.removeAll() must not link to an unrelated repo symbol")
        let plain = callPairs(
            files: ["a.swift", "b.swift"],
            symbols: ["a.swift": [.init(name: "run", kind: "function", line: 1)],
                      "b.swift": [.init(name: "removeAll", kind: "function", line: 1)]],
            calls: ["a.swift": [.init(caller: "run", callee: "removeAll", line: 2)]])
        XCTAssertEqual(plain.count, 1, "a plain call keeps the global-unique fallback")
    }

    func testMemberCallStillLinksSameFileAndImportedFile() {
        let pairs = callPairs(
            files: ["a.swift", "b.swift"],
            symbols: ["a.swift": [.init(name: "run", kind: "function", line: 1),
                                  .init(name: "local", kind: "function", line: 2)],
                      "b.swift": [.init(name: "shared", kind: "function", line: 1)]],
            imports: ["a.swift": ["b.swift"]],
            calls: ["a.swift": [.init(caller: "run", callee: "local", line: 3, isMember: true),
                                .init(caller: "run", callee: "shared", line: 4, isMember: true)]])
        XCTAssertTrue(pairs.contains("function:a.swift:run>function:a.swift:local"))
        XCTAssertTrue(pairs.contains("function:a.swift:run>function:b.swift:shared"))
    }

    func testCallRefDecodesWithoutIsMember() throws {
        let json = #"{"caller":"a","callee":"b","line":3}"#.data(using: .utf8)!
        let ref = try JSONDecoder().decode(ScanResult.CallRef.self, from: json)
        XCTAssertFalse(ref.isMember)
    }
}
