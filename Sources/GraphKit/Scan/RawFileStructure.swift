import Foundation
import GraphCore

public struct RawFileStructure: Codable, Equatable, Sendable {
    public let path: String
    public let language: String
    public let loc: Int
    public let rawImports: [RawImport]
    public let symbols: [ScanResult.Symbol]
    public let calls: [ScanResult.CallRef]
    public let inherits: [ScanResult.InheritRef]
    public let implements: [ScanResult.ImplementRef]
    public let citations: [ScanResult.Citation]

    public init(path: String, language: String, loc: Int,
                rawImports: [RawImport],
                symbols: [ScanResult.Symbol],
                calls: [ScanResult.CallRef]            = [],
                inherits: [ScanResult.InheritRef]      = [],
                implements: [ScanResult.ImplementRef]  = [],
                citations: [ScanResult.Citation]       = []) {
        self.path = path; self.language = language; self.loc = loc
        self.rawImports = rawImports; self.symbols = symbols
        self.calls = calls; self.inherits = inherits; self.implements = implements
        self.citations = citations
    }

    private enum CodingKeys: String, CodingKey {
        case path, language, loc, rawImports, symbols, calls, inherits, implements, citations
    }
    /// Caches written before citations existed decode with none (the cache
    /// version bump discards them anyway).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        language = try c.decode(String.self, forKey: .language)
        loc = try c.decode(Int.self, forKey: .loc)
        rawImports = try c.decode([RawImport].self, forKey: .rawImports)
        symbols = try c.decode([ScanResult.Symbol].self, forKey: .symbols)
        calls = try c.decode([ScanResult.CallRef].self, forKey: .calls)
        inherits = try c.decode([ScanResult.InheritRef].self, forKey: .inherits)
        implements = try c.decode([ScanResult.ImplementRef].self, forKey: .implements)
        citations = try c.decodeIfPresent([ScanResult.Citation].self, forKey: .citations) ?? []
    }
}

public struct RawImport: Codable, Equatable, Sendable {
    public let module: String
    public let name: String?
    public init(module: String, name: String? = nil) {
        self.module = module; self.name = name
    }
}
