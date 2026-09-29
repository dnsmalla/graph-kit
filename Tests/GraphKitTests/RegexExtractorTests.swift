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

    func testFunctionsInsideATypeBecomeMethodsOfIt() throws {
        let src = """
        struct Alpha {
            func load() {}
        }
        struct Beta {
            func load() {}
        }
        func free() {}
        """
        let syms = try XCTUnwrap(try parse(["f.swift": src]).first?.symbols)
        let loads = syms.filter { $0.name == "load" }
        XCTAssertEqual(loads.map(\.kind), ["method", "method"])
        XCTAssertEqual(loads.map(\.parent), ["Alpha", "Beta"])
        let free = try XCTUnwrap(syms.first { $0.name == "free" })
        XCTAssertEqual(free.kind, "function")
        XCTAssertNil(free.parent)
    }

    func testCallsAreAttributedToTheEnclosingCallable() throws {
        let src = """
        func helper() -> Int { 1 }
        func run() {
            let x = helper()
            if x > 0 { print(x) }
        }
        """
        let calls = try XCTUnwrap(try parse(["a.swift": src]).first?.calls)
        XCTAssertTrue(calls.contains { $0.caller == "run" && $0.callee == "helper" })
        XCTAssertFalse(calls.contains { $0.callee == "if" }, "keywords are not calls")
    }

    func testCallOnTheDeclarationLineIsKept() throws {
        let src = "func helper() {}\nfunc run() { helper() }\n"
        let calls = try XCTUnwrap(try parse(["a.swift": src]).first?.calls)
        XCTAssertTrue(calls.contains { $0.caller == "run" && $0.callee == "helper" })
    }

    func testMemberCallsAreFlaggedButSelfCallsAreNot() throws {
        let src = "func run() {\n    arr.removeAll()\n    self.helper()\n    helper()\n    x .sorted()\n}\n"
        let calls = try XCTUnwrap(try parse(["a.swift": src]).first?.calls)
        XCTAssertEqual(calls.first { $0.callee == "removeAll" }?.isMember, true)
        XCTAssertEqual(calls.first { $0.callee == "sorted" }?.isMember, true)
        XCTAssertEqual(calls.first { $0.callee == "helper" }?.isMember, false)
    }
}
