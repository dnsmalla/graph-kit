import XCTest
import GraphCore
@testable import GraphKit

/// The cache version was a hard-coded "1", so an extractor upgrade kept serving
/// structures parsed by the old extractor for every unchanged file.
final class ScanCacheVersionTests: XCTestCase {
    func testACacheFromAnOlderExtractorIsDiscarded() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("gk-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        var old = ScanCache(version: "1")
        old.entries["a.swift"] = .init(hash: "h", structure: RawFileStructure(path: "a.swift", language: "swift", loc: 1, rawImports: [], symbols: []))
        old.save(forRepo: root)
        XCTAssertTrue(ScanCache.load(forRepo: root).entries.isEmpty)
        XCTAssertEqual(ScanCache().version, ScanCache.currentVersion)
    }

    func testACurrentCacheRoundTrips() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("gk-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        var cur = ScanCache()
        cur.entries["a.swift"] = .init(hash: "h", structure: RawFileStructure(path: "a.swift", language: "swift", loc: 1, rawImports: [], symbols: []))
        cur.save(forRepo: root)
        XCTAssertEqual(ScanCache.load(forRepo: root).entries.count, 1)
    }
}
