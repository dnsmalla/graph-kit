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

        return CGData(nodes: nodes, edges: edges)
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
