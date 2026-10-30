import Foundation
import CoreGraphics
import GraphCore

/// Cross-implementation conformance for the shared Rust layout kernel (`rust/graph-layout`).
///
/// `--emit-conformance <dir> [--large]` writes, per case, the kernel's binary input
/// (`<name>.in.bin`) and Swift's own result in the kernel's binary OUTPUT format
/// (`<name>.swift.bin`). Any implementation that writes `<name>.<suffix>.bin` in that format
/// can then be checked with `--verify-conformance <dir> <suffix>`: structure must match
/// exactly, positions within `positionTolerance`, and the lab's LayoutQuality metrics within
/// `metricTolerance`. See rust/graph-layout/README.md for why these tolerances.
///
/// Input  (LE): u32 n | u32 m | u8 kindCount | kindCount x (u8 len, name) |
///              m x (u32 from, u32 to, u8 kindIndex, u8 confidence 0/1/2)
/// Output (LE): u32 n | u32 linkCount | u32 communityCount |
///              n x (f64 x, f64 y, f64 radius, u32 community, u32 degree, u32 inDegree) |
///              linkCount x f64 weight
enum Conformance {
    /// Max distance between two implementations' positions for one node, in layout units.
    /// Native Rust is measured bit-identical to Swift; wasm32 differs by up to 8e-4 at 45k
    /// nodes (libm sin/cos/pow), so 0.01 is ~12x the worst observed and still invisible.
    static let positionTolerance = 0.01

    struct Case { let name: String; let data: CGData }

    static func cases(schemaDir: String, large: Bool) -> [Case] {
        var out: [Case] = []
        for file in ["sample", "memory", "merge-code"] {
            let url = URL(fileURLWithPath: "\(schemaDir)/\(file).json")
            guard let raw = try? Data(contentsOf: url),
                  let doc = try? JSONDecoder().decode(GraphDocument.self, from: raw) else { continue }
            out.append(Case(name: "schema-\(file)",
                            data: CGData(nodes: doc.nodes, edges: doc.edges,
                                         layers: doc.layers, tour: doc.tour)))
        }
        let small = SyntheticGraph.codebase(modules: 6, filesPerModule: 8, symbolsPerFile: 5)
        let k1 = SyntheticGraph.codebase(modules: 12, filesPerModule: 12, symbolsPerFile: 6)
        let medium = SyntheticGraph.codebase(modules: 14, filesPerModule: 16, symbolsPerFile: 6)
        let docs = SyntheticGraph.docSet(docs: 60, chunksPerDoc: 8, noisePerChunk: 14)
        out += [
            Case(name: "code-small-288", data: small),
            Case(name: "code-1k", data: k1),
            Case(name: "docs-noisy", data: docs),
            Case(name: "all-merged", data: SyntheticGraph.merged(code: medium, doc: docs)),
            Case(name: "fragmented-900", data: SyntheticGraph.fragmented(components: 900)),
        ]
        if large {
            out += [
                Case(name: "code-large-8100",
                     data: SyntheticGraph.codebase(modules: 30, filesPerModule: 30, symbolsPerFile: 8)),
                Case(name: "code-45k",
                     data: SyntheticGraph.codebase(modules: 80, filesPerModule: 80, symbolsPerFile: 6)),
            ]
        }
        return out
    }

    // MARK: Binary writers

