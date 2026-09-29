import Foundation
import GraphCore

/// Enumerates Swift / TypeScript / JavaScript files via `git ls-files`
/// and extracts imports + symbols by reading each file line-by-line.
/// Pure static helpers (language, importSpecifier, symbol) are separated
/// for testability. Python files are skipped here and handled by
/// PythonASTExtractor.
public final class FileStructureExtractor {
    private let launcher: ProcessLauncher
    private let gitURL: URL?

    public init(launcher: ProcessLauncher,
                gitURL: URL? = FileStructureExtractor.resolve("git")) {
        self.launcher = launcher
        self.gitURL   = gitURL
    }

    public static func resolve(_ name: String) -> URL? {
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    // MARK: - Pure helpers (public for tests)

    public static let codeExtensions: Set<String> = [
        "ts", "tsx", "js", "jsx", "mjs", "cjs",
        "swift", "kt", "md"
    ]

    public static func language(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "ts", "tsx":                return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "swift":                    return "swift"
        case "kt":                       return "kotlin"
        case "md":                       return "markdown"
        default:                         return "other"
        }
    }

    /// Extract a markdown heading (## or ###) as a symbol, or nil.
    public static func markdownHeading(fromLine line: String, lineNumber: Int) -> ScanResult.Symbol? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("## ") || trimmed.hasPrefix("### ") else { return nil }
        let name = trimmed.drop(while: { $0 == "#" || $0 == " " })
            .trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        return ScanResult.Symbol(name: name, kind: "heading", line: lineNumber)
    }

    /// Extract the import specifier from a single source line, or nil.
    public static func importSpecifier(fromLine line: String, language: String) -> String? {
        switch language {
        case "typescript", "javascript":
            if let r = firstQuoted(in: line),
               line.contains("import") || line.contains("require") { return r }
            // Re-exports (`export { X } from './m'`, `export * from './m'`,
            // `export type { X } from './m'`) are imports too. Anchor on the
            // TRIMMED line prefix (not `contains("export")`) — a bare
            // `contains` check false-positives on `export const from = '…'`
            // (a variable literally named `from` makes the line contain the
            // substring " from "). Multi-line re-export blocks —
            //   export {
            //     a, b, c
            //   } from './m';
            // — are common (Prettier's default wrapping for long named-export
            // lists) and are caught for free here: `importSpecifier` runs
            // per-line, so the OPENING `export {` line correctly returns nil
            // (no `from` on it yet), and the CLOSING `} from './m';` line is
            // caught by the bare `}` prefix below. This is a heuristic, not a
            // parser: a closing brace from unrelated code immediately
            // followed by literal " from " text would false-positive, but
            // that shape is vanishingly rare in real source.
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("export {") || trimmed.hasPrefix("export *")
                || trimmed.hasPrefix("export type {") || trimmed.hasPrefix("}"),
               let fromRange = line.range(of: " from "),
               let r = firstQuoted(in: String(line[fromRange.upperBound...])) { return r }
            return nil
        case "swift":
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("import ") else { return nil }
            let mod = trimmed.dropFirst("import ".count).trimmingCharacters(in: .whitespaces)
            return mod.split(whereSeparator: { $0 == " " }).first.map(String.init)
        default:
            return nil
        }
    }

    /// Extract a defined symbol from a single line, or nil. Line number set to 0;
    /// caller fills in actual line number. `declaration` is the trimmed signature
    /// up to (but not including) the opening `{`.
    public static func symbol(fromLine line: String, language: String) -> ScanResult.Symbol? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        /// Name of the first identifier after `keyword `.
        func nameAfter(_ keyword: String) -> String? {
            guard let r = trimmed.range(of: keyword + " ") else { return nil }
            let rest = trimmed[r.upperBound...]
            let name = rest.prefix { $0.isLetter || $0.isNumber || $0 == "_" }
            return name.isEmpty ? nil : String(name)
        }

        /// Signature text: trimmed up to the first `{`, or the whole trimmed line.
        func decl() -> String {
            (trimmed.components(separatedBy: "{").first ?? trimmed)
                .trimmingCharacters(in: .whitespaces)
        }

        switch language {
        case "typescript", "javascript":
            if let n = nameAfter("function")  { return .init(name: n, kind: "function",  line: 0, declaration: decl()) }
            if let n = nameAfter("class")     { return .init(name: n, kind: "class",     line: 0, declaration: decl()) }
            if let n = nameAfter("interface") { return .init(name: n, kind: "interface", line: 0, declaration: decl()) }
            // const foo = () => ...  or  const foo = async () =>
            if trimmed.contains("=>") || trimmed.contains("= function") || trimmed.contains("= async") {
                if let n = nameAfter("const") ?? nameAfter("let") {
                    return .init(name: n, kind: "function", line: 0, declaration: decl())
                }
            }
            return nil
        case "swift":
            if let n = nameAfter("func")      { return .init(name: n, kind: "function",  line: 0, declaration: decl()) }
            if let n = nameAfter("class")     { return .init(name: n, kind: "class",     line: 0, declaration: decl()) }
            if let n = nameAfter("struct")    { return .init(name: n, kind: "struct",    line: 0, declaration: decl()) }
            if let n = nameAfter("enum")      { return .init(name: n, kind: "enum",      line: 0, declaration: decl()) }
            if let n = nameAfter("protocol")  { return .init(name: n, kind: "protocol",  line: 0, declaration: decl()) }
            if let n = nameAfter("extension") { return .init(name: n, kind: "extension", line: 0, declaration: decl()) }
            return nil
        case "kotlin":
            if let n = nameAfter("class")     { return .init(name: n, kind: "class",     line: 0, declaration: decl()) }
            if let n = nameAfter("fun")       { return .init(name: n, kind: "function",  line: 0, declaration: decl()) }
            if let n = nameAfter("object")    { return .init(name: n, kind: "class",     line: 0, declaration: decl()) }
            if let n = nameAfter("interface") { return .init(name: n, kind: "interface", line: 0, declaration: decl()) }
            return nil
        default:
            return nil
        }
    }

    static func firstQuoted(in line: String) -> String? {
        for quote in ["'", "\""] {
            if let start = line.range(of: quote),
               let end   = line.range(of: quote, range: start.upperBound..<line.endIndex) {
                return String(line[start.upperBound..<end.lowerBound])
            }
        }
        return nil
    }

    // MARK: - Orchestration

    /// List tracked files via `git -C <repoRoot> ls-files`, then parse each.
    /// Returns [] if git is unavailable or the folder is not a git repo.
    public func run(repoRoot: URL) async -> [RawFileStructure] {
        guard let git = gitURL else { return fallbackEnumerate(repoRoot: repoRoot) }
        let listing: Data
        do {
            let (exit, out, _) = try await launcher.run(
                executable: git,
                arguments: ["-C", repoRoot.path, "ls-files"],
                environment: nil)
            guard exit == 0 else { return fallbackEnumerate(repoRoot: repoRoot) }
            listing = out
        } catch { return fallbackEnumerate(repoRoot: repoRoot) }

        let paths = (String(data: listing, encoding: .utf8) ?? "")
            .split(separator: "\n").map(String.init)
            .filter { p in
                let ext = (p as NSString).pathExtension.lowercased()
                return Self.codeExtensions.contains(ext)
            }

        return parseFiles(paths: paths, repoRoot: repoRoot)
    }

    /// Fallback when git is unavailable: FileManager recursive enumeration.
    private func fallbackEnumerate(repoRoot: URL) -> [RawFileStructure] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: repoRoot,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var paths: [String] = []
        for case let url as URL in enumerator {
            if let name = url.pathComponents.last, ExcludedDirs.names.contains(name) {
                enumerator.skipDescendants(); continue
            }
            let ext = url.pathExtension.lowercased()
            guard Self.codeExtensions.contains(ext) else { continue }
            let rel = url.path.hasPrefix(repoRoot.path + "/")
                ? String(url.path.dropFirst(repoRoot.path.count + 1))
                : url.path
            paths.append(rel)
        }
        return parseFiles(paths: paths.sorted(), repoRoot: repoRoot)
    }

    /// Identifiers followed by `(` that are language keywords, not calls.
    static let nonCallKeywords: Set<String> = [
        "if", "for", "while", "switch", "return", "guard", "catch", "func", "function", "init",
        "super", "self", "Self", "typeof", "await", "try", "case", "throw", "new", "sizeof",
        "fun", "when", "print", "assert", "precondition", "fatalError",
    ]
    static let callRegex = try! NSRegularExpression(pattern: #"\b([A-Za-z_][A-Za-z0-9_]*)\s*\("#)
    static let maxCallsPerFile = 500

    /// Parse a specific set of repo-relative paths (used by incremental scan).
    func parseFiles(paths: [String], repoRoot: URL) -> [RawFileStructure] {
        paths.compactMap { path -> RawFileStructure? in
            let lang = Self.language(for: path)
            let url  = repoRoot.appendingPathComponent(path)
            guard let content = try? String(contentsOf: url, encoding: .utf8) else { return nil }
            var imports: [RawImport] = []
            var symbols: [ScanResult.Symbol] = []
            var calls: [ScanResult.CallRef] = []
            var seenCalls = Set<String>()
            var currentCallable: String? = nil
            var loc = 0
            // Enclosing-type tracking by indentation (the regex extractor has no
            // scope information). A function declared deeper than the nearest open
            // type declaration is that type's method. Conventional formatting is
            // enough for Swift/Kotlin/TS; a mis-indented file just yields
            // top-level functions, which is today's behaviour.
            let typeKinds: Set<String> = ["class", "struct", "enum", "protocol", "extension", "interface"]
            var typeStack: [(indent: Int, name: String)] = []
            func indentOf(_ s: String) -> Int {
                var n = 0
                for ch in s { if ch == " " { n += 1 } else if ch == "\t" { n += 4 } else { break } }
                return n
            }
            for (idx, raw) in content.split(separator: "\n",
                                             omittingEmptySubsequences: false).enumerated() {
                let line = String(raw)
                if !line.trimmingCharacters(in: .whitespaces).isEmpty { loc += 1 }
                if lang == "markdown" {
                    if let sym = Self.markdownHeading(fromLine: line, lineNumber: idx + 1) {
                        symbols.append(sym)
                    }
                } else {
                    if let spec = Self.importSpecifier(fromLine: line, language: lang) {
                        imports.append(RawImport(module: spec))
                    }
                    if let found = Self.symbol(fromLine: line, language: lang) {
                        let indent = indentOf(line)
                        while let top = typeStack.last, top.indent >= indent { typeStack.removeLast() }
                        var kind = found.kind
                        var parent: String? = nil
                        if kind == "function", let top = typeStack.last {
                            kind = "method"
                            parent = top.name
                        }
                        // Keep the declaration: it is the signature the server
                        // uploads as `doc`, so the model can skip opening the file.
                        symbols.append(ScanResult.Symbol(name: found.name, kind: kind, line: idx + 1,
                                                         declaration: found.declaration, parent: parent))
                        if typeKinds.contains(found.kind) { typeStack.append((indent, found.name)) }
                    }
                    if let last = symbols.last, last.line == idx + 1 {
                        // A declaration line opens a new callable (or a type, which closes the current one).
                        if last.kind == "function" { currentCallable = last.name }
                        else if last.kind == "method", let p = last.parent { currentCallable = "\(p).\(last.name)" }
                        else { currentCallable = nil }
                    }
                    if let caller = currentCallable, calls.count < Self.maxCallsPerFile {
                        // Strip a trailing line comment; strings are not stripped (cheap heuristic,
                        // unresolvable names are dropped by the builder anyway).
                        let code = line.components(separatedBy: "//").first ?? line
                        let ns = code as NSString
                        for m in Self.callRegex.matches(in: code, range: NSRange(location: 0, length: ns.length)) {
                            let name = ns.substring(with: m.range(at: 1))
                            guard !Self.nonCallKeywords.contains(name) else { continue }
                            let calleeLast = caller.split(separator: ".").last.map(String.init) ?? caller
                            guard name != calleeLast else { continue }        // no self-recursion edges
                            if seenCalls.insert("\(caller)>\(name)").inserted {
                                calls.append(ScanResult.CallRef(caller: caller, callee: name, line: idx + 1))
                            }
                        }
                    }
                }
            }
            return RawFileStructure(path: path, language: lang, loc: loc,
                                    rawImports: imports, symbols: symbols, calls: calls)
        }
    }
}
