import XCTest
import GraphCore
@testable import GraphKit

/// The regex extractor (Swift/TS/JS/Kotlin) computed a declaration and then
/// rebuilt every symbol without it, so the graph never carried a signature.
final class RegexExtractorTests: XCTestCase {
    func parse(_ files: [String: String]) throws -> [RawFileStructure] {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-regex-\(UUID().uuidString)", isDirectory: true)
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return FileStructureExtractor(launcher: SystemProcessLauncher())
            .parseFiles(paths: files.keys.sorted(), repoRoot: root)
    }

    func testDeclarationIsKept() throws {
        let out = try parse(["a.swift": "func rotatePin(for id: String) -> Bool {\n    true\n}\n"])
        let sym = try XCTUnwrap(out.first?.symbols.first { $0.name == "rotatePin" })
        XCTAssertEqual(sym.declaration, "func rotatePin(for id: String) -> Bool")
        XCTAssertEqual(sym.line, 1)
    }
}
