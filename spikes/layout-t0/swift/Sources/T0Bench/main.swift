import Foundation
import GraphCore

// Usage:
//   T0Bench fixtures <dir>                       write one graph JSON per case
//   T0Bench bench <dir> <name> <runs>            time GraphLayoutEngine.layout (quality off),
//                                                write <dir>/<name>.swift.json (positions, radius, community)
//   T0Bench metrics <dir> <name> <positions.bin> LayoutQuality.measure on positions (f64 x,y interleaved, index order)

struct CaseSpec { let name: String; let data: CGData }

func cases() -> [CaseSpec] {
    let small = SyntheticGraph.codebase(modules: 6, filesPerModule: 8, symbolsPerFile: 5)
    let k1 = SyntheticGraph.codebase(modules: 12, filesPerModule: 12, symbolsPerFile: 6)
    let medium = SyntheticGraph.codebase(modules: 14, filesPerModule: 16, symbolsPerFile: 6)
    let k3 = SyntheticGraph.codebase(modules: 20, filesPerModule: 20, symbolsPerFile: 6)
    let large = SyntheticGraph.codebase(modules: 30, filesPerModule: 30, symbolsPerFile: 8)
    let docs = SyntheticGraph.docSet(docs: 60, chunksPerDoc: 8, noisePerChunk: 14)
    let merged = SyntheticGraph.merged(code: medium, doc: docs)
    let frag = SyntheticGraph.fragmented(components: 900)
    let k45 = SyntheticGraph.codebase(modules: 80, filesPerModule: 80, symbolsPerFile: 6)
    return [
        CaseSpec(name: "code-small-288", data: small),
        CaseSpec(name: "code-1k", data: k1),
        CaseSpec(name: "code-medium-1568", data: medium),
        CaseSpec(name: "code-3k", data: k3),
        CaseSpec(name: "code-large-8100", data: large),
        CaseSpec(name: "docs-noisy", data: docs),
        CaseSpec(name: "all-merged", data: merged),
        CaseSpec(name: "fragmented-900", data: frag),
        CaseSpec(name: "code-45k", data: k45),
    ]
}

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { fatalError("missing mode") }

/// Loads a graph fixture written by `fixtures` (or converted from a real graph file)
/// when `name` is not one of the built-in synthetic cases.
func loadFixture(_ path: String) -> CGData {
    let raw = try! Data(contentsOf: URL(fileURLWithPath: path))
    let obj = try! JSONSerialization.jsonObject(with: raw) as! [String: Any]
    let ids = obj["ids"] as! [String]
    let edges = (obj["edges"] as! [[String: Any]]).map { e -> CGEdge in
        CGEdge(fromId: ids[e["f"] as! Int], toId: ids[e["t"] as! Int],
               kind: CGEdgeKind(rawValue: e["k"] as! String)!,
               confidence: CGEdgeConfidence(rawValue: e["c"] as! String)!)
    }
    return CGData(nodes: ids.map { CGNode(id: $0, title: $0, kind: .other) }, edges: edges)
}

var fixtureDir = "."
func lookup(_ name: String) -> CGData {
    if let spec = cases().first(where: { $0.name == name }) { return spec.data }
    return loadFixture("\(fixtureDir)/\(name).graph.json")
}

func indexOf(_ data: CGData) -> [String: Int] {
    var index: [String: Int] = [:]
    for node in data.nodes where index[node.id] == nil { index[node.id] = index.count }
    return index
}