    static func put32(_ d: inout Data, _ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
    static func putF(_ d: inout Data, _ v: Double) { var x = v.bitPattern.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }

    static func encodeInput(_ data: CGData, topology: GraphTopology) -> Data {
        var kinds: [String] = []
        var kindIndex: [String: Int] = [:]
        var rows = Data()
        var m: UInt32 = 0
        for e in data.edges {
            guard let f = topology.indexById[e.fromId], let t = topology.indexById[e.toId] else { continue }
            let k = e.kind.rawValue
            if kindIndex[k] == nil { kindIndex[k] = kinds.count; kinds.append(k) }
            put32(&rows, UInt32(f)); put32(&rows, UInt32(t))
            rows.append(UInt8(kindIndex[k]!))
            rows.append(e.confidence == .extracted ? 0 : e.confidence == .inferred ? 1 : 2)
            m += 1
        }
        var d = Data()
        put32(&d, UInt32(topology.nodeCount)); put32(&d, m)
        d.append(UInt8(kinds.count))
        for k in kinds { d.append(UInt8(k.utf8.count)); d.append(contentsOf: Array(k.utf8)) }
        d.append(rows)
        return d
    }

    static func encodeOutput(positions: [CGPoint], radius: [Double], community: [Int],
                             communityCount: Int, topology: GraphTopology) -> Data {
        var d = Data()
        put32(&d, UInt32(positions.count)); put32(&d, UInt32(topology.links.count))
        put32(&d, UInt32(communityCount))
        for i in 0..<positions.count {
            putF(&d, Double(positions[i].x)); putF(&d, Double(positions[i].y)); putF(&d, radius[i])
            put32(&d, UInt32(community[i])); put32(&d, UInt32(topology.degree[i]))
            put32(&d, UInt32(topology.inDegree[i]))
        }
        for l in topology.links { putF(&d, l.weight) }
        return d
    }

    struct Decoded {
        var positions: [CGPoint] = []
        var radius: [Double] = []
        var community: [Int] = []
        var degree: [Int] = []
        var inDegree: [Int] = []
        var weights: [Double] = []
        var communityCount = 0
    }

    static func decodeOutput(_ raw: Data) -> Decoded? {
        let bytes = [UInt8](raw)
        guard bytes.count >= 12 else { return nil }
        func u32(_ o: Int) -> Int { Int(UInt32(bytes[o]) | UInt32(bytes[o+1]) << 8 | UInt32(bytes[o+2]) << 16 | UInt32(bytes[o+3]) << 24) }
        func f64(_ o: Int) -> Double {
            var v: UInt64 = 0
            for i in 0..<8 { v |= UInt64(bytes[o + i]) << (8 * UInt64(i)) }
            return Double(bitPattern: v)
        }
        let n = u32(0), links = u32(4)
        guard bytes.count == 12 + n * 36 + links * 8 else { return nil }
        var r = Decoded()
        r.communityCount = u32(8)
        for i in 0..<n {
            let o = 12 + i * 36
            r.positions.append(CGPoint(x: f64(o), y: f64(o + 8)))
            r.radius.append(f64(o + 16)); r.community.append(u32(o + 24))
            r.degree.append(u32(o + 28)); r.inDegree.append(u32(o + 32))
        }
        for i in 0..<links { r.weights.append(f64(12 + n * 36 + i * 8)) }
        return r
    }

    // MARK: Modes

    static func emit(dir: String, schemaDir: String, large: Bool) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for c in cases(schemaDir: schemaDir, large: large) {
            var options = GraphLayoutOptions.automatic(nodeCount: c.data.nodes.count)
            options.measureQuality = false
            let layout = GraphLayoutEngine.layout(c.data, options: options)
            let topology = GraphTopology(c.data, minWeight: options.minWeight)
            let ids = topology.idByIndex
            let out = encodeOutput(positions: ids.map { layout.positions[$0]! },
                                   radius: ids.map { layout.radius[$0]! },
                                   community: ids.map { layout.community[$0]! },
                                   communityCount: layout.communityCount, topology: topology)
            try! encodeInput(c.data, topology: topology).write(to: URL(fileURLWithPath: "\(dir)/\(c.name).in.bin"))
            try! out.write(to: URL(fileURLWithPath: "\(dir)/\(c.name).swift.bin"))
            print("emitted \(c.name): n=\(topology.nodeCount) links=\(topology.links.count)")
        }
    }

