// swift-tools-version: 5.9
// T0 layout spike: Swift baseline harness. Depends on the graph-kit root
// package (GraphCore, read-only) and reuses the lab's SyntheticGraph generator
// (copied verbatim; `cmp` against Sources/GraphLayoutLab/SyntheticGraph.swift).
import PackageDescription

let package = Package(
    name: "LayoutT0",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../../..")],
    targets: [
        .executableTarget(
            name: "T0Bench",
            dependencies: [.product(name: "GraphCore", package: "graph-kit")],
            path: "Sources/T0Bench"
        ),
    ]
)