switch mode {
case "fixtures":
    let dir = args[1]
    for spec in cases() {
        let index = indexOf(spec.data)
        var edges: [[String: Any]] = []
        edges.reserveCapacity(spec.data.edges.count)
        for edge in spec.data.edges {
            guard let f = index[edge.fromId], let t = index[edge.toId] else { continue }
            edges.append(["f": f, "t": t, "k": edge.kind.rawValue, "c": edge.confidence.rawValue])
        }
        let obj: [String: Any] = ["name": spec.name, "n": index.count, "ids": spec.data.nodes.map { $0.id }, "edges": edges]
        let out = try! JSONSerialization.data(withJSONObject: obj)
        try! out.write(to: URL(fileURLWithPath: "\(dir)/\(spec.name).graph.json"))
        print("\(spec.name): n=\(index.count) m=\(edges.count)")
    }

case "bench":
    let dir = args[1], name = args[2], runs = Int(args[3]) ?? 5
    fixtureDir = dir
    let data = lookup(name)
    var options = GraphLayoutOptions.automatic(nodeCount: data.nodes.count)
    options.measureQuality = false
    var times: [Double] = []
    var first: GraphLayout?
    var deterministic = true
    for _ in 0..<runs {
        let t0 = DispatchTime.now().uptimeNanoseconds
        let layout = GraphLayoutEngine.layout(data, options: options)
        let t1 = DispatchTime.now().uptimeNanoseconds
        times.append(Double(t1 - t0) / 1e6)
        if let f = first {
            if f.positions != layout.positions { deterministic = false }
        } else { first = layout }
    }
    let layout = first!
    let ids = data.nodes.map { $0.id }
    var flat: [Double] = []
    var radius: [Double] = []
    var community: [Int] = []
    flat.reserveCapacity(ids.count * 2)
    for id in ids {
        let p = layout.positions[id]!
        flat.append(Double(p.x)); flat.append(Double(p.y))
        radius.append(layout.radius[id]!)
        community.append(layout.community[id]!)
    }
    times.sort()
    let median = times[times.count / 2]
    let obj: [String: Any] = ["name": name, "n": ids.count, "runsMs": times, "medianMs": median,
                              "deterministicAcrossRuns": deterministic,
                              "positions": flat, "radius": radius, "community": community,
                              "communityCount": layout.communityCount]
    let out = try! JSONSerialization.data(withJSONObject: obj)
    try! out.write(to: URL(fileURLWithPath: "\(dir)/\(name).swift.json"))
    print("\(name): n=\(ids.count) median=\(String(format: "%.1f", median)) ms runs=\(times.map { String(format: "%.0f", $0) }) deterministic=\(deterministic)")

case "metrics":
    let dir = args[1], name = args[2], path = args[3]
    fixtureDir = dir
    let data = lookup(name)
    let options = GraphLayoutOptions.automatic(nodeCount: data.nodes.count)
    let topology = GraphTopology(data, minWeight: options.minWeight)
    let n = topology.nodeCount
    let importance = topology.pageRank()
    let community = CommunityDetection.louvain(topology, resolution: options.clusterResolution)
    let span = options.maxNodeRadius - options.minNodeRadius
    let radii = (0..<n).map { options.minNodeRadius + span * importance[$0].squareRoot() }
    let raw = try! Data(contentsOf: URL(fileURLWithPath: path))
    let values = raw.withUnsafeBytes { Array($0.bindMemory(to: Double.self)) }
    precondition(values.count == 2 * n, "positions length \(values.count) != 2n")
    let positions = (0..<n).map { CGPoint(x: values[2 * $0], y: values[2 * $0 + 1]) }
    let r = LayoutQuality.measure(positions: positions, radii: radii, topology: topology, community: community)
    let obj: [String: Any] = ["name": name, "radialConcentration": r.radialConcentration,
                              "nodeOverlapRatio": r.nodeOverlapRatio, "edgeLengthCV": r.edgeLengthCV,
                              "modularity": r.modularity, "clusterSeparation": r.clusterSeparation,
                              "componentCount": r.componentCount, "largestComponentShare": r.largestComponentShare,
                              "edgeCrossingRate": r.edgeCrossingRate]
    _ = dir
    print(String(data: try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), encoding: .utf8)!)

default:
    fatalError("unknown mode \(mode)")
}
