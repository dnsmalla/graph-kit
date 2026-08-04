import type { CGData, CGNode, CGNodeKind, CGEdge, CGEdgeKind } from "../models.js";

/** Read a foreign-JSON field tolerating snake_case or camelCase. */
function field<T = unknown>(o: Record<string, unknown> | undefined, snake: string, camel: string): T | undefined {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake] as T;
  return o[camel] as T | undefined;
}

/** SCIP SymbolKind (subset) → canonical node kind. */
function kindFromScip(kind: number | undefined): CGNodeKind {
  switch (kind) {
    case 7: return "classType";        // Class
    case 9: return "classType";        // Constructor
    case 17: return "function";        // Function
    case 26: return "function";        // Method
    case 5: return "module";           // Namespace/Module
    case 13: return "module";          // Package
    default: return "symbol";
  }
}

/** Normalize an occurrence's range into {startLine,endLine} from any SCIP range form. */
function occLines(occ: Record<string, unknown>): { startLine: number; endLine: number } {
  const arr = field<number[]>(occ, "range", "range");
  if (Array.isArray(arr) && arr.length >= 4 && typeof arr[0] === "number" && typeof arr[2] === "number") {
    return { startLine: arr[0], endLine: arr[2] };
  }
  const sl = field<{ line: number }>(occ, "single_line_range", "singleLineRange");
  if (sl) return { startLine: sl.line, endLine: sl.line };
  const ml = field<{ start: { line: number }; end: { line: number } }>(occ, "multi_line_range", "multiLineRange");
  if (ml) return { startLine: ml.start.line, endLine: ml.end.line };
  return { startLine: 0, endLine: 0 };
}

export function parseScipJson(index: unknown): CGData {
  const idx = index as Record<string, unknown>;
  const documents = (field<unknown[]>(idx, "documents", "documents") ?? []) as Record<string, unknown>[];
  const nodes: CGNode[] = [];
  const edges: CGEdge[] = [];
  const seenDef = new Set<string>();
  const seenEdge = new Set<string>();

  const addEdge = (fromId: string, toId: string, kind: CGEdgeKind) => {
    const key = `${fromId}${toId}${kind}`;
    if (fromId === toId || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence: "EXTRACTED" });
  };

  for (const doc of documents) {
    const sourceFile = field<string>(doc, "relative_path", "relativePath") ?? "";
    const language = field<string>(doc, "language", "language") ?? "";
    const symbols = (field<unknown[]>(doc, "symbols", "symbols") ?? []) as Record<string, unknown>[];
    const occurrences = (field<unknown[]>(doc, "occurrences", "occurrences") ?? []) as Record<string, unknown>[];

    // Definition nodes (as in Task 1) …
    for (const sym of symbols) {
      const symbolId = field<string>(sym, "symbol", "symbol") ?? "";
      const displayName = field<string>(sym, "display_name", "displayName");
      const kind = field<number>(sym, "kind", "kind");
      const documentation = field<string[]>(sym, "documentation", "documentation");

      // Definition occurrence for this symbol in this document (role bit 0x1)
      const def = occurrences.find((o) => {
        const roles = field<number>(o, "symbol_roles", "symbolRoles") ?? 0;
        return field<string>(o, "symbol", "symbol") === symbolId && (roles & 0x1) !== 0;
      });
      const lines = def ? occLines(def) : { startLine: 0, endLine: 0 };
      if (!seenDef.has(symbolId)) {
        seenDef.add(symbolId);
        nodes.push({
          id: symbolId,
          title: displayName ?? symbolId.split(" ").pop() ?? symbolId,
          kind: kindFromScip(kind),
          metadata: {
            source_file: sourceFile,
            fileURL: `file://${sourceFile}`,
            line: `L${lines.startLine}`,
            language,
            ...(documentation?.length ? { doc: documentation.join("\n") } : {}),
            extracted_by: "scip",
          },
        });
      }
      // Record this symbol's definition range for enclosure matching
      (sym as Record<string, unknown> & { __defLines?: { startLine: number; endLine: number } }).__defLines = lines;
    }

    // Reference edges: each non-definition occurrence → enclosing definition
    for (const occ of occurrences) {
      const roles = field<number>(occ, "symbol_roles", "symbolRoles") ?? 0;
      if ((roles & 0x1) !== 0) continue; // skip definitions
      const target = field<string>(occ, "symbol", "symbol");
      if (!target) continue;
      const occRange = occLines(occ);
      // Find the symbol whose definition range encloses this occurrence (line containment)
      const enclosing = symbols.find((s) => {
        const dl = (s as Record<string, unknown> & { __defLines?: { startLine: number; endLine: number } }).__defLines;
        const symbolId = field<string>(s, "symbol", "symbol");
        return dl && occRange.startLine >= dl.startLine && occRange.startLine <= dl.endLine && symbolId !== target;
      });
      if (!enclosing) continue;
      const enclosingId = field<string>(enclosing, "symbol", "symbol") ?? "";
      const edgeKind: CGEdgeKind = (roles & 0x2) !== 0 ? "imports" : "references";
      addEdge(enclosingId, target, edgeKind);
    }
  }

  return { nodes, edges, layers: [], tour: [] };
}
