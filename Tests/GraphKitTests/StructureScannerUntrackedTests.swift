import XCTest
import GraphCore
@testable import GraphKit

/// `git ls-files` alone hides files the user has not `git add`ed yet.
final class StructureScannerUntrackedTests: XCTestCase {
    private func git(_ dir: URL, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "git \(args) failed")
    }

    func testListingIncludesUntrackedButNotIgnoredFiles() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-untracked-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try "export const a = 1;\n".write(to: dir.appendingPathComponent("tracked.ts"), atomically: true, encoding: .utf8)
        try "ignored.ts\n".write(to: dir.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        try git(dir, ["init", "-q"])
        try git(dir, ["add", "tracked.ts", ".gitignore"])
        try git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"])
        try "export const b = 2;\n".write(to: dir.appendingPathComponent("untracked.ts"), atomically: true, encoding: .utf8)
        try "export const c = 3;\n".write(to: dir.appendingPathComponent("ignored.ts"), atomically: true, encoding: .utf8)

        let scanner = StructureScanner(launcher: SystemProcessLauncher())
        let inc = await scanner.scanIncremental(repoRoot: dir)
        let paths = Set(inc.result.files.map(\.path))
        XCTAssertTrue(paths.contains("tracked.ts"))
        XCTAssertTrue(paths.contains("untracked.ts"))
        XCTAssertFalse(paths.contains("ignored.ts"))
    }
}
