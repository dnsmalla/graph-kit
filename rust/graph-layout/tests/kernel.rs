//! Kernel contract tests. Cross-implementation conformance against Swift lives in
//! `scripts/layout-conformance.sh`; these pin the contract the Swift engine states.

use graph_layout::{base_weight, layout, parse, run_bytes, Input, Topology};

/// Every `CGEdgeKind` raw value in `Sources/GraphCore/Model/CodeGraphModels.swift`.
const ALL_KINDS: [&str; 37] = [
    "imports", "exports", "contains", "inherits", "implements", "calls", "subscribes", "publishes",
    "middleware", "readsFrom", "writesTo", "transforms", "validates", "dependsOn", "testedBy",
    "configures", "relatedTo", "similarTo", "deploys", "serves", "provisions", "triggers",
    "migrates", "documents", "routes", "definesSchema", "containsFlow", "flowStep", "crossDomain",
    "cites", "contradicts", "buildsOn", "exemplifies", "categorizedUnder", "authoredBy", "defines",
    "references",
];

fn input(n: usize, edges: &[(u32, u32, &str, u8)]) -> Input {
    let mut kinds: Vec<String> = Vec::new();
    let mut es = Vec::new();
    for &(f, t, k, c) in edges {
        let ki = kinds.iter().position(|x| x == k).unwrap_or_else(|| {
            kinds.push(k.to_string());
            kinds.len() - 1
        });
        es.push((f, t, ki as u8, c));
    }
    Input { n, edges: es, kinds }
}

fn encode(inp: &Input) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend((inp.n as u32).to_le_bytes());
    b.extend((inp.edges.len() as u32).to_le_bytes());
    b.push(inp.kinds.len() as u8);
    for k in &inp.kinds {
        b.push(k.len() as u8);
        b.extend(k.as_bytes());
    }
    for &(f, t, k, c) in &inp.edges {
        b.extend(f.to_le_bytes());
        b.extend(t.to_le_bytes());
        b.push(k);
        b.push(c);
    }
    b
}

fn ring_with_hub(n: u32) -> Input {
    let mut e = Vec::new();
    for i in 0..n {
        e.push((i, (i + 1) % n, "calls", 0));
        e.push((0, i, "contains", 0));
    }
    input(n as usize, &e)
}

#[test]
fn every_swift_edge_kind_has_a_weight() {
    for k in ALL_KINDS {
        assert!(base_weight(k).is_some(), "missing weight for {k}");
    }
    assert!(base_weight("nonsense").is_none());
}

#[test]
fn empty_graph_is_not_a_panic() {
    let out = layout(&input(0, &[]));
    assert!(out.pos.is_empty());
}

#[test]
fn edgeless_graph_still_places_every_node_finitely() {
    let out = layout(&input(5, &[]));
    assert_eq!(out.pos.len(), 5);
    assert!(out.pos.iter().all(|p| p.0.is_finite() && p.1.is_finite()));
}

#[test]
fn layout_is_deterministic() {
    let a = run_bytes(&encode(&ring_with_hub(120))).unwrap();
    let b = run_bytes(&encode(&ring_with_hub(120))).unwrap();
    assert_eq!(a, b);
}

#[test]
fn edges_are_weighted_never_degree_capped() {
    // Swift's only filter is the 0.30 weight floor; there is no degree cap (the old
    // capDegree(6) deleted 82-100% of dependency edges). A 50-spoke hub keeps all 50 links,
    // and a low-confidence edge keeps its reduced weight (calls 0.80 x AMBIGUOUS 0.45 = 0.36).
    let mut e: Vec<(u32, u32, &str, u8)> = (1..=50).map(|i| (0, i, "calls", 0)).collect();
    e.push((1, 2, "calls", 2));
    e.push((2, 3, "similarTo", 0)); // 0.20 < floor: dropped, exactly as Swift does
    let topo = Topology::build(&input(51, &e), 0.30);
    assert_eq!(topo.links.len(), 50 + 1);
    let weak = topo.links.iter().find(|l| l.source == 1 && l.target == 2).unwrap();
    assert!((weak.weight - 0.36).abs() < 1e-12);
    assert_eq!(topo.degree[0], 50);
}

#[test]
fn parallel_edges_collapse_to_one_link_and_skip_self_loops() {
    let inp = input(2, &[(0, 1, "calls", 0), (1, 0, "imports", 0), (0, 0, "calls", 0)]);
    let topo = Topology::build(&inp, 0.30);
    assert_eq!(topo.links.len(), 1);
}

#[test]
fn out_of_range_endpoints_are_ignored() {
    let out = layout(&input(2, &[(0, 9, "calls", 0), (0, 1, "calls", 0)]));
    assert_eq!(out.pos.len(), 2);
}

#[test]
fn parse_rejects_truncated_and_unknown_kind() {
    let bytes = encode(&ring_with_hub(10));
    assert!(parse(&bytes[..bytes.len() - 3]).is_err());
    let bad = input(2, &[(0, 1, "bogusKind", 0)]);
    assert!(parse(&encode(&bad)).is_err());
}

#[test]
fn connected_clusters_end_up_with_no_node_overlap() {
    let out = layout(&ring_with_hub(200));
    let n = out.pos.len();
    let mut overlaps = 0;
    for i in 0..n {
        for j in (i + 1)..n {
            let (dx, dy) = (out.pos[i].0 - out.pos[j].0, out.pos[i].1 - out.pos[j].1);
            if (dx * dx + dy * dy).sqrt() < (out.radius[i] + out.radius[j]) * 0.9 {
                overlaps += 1;
            }
        }
    }
    assert_eq!(overlaps, 0);
}