    /// Returns the number of failed cases.
    static func verify(dir: String, suffix: String, schemaDir: String) -> Int {
        var failed = 0
        var checked = 0
        let names = ["ring", "overlap", "edgeCV", "Q", "sep", "comps", "largest", "cross"]
        print("conformance: swift vs \(suffix)  (position tol \(positionTolerance), metric tol 1e-6 rel / 3n abs for sampled-count metrics)")
        for c in cases(schemaDir: schemaDir, large: true) {
            let swiftURL = URL(fileURLWithPath: "\(dir)/\(c.name).swift.bin")
            let otherURL = URL(fileURLWithPath: "\(dir)/\(c.name).\(suffix).bin")
            guard let sRaw = try? Data(contentsOf: swiftURL), let oRaw = try? Data(contentsOf: otherURL) else { continue }
            checked += 1
            guard let s = decodeOutput(sRaw), let o = decodeOutput(oRaw) else {
                print("FAIL \(c.name): malformed output buffer"); failed += 1; continue
            }
            var problems: [String] = []
            let n = s.positions.count
            if o.positions.count != n { problems.append("node count \(o.positions.count) != \(n)") }
            else {
                if s.communityCount != o.communityCount { problems.append("communityCount") }
                if s.community != o.community { problems.append("community ids differ") }
                if s.degree != o.degree || s.inDegree != o.inDegree { problems.append("degree/inDegree differ") }
                if s.weights.count != o.weights.count { problems.append("link count \(o.weights.count) != \(s.weights.count)") }
                else if zip(s.weights, o.weights).contains(where: { abs($0 - $1) > 1e-12 }) { problems.append("link weights differ") }
                if zip(s.radius, o.radius).contains(where: { abs($0 - $1) > 1e-9 }) { problems.append("radius differs") }
                var maxDist = 0.0
                for i in 0..<n {
                    maxDist = max(maxDist, hypot(Double(s.positions[i].x - o.positions[i].x),
                                                 Double(s.positions[i].y - o.positions[i].y)))
                }
                if !(maxDist <= positionTolerance) { problems.append("max position error \(maxDist) > \(positionTolerance)") }

                let options = GraphLayoutOptions.automatic(nodeCount: n)
                let topology = GraphTopology(c.data, minWeight: options.minWeight)
                func report(_ p: Decoded) -> [Double] {
                    let r = LayoutQuality.measure(positions: p.positions, radii: p.radius,
                                                  topology: topology, community: p.community)
                    return [r.radialConcentration, r.nodeOverlapRatio, r.edgeLengthCV, r.modularity,
                            r.clusterSeparation, Double(r.componentCount), r.largestComponentShare,
                            r.edgeCrossingRate]
                }
                let a = report(s), b = report(o)
                // overlap (1) and crossing (7) are counts over a threshold: a sub-pixel shift can
                // flip a touching pair, so they get an absolute slack of 3 nodes' worth.
                for k in 0..<a.count {
                    let tol = (k == 1 || k == 7) ? max(1e-6, 3.0 / Double(max(n, 1))) : max(1e-9, 1e-6 * abs(a[k]))
                    if abs(a[k] - b[k]) > tol { problems.append("metric \(names[k]): \(a[k]) vs \(b[k])") }
                }
                let line = String(format: "%-16@ n=%-6d maxPosErr=%.3g  ring %.3f/%.3f overlap %.4f/%.4f Q %.4f/%.4f",
                                  c.name as NSString, n, maxDist, a[0], b[0], a[1], b[1], a[3], b[3])
                print(problems.isEmpty ? "ok   \(line)" : "FAIL \(line)")
            }
            if !problems.isEmpty {
                failed += 1
                for p in problems { print("       - \(p)") }
            }
        }
        if checked == 0 { print("FAIL: no <name>.\(suffix).bin files found in \(dir)"); return 1 }
        print(failed == 0 ? "conformance OK (\(checked) cases)" : "conformance FAILED (\(failed) of \(checked))")
        return failed
    }
}
