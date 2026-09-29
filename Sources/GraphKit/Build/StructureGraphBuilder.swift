import Foundation
import GraphCore
import CoreGraphics

public enum StructureGraphBuilder {

    public static func build(_ scan: ScanResult, repoRoot: URL) -> CGData {
        var nodes:   [CGNode] = []
        var edges:   [CGEdge] = []
        var nodeIds = Set<String>()

        // ── File nodes ───────────────────────────────────────────────────────
        for f in scan.files {
            let id  = "file:\(f.path)"
            let abs = repoRoot.appendingPathComponent(f.path).absoluteString
            let kind: CGNodeKind = f.language == "markdown" ? .docPage : .file
            nodeIds.insert(id)
            nodes.append(CGNode(
                id: id,
                title: (f.path as NSString).lastPathComponent,
                kind: kind,
                position: .zero,
                metadata: ["source_file": f.path, "fileURL": abs,
                           "language": f.language, "loc": String(f.loc)]))
        }

        // ── Symbol nodes + contains edges ────────────────────────────────────
        // Build name→nodeId index for cross-symbol resolution.
        var nameToId: [String: String] = [:]

        for f in scan.files {
            let fileId = "file:\(f.path)"
            let abs    = repoRoot.appendingPathComponent(f.path).absoluteString

            for sym in scan.symbols[f.path] ?? [] {
                let (kind, prefix) = nodeKindAndPrefix(for: sym.kind)
                // Methods are qualified by their parent so two types in one file
                // can both have a `load()`; everything else keeps its old id.
                // The AST/tree-sitter scanners already emit `Cls.meth`; don't re-prefix those.
                var qualified = sym.name
                if sym.kind == "method", let parent = sym.parent, !sym.name.hasPrefix("\(parent).") {
                    qualified = "\(parent).\(sym.name)"
                }
                let id = "\(prefix):\(f.path):\(qualified)"
                guard !nodeIds.contains(id) else { continue }
                nodeIds.insert(id)
                nameToId[sym.name] = id

                var meta: [String: String] = [
                    "source_file": f.path, "fileURL": abs,
                    "line": "L\(sym.line)", "kind": sym.kind
                ]
                if let decl = sym.declaration { meta["declaration"] = decl }
                nodes.append(CGNode(id: id, title: sym.name, kind: kind,
                                    position: .zero, metadata: meta))

                // Method → parent class; everything else → file.
                if sym.kind == "method", let parentName = sym.parent {
                    let parentId = "class:\(f.path):\(parentName)"
                    let owner = nodeIds.contains(parentId) ? parentId : fileId
                    edges.append(CGEdge(fromId: owner, toId: id, kind: .contains,
                                        confidence: .extracted))
                } else {
                    edges.append(CGEdge(fromId: fileId, toId: id, kind: .contains,
                                        confidence: .extracted))
                }
            }
        }

        // ── Import edges (file → file) ────────────────────────────────────────
        for (src, targets) in scan.imports {
            let srcId = "file:\(src)"
            guard nodeIds.contains(srcId) else { continue }
            for t in targets {
                let dstId = "file:\(t)"
                guard nodeIds.contains(dstId) else { continue }
                edges.append(CGEdge(fromId: srcId, toId: dstId, kind: .imports,
                                    confidence: .extracted))
            }
        }

        // ── Inherits edges (child class → parent class) ───────────────────────
        for (filePath, refs) in scan.inherits {
            for ref in refs {
                let childId = "class:\(filePath):\(ref.child)"
                guard nodeIds.contains(childId) else { continue }
                if let parentId = nameToId[ref.parent], nodeIds.contains(parentId) {
                    edges.append(CGEdge(fromId: childId, toId: parentId, kind: .inherits,
                                        confidence: .extracted))
                }
            }
        }

        // ── Implements edges (class → interface/protocol) ─────────────────────
        for (filePath, refs) in scan.implements {
            for ref in refs {
                let classId = "class:\(filePath):\(ref.className)"
                guard nodeIds.contains(classId) else { continue }
                if let ifaceId = nameToId[ref.interfaceName], nodeIds.contains(ifaceId) {
                    edges.append(CGEdge(fromId: classId, toId: ifaceId, kind: .implements,
                                        confidence: .extracted))
                }
            }
        }

        // ── Calls edges (symbol → symbol, INFERRED) ───────────────────────────
        // Resolution order: a symbol of that name in the SAME file, then in files
        // this file imports, then a name defined exactly once in the repo (plain calls only: a
        // receiver-qualified member call never uses that last stage). A name
        // that is ambiguous at the stage that finds it is skipped — a wrong edge
        // is worse than a missing one.
        var idsByFileName: [String: [String: [String]]] = [:]
        var idsByName: [String: [String]] = [:]
        for n in nodes where n.kind == .function || n.kind == .classType {
            guard let path = n.metadata["source_file"] else { continue }
            let key = n.id.split(separator: ":", omittingEmptySubsequences: false).dropFirst(2).joined(separator: ":")   // "name" or "Parent.name"
            let plain = String(key.split(separator: ".").last ?? Substring(key))
            for k in Set([key, plain]) { idsByFileName[path, default: [:]][k, default: []].append(n.id) }
            idsByName[plain, default: []].append(n.id)
        }
        var seenCallEdges = Set<String>()
        for (filePath, refs) in scan.calls {
            for ref in refs {
                guard let callerIds = idsByFileName[filePath]?[ref.caller], callerIds.count == 1 else { continue }
                let callerId = callerIds[0]
                var calleeId: String?
                if let same = idsByFileName[filePath]?[ref.callee] {
                    calleeId = same.count == 1 ? same[0] : nil
                    if same.count > 1 { continue }
                }
                if calleeId == nil {
                    let imported = (scan.imports[filePath] ?? []).flatMap { idsByFileName[$0]?[ref.callee] ?? [] }
                    if imported.count == 1 { calleeId = imported[0] } else if imported.count > 1 { continue }
                }
                if calleeId == nil, !ref.isMember, let global = idsByName[ref.callee], global.count == 1 { calleeId = global[0] }
                guard let callee = calleeId, callee != callerId else { continue }
                guard seenCallEdges.insert("\(callerId)>\(callee)").inserted else { continue }
                edges.append(CGEdge(fromId: callerId, toId: callee, kind: .calls, confidence: .inferred))
            }
        }

        edges += citationEdges(scan, nodes: nodes)

        return CGData(nodes: nodes, edges: edges)
    }

    // MARK: - Doc → code citations

    private static let sourceExtensions: Set<String> =
        FileStructureExtractor.codeExtensions.union(["py"])
    private static let symbolCitation = try! NSRegularExpression(
        pattern: #"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$"#)
    /// `:N`, `:N-M` or `:N:M` (line:col) — stripped before a path is resolved.
    private static let lineSuffix = try! NSRegularExpression(pattern: #":\d+(-\d+|:\d+)?$"#)

    /// `references` edges from a markdown doc to the files (EXTRACTED) and symbols
    /// (INFERRED) it cites. Unknown or ambiguous names emit nothing.
    private static func citationEdges(_ scan: ScanResult, nodes: [CGNode]) -> [CGEdge] {
        guard !scan.citations.isEmpty else { return [] }
        let filePaths = Set(scan.files.map(\.path))
        // "name" / "Parent.name" → ids, and plain last component → ids.
        var byKey: [String: [String]] = [:]
        var byPlain: [String: [String]] = [:]
        // Type declarations vs `extension`s (both map to `.classType`).
        var extensionIds = Set<String>()
        for n in nodes where n.kind == .classType && n.metadata["kind"] == "extension" {
            extensionIds.insert(n.id)
        }
        // A bare filename resolves when exactly one scanned file has that basename.
        var byBasename: [String: [String]] = [:]
        for p in filePaths { byBasename[(p as NSString).lastPathComponent, default: []].append(p) }
        for n in nodes where n.kind == .function || n.kind == .classType {
            let key = n.id.split(separator: ":", omittingEmptySubsequences: false)
                .dropFirst(2).joined(separator: ":")
            let plain = String(key.split(separator: ".").last ?? Substring(key))
            byKey[key, default: []].append(n.id)
            if plain != key { byPlain[plain, default: []].append(n.id) } else { byPlain[key, default: []].append(n.id) }
        }
        func resolvePath(_ raw: String, docPath: String) -> String? {
            var t = raw
            let r = NSRange(location: 0, length: (t as NSString).length)
            if let m = lineSuffix.firstMatch(in: t, range: r) { t = (t as NSString).substring(to: m.range.location) }
            guard !t.isEmpty, !t.contains("://"), !t.hasPrefix("/"), !t.hasPrefix("~"),
                  !t.contains(":"), !t.contains(" ") else { return nil }
            let ext = (t as NSString).pathExtension.lowercased()
            guard t.contains("/") || sourceExtensions.contains(ext) else { return nil }
            func norm(_ p: String) -> String? {
                var parts: [String] = []
                for c in p.split(separator: "/", omittingEmptySubsequences: true) {
                    if c == "." { continue }
                    if c == ".." { guard !parts.isEmpty else { return nil }; parts.removeLast() } else { parts.append(String(c)) }
                }
                return parts.joined(separator: "/")
            }
            if let p = norm(t), filePaths.contains(p) { return p }
            let dir = (docPath as NSString).deletingLastPathComponent
            if let p = norm(dir.isEmpty ? t : dir + "/" + t), filePaths.contains(p) { return p }
            if !t.contains("/"), let hits = byBasename[t], hits.count == 1 { return hits[0] }
            return nil
        }
        var out: [CGEdge] = []
        var seen = Set<String>()
        for f in scan.files where f.language == "markdown" {
            guard let cites = scan.citations[f.path] else { continue }
            let docId = "file:\(f.path)"
            for c in cites {
                if let target = resolvePath(c.text, docPath: f.path) {
                    guard target != f.path else { continue }
                    let to = "file:\(target)"
                    if seen.insert("\(docId)>\(to)").inserted {
                        out.append(CGEdge(fromId: docId, toId: to, kind: .references, confidence: .extracted))
                    }
                    continue
                }
                // `name()` cites the same symbol as `name`.
                let sym = c.text.hasSuffix("()") ? String(c.text.dropLast(2)) : c.text
                let ns = sym as NSString
                guard ns.length >= 4,
                      symbolCitation.firstMatch(in: sym, range: NSRange(location: 0, length: ns.length)) != nil
                else { continue }
                guard var ids = sym.contains(".") ? byKey[sym] : byPlain[sym] else { continue }
                if ids.count > 1, ids.allSatisfy({ $0.hasPrefix("class:") }) {
                    // A type plus its extensions: prefer the one declaration.
                    let decls = ids.filter { !extensionIds.contains($0) }
                    if decls.count == 1 { ids = decls }
                }
                guard ids.count == 1 else { continue }
                if seen.insert("\(docId)>\(ids[0])").inserted {
                    out.append(CGEdge(fromId: docId, toId: ids[0], kind: .references, confidence: .inferred))
                }
            }
        }
        return out
    }

    // MARK: - Helpers

    private static func nodeKindAndPrefix(for symKind: String) -> (CGNodeKind, String) {
        switch symKind {
        case "class", "struct", "enum", "protocol", "interface", "extension":
            return (.classType, "class")
        case "method":
            return (.function, "method")
        case "heading":
            return (.docPage, "heading")
        default:
            return (.function, "function")
        }
    }
}
