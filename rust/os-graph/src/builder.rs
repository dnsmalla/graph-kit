//! System-view graph builder (port of `typescript/src/system/builder.ts`).
//!
//! Pure and deterministic: a dense core made from the project's graph (categorized,
//! community-labelled, capped) plus a ring of recent activity. Every ordering that the
//! TS decides with JavaScript string comparison (`<`, default `sort()`) is decided here
//! with [`js_cmp`], which compares UTF-16 code units, so the output matches TS even for
//! non-BMP identifiers.

use crate::models::{CGData, CGEdge, CGNode};
use crate::snapshot::OsSnapshot;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Core category used by the system view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreCategory {
    Code,
    Docs,
    Tests,
    Knowledge,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCoreNode {
    pub id: String,
    pub label: String,
    pub category: CoreCategory,
    /// Index into the community ordering: 0 = largest community.
    pub community: usize,
    /// Weighted degree within the kept graph.
    pub degree: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCoreEdge {
    pub source: String,
    pub target: String,
    /// Number of original edges collapsed into this one.
    pub weight: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRingItem {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub at: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Truncated {
    pub total_nodes: usize,
    pub kept_nodes: usize,
    pub kept_communities: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemGraph {
    pub core: Vec<SystemCoreNode>,
    pub edges: Vec<SystemCoreEdge>,
    pub ring: Vec<SystemRingItem>,
    pub truncated: Truncated,
}

/// Build options. Fields are `f64` so the JSON numbers the TS accepts (including
/// fractions, which are floored, and negatives, which clamp to 0) behave identically.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOptions {
    /// Maximum number of core nodes kept. Default 4000.
    pub max_core_nodes: Option<f64>,
    /// Maximum number of ring items. Default 24.
    pub max_ring_items: Option<f64>,
}

const DEFAULT_MAX_CORE: f64 = 4000.0;
const DEFAULT_MAX_RING: f64 = 24.0;

const DOC_KINDS: &[&str] = &["docPage", "memoryDoc", "memoryChunk"];

const KNOWLEDGE_KINDS: &[&str] = &[
    "noteDecision",
    "noteTask",
    "noteQuestion",
    "noteFact",
    "noteConcept",
    "notePlaybook",
    "noteHypothesis",
    "noteEvent",
    "noteSource",
    "article",
    "entity",
    "topic",
    "claim",
];

const NON_CODE_KINDS: &[&str] = &["other", "skill", "agent"];

/// JavaScript string ordering: compares UTF-16 code units (`a < b`, default `sort()`).
pub(crate) fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `String(n)` for the JS number types the builder formats (ring item ids).
fn js_number_string(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i128)
    } else {
        format!("{v}")
    }
}

/// Hand-written equivalent of `/(^|[\/._-])(test|tests|spec|__tests__)([\/._-]|$)/i`.
pub(crate) fn matches_test_path(s: &str) -> bool {
    fn is_sep(b: u8) -> bool {
        matches!(b, b'/' | b'.' | b'_' | b'-')
    }
    const WORDS: [&[u8]; 4] = [b"test", b"tests", b"spec", b"__tests__"];
    let bytes = s.as_bytes();
    for start in 0..=bytes.len() {
        if start > 0 && !is_sep(bytes[start - 1]) {
            continue;
        }
        for word in WORDS {
            let end = start + word.len();
            if end <= bytes.len()
                && bytes[start..end].eq_ignore_ascii_case(word)
                && (end == bytes.len() || is_sep(bytes[end]))
            {
                return true;
            }
        }
    }
    false
}

/// Hand-written equivalent of `/\.(md|mdx|txt|rst)$/i`.
pub(crate) fn matches_doc_ext(s: &str) -> bool {
    const EXTS: [&[u8]; 4] = [b".md", b".mdx", b".txt", b".rst"];
    let bytes = s.as_bytes();
    EXTS.iter().any(|ext| {
        bytes.len() >= ext.len() && bytes[bytes.len() - ext.len()..].eq_ignore_ascii_case(ext)
    })
}

/// Non-empty string values of the path metadata keys, in the TS order.
fn node_paths(node: &CGNode) -> Vec<&str> {
    ["source_file", "source_path", "path", "file"]
        .iter()
        .filter_map(|key| node.metadata.get(*key))
        .filter_map(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Classify a node into the core category. First match wins:
/// 1. kind: DOC kinds → docs, KNOWLEDGE kinds → knowledge (title never consulted);
/// 2. a path (metadata source_file / source_path / path / file, or the id) ending in a doc extension → docs;
/// 3. a path or id matching the test pattern → tests;
/// 4. NON_CODE kinds (other, skill, agent) → other; anything else → code.
pub fn categorize(node: &CGNode) -> CoreCategory {
    let kind = node.kind.as_str();
    if DOC_KINDS.contains(&kind) {
        return CoreCategory::Docs;
    }
    if KNOWLEDGE_KINDS.contains(&kind) {
        return CoreCategory::Knowledge;
    }
    let mut locators = node_paths(node);
    locators.push(node.id.as_str());
    if locators.iter().any(|s| matches_doc_ext(s)) {
        return CoreCategory::Docs;
    }
    if locators.iter().any(|s| matches_test_path(s)) {
        return CoreCategory::Tests;
    }
    if NON_CODE_KINDS.contains(&kind) {
        return CoreCategory::Other;
    }
    CoreCategory::Code
}

/// Label propagation over index pairs. `ids` must be unique and in JS-sorted order, so
/// index order is id order. Returns the compacted community of each index: 0 = largest.
fn label_propagate(ids: &[&str], pairs: &[(usize, usize)]) -> Vec<usize> {
    let n = ids.len();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(a, b) in pairs {
        if a == b {
            continue;
        }
        adj[a].push(b);
        adj[b].push(a);
    }

    let mut label: Vec<usize> = (0..n).collect();
    let mut counts = vec![0usize; n];
    let mut touched: Vec<usize> = Vec::new();
    for _ in 0..20 {
        let mut changed = false;
        for id in 0..n {
            if adj[id].is_empty() {
                continue;
            }
            touched.clear();
            for &nb in &adj[id] {
                let l = label[nb];
                if counts[l] == 0 {
                    touched.push(l);
                }
                counts[l] += 1;
            }
            // Most frequent neighbour label; ties go to the smallest label.
            let mut best = touched[0];
            let mut best_count = counts[best];
            for &l in &touched[1..] {
                let c = counts[l];
                if c > best_count || (c == best_count && l < best) {
                    best = l;
                    best_count = c;
                }
            }
            for &l in &touched {
                counts[l] = 0;
            }
            if best != label[id] {
                label[id] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (id, &l) in label.iter().enumerate() {
        groups[l].push(id);
    }
    let mut ordered: Vec<Vec<usize>> = groups.into_iter().filter(|g| !g.is_empty()).collect();
    // Largest first; ties by smallest member id (members are ascending, so [0] is the smallest).
    ordered.sort_by(|x, y| y.len().cmp(&x.len()).then_with(|| x[0].cmp(&y[0])));

    let mut community = vec![0usize; n];
    for (rank, members) in ordered.iter().enumerate() {
        for &m in members {
            community[m] = rank;
        }
    }
    community
}

/// Deterministic label propagation on the undirected graph. Nodes are visited in
/// sorted-id order; each takes the most frequent neighbour label (ties: smallest
/// label). At most 20 passes or until stable. Communities are renumbered 0..k-1 by
/// descending size (ties by smallest member id). Self-loops, unknown ids and
/// duplicate node ids are ignored.
pub fn detect_communities(node_ids: &[&str], edges: &[(&str, &str)]) -> BTreeMap<String, usize> {
    let mut ids: Vec<&str> = {
        let unique: HashSet<&str> = node_ids.iter().copied().collect();
        unique.into_iter().collect()
    };
    ids.sort_by(|a, b| js_cmp(a, b));
    let index: HashMap<&str, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let pairs: Vec<(usize, usize)> = edges
        .iter()
        .filter_map(|(s, t)| Some((*index.get(s)?, *index.get(t)?)))
        .filter(|(a, b)| a != b)
        .collect();
    let community = label_propagate(&ids, &pairs);
    ids.iter()
        .zip(community)
        .map(|(id, c)| (id.to_string(), c))
        .collect()
}

/// Collapsed unordered pair. `source` < `target` in JS order.
struct PairEdge {
    source: String,
    target: String,
    weight: u64,
}

/// Collapse parallel edges into unordered pairs; drop self-loops and dangling edges.
/// The pair key is built exactly like the TS (`a\0b` with a < b), so even ids containing
/// NUL collide the same way they do in TS.
fn collapse_edges(node_ids: &HashSet<&str>, edges: &[CGEdge]) -> Vec<PairEdge> {
    let mut position: HashMap<String, usize> = HashMap::new();
    let mut pairs: Vec<PairEdge> = Vec::new();
    for e in edges {
        if e.from_id == e.to_id {
            continue;
        }
        if !node_ids.contains(e.from_id.as_str()) || !node_ids.contains(e.to_id.as_str()) {
            continue;
        }
        let key = if js_cmp(&e.from_id, &e.to_id) == Ordering::Less {
            format!("{}\u{0}{}", e.from_id, e.to_id)
        } else {
            format!("{}\u{0}{}", e.to_id, e.from_id)
        };
        if let Some(&i) = position.get(&key) {
            pairs[i].weight += 1;
        } else {
            let (source, target) = if js_cmp(&e.from_id, &e.to_id) == Ordering::Less {
                (e.from_id.clone(), e.to_id.clone())
            } else {
                (e.to_id.clone(), e.from_id.clone())
            };
            position.insert(key, pairs.len());
            pairs.push(PairEdge {
                source,
                target,
                weight: 1,
            });
        }
    }
    pairs.sort_by(|a, b| js_cmp(&a.source, &b.source).then_with(|| js_cmp(&a.target, &b.target)));
    pairs
}

/// `Math.max(0, Math.floor(v))`. NaN (not reachable from JSON) clamps to 0.
fn clamp_count(v: f64) -> f64 {
    if v.is_nan() {
        0.0
    } else {
        v.floor().max(0.0)
    }
}

/// `arr.slice(0, limit).length` for a non-negative limit that may exceed `len`.
fn take_count(limit: f64, len: usize) -> usize {
    if limit >= len as f64 {
        len
    } else {
        limit as usize
    }
}

/// Build the system view graph. `project` supplies the core (nodes + edges); `snapshot`
/// supplies the ring of recent activity. Either may be `None`. Capping removes nodes
/// only: every edge between two kept nodes is kept.
///
/// Cap rule (when there are more nodes than `max_core_nodes`): communities are walked
/// largest-first and each is kept whole if it fits in the remaining budget; one that
/// does not fit is skipped and the walk continues. If the largest community alone
/// exceeds the cap, only its `max_core_nodes` highest-degree nodes are kept.
/// `truncated.kept_communities` counts whole communities kept (1 in the partial-trim case,
/// 0 if the cap is 0).
pub fn build_system_graph(
    snapshot: Option<&OsSnapshot>,
    project: Option<&CGData>,
    opts: &BuildOptions,
) -> SystemGraph {
    let max_core = clamp_count(opts.max_core_nodes.unwrap_or(DEFAULT_MAX_CORE));
    let max_ring = clamp_count(opts.max_ring_items.unwrap_or(DEFAULT_MAX_RING));

    let items: &[crate::snapshot::OsActivityItem] =
        snapshot.map_or(&[], |s| s.activity.items.as_slice());
    let ring: Vec<SystemRingItem> = items[..take_count(max_ring, items.len())]
        .iter()
        .map(|item| SystemRingItem {
            id: format!("activity:{}", js_number_string(item.id)),
            label: item.title.clone(),
            kind: item.kind.clone(),
            at: item.created_at.clone(),
            link: item.link.clone(),
        })
        .collect();

    // Dedupe nodes by id (first wins).
    let mut node_by_id: HashMap<&str, &CGNode> = HashMap::new();
    let project_nodes: &[CGNode] = project.map_or(&[], |p| p.nodes.as_slice());
    let project_edges: &[CGEdge] = project.map_or(&[], |p| p.edges.as_slice());
    for n in project_nodes {
        node_by_id.entry(n.id.as_str()).or_insert(n);
    }
    let node_set: HashSet<&str> = node_by_id.keys().copied().collect();
    let pairs = collapse_edges(&node_set, project_edges);

    let mut all_ids: Vec<&str> = node_set.iter().copied().collect();
    all_ids.sort_by(|a, b| js_cmp(a, b));
    let total = all_ids.len();
    let index: HashMap<&str, usize> = all_ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let pair_idx: Vec<(usize, usize, u64)> = pairs
        .iter()
        .map(|p| (index[p.source.as_str()], index[p.target.as_str()], p.weight))
        .collect();

    let plain_pairs: Vec<(usize, usize)> = pair_idx.iter().map(|&(a, b, _)| (a, b)).collect();
    let community = label_propagate(&all_ids, &plain_pairs);
    let community_count = community.iter().max().map_or(0, |m| m + 1);

    // Full-graph weighted degree, used to rank nodes when trimming.
    let mut full_degree = vec![0u64; total];
    for &(a, b, w) in &pair_idx {
        full_degree[a] += w;
        full_degree[b] += w;
    }

    let mut kept = vec![false; total];
    let mut kept_count = 0usize;
    let mut kept_communities = 0usize;
    if (total as f64) <= max_core {
        kept.iter_mut().for_each(|k| *k = true);
        kept_count = total;
        kept_communities = community_count;
    } else {
        let mut members: Vec<Vec<usize>> = vec![Vec::new(); community_count];
        for (i, &c) in community.iter().enumerate() {
            members[c].push(i);
        }
        let largest = &members[0];
        if (largest.len() as f64) > max_core {
            // Partial trim: keep the largest community's highest-degree nodes only.
            let mut ranked = largest.clone();
            ranked.sort_by(|&a, &b| full_degree[b].cmp(&full_degree[a]).then_with(|| a.cmp(&b)));
            for &i in &ranked[..take_count(max_core, ranked.len())] {
                kept[i] = true;
                kept_count += 1;
            }
            kept_communities = usize::from(kept_count > 0);
        } else {
            // Greedy fill, largest first; skip any community that does not fit.
            for group in &members {
                if ((kept_count + group.len()) as f64) > max_core {
                    continue;
                }
                for &i in group {
                    kept[i] = true;
                }
                kept_count += group.len();
                kept_communities += 1;
                if (kept_count as f64) == max_core {
                    break;
                }
            }
        }
    }

    let kept_edges: Vec<&(usize, usize, u64)> = pair_idx
        .iter()
        .filter(|(a, b, _)| kept[*a] && kept[*b])
        .collect();
    let mut degree = vec![0u64; total];
    for &&(a, b, w) in &kept_edges {
        degree[a] += w;
        degree[b] += w;
    }

    let core: Vec<SystemCoreNode> = (0..total)
        .filter(|&i| kept[i])
        .map(|i| {
            let id = all_ids[i];
            let node = node_by_id[id];
            SystemCoreNode {
                id: id.to_string(),
                label: node.title.clone(),
                category: categorize(node),
                community: community[i],
                degree: degree[i],
            }
        })
        .collect();

    let edges: Vec<SystemCoreEdge> = kept_edges
        .iter()
        .map(|&&(a, b, w)| SystemCoreEdge {
            source: all_ids[a].to_string(),
            target: all_ids[b].to_string(),
            weight: w,
        })
        .collect();

    SystemGraph {
        core,
        edges,
        ring,
        truncated: Truncated {
            total_nodes: total,
            kept_nodes: kept_count,
            kept_communities,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CGEdge, CGNode};
    use crate::orbit::mulberry32;
    use crate::snapshot::{OsActivity, OsActivityItem};
    use std::time::Instant;

    fn node(id: &str, kind: &str) -> CGNode {
        CGNode {
            id: id.to_string(),
            title: id.rsplit('/').next().unwrap_or(id).to_string(),
            kind: kind.to_string(),
            position: None,
            metadata: BTreeMap::new(),
        }
    }

    fn node_meta(id: &str, kind: &str, meta: &[(&str, &str)]) -> CGNode {
        let mut n = node(id, kind);
        for (k, v) in meta {
            n.metadata
                .insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
        n
    }

    fn edge(from: &str, to: &str) -> CGEdge {
        CGEdge {
            from_id: from.to_string(),
            to_id: to.to_string(),
            kind: "imports".to_string(),
            confidence: "EXTRACTED".to_string(),
        }
    }

    fn graph(nodes: Vec<CGNode>, edges: Vec<CGEdge>) -> CGData {
        CGData {
            nodes,
            edges,
            layers: vec![],
            tour: vec![],
        }
    }

    fn fixture_snapshot() -> OsSnapshot {
        let item =
            |id: f64, kind: &str, title: &str, link: Option<&str>, at: &str| OsActivityItem {
                id,
                kind: kind.to_string(),
                title: title.to_string(),
                link: link.map(str::to_string),
                created_at: at.to_string(),
            };
        OsSnapshot {
            activity: OsActivity {
                items: vec![
                    item(3.0, "chat", "Third", None, "2026-10-27 09:03:00"),
                    item(2.0, "loop", "Second", Some("/x"), "2026-10-27 09:02:00"),
                    item(1.0, "ingest", "First", None, "2026-10-27 09:01:00"),
                ],
            },
        }
    }

    fn defaults() -> BuildOptions {
        BuildOptions::default()
    }

    fn cap(n: f64) -> BuildOptions {
        BuildOptions {
            max_core_nodes: Some(n),
            max_ring_items: None,
        }
    }

    #[test]
    fn categorize_tests_docs_knowledge_code_other() {
        assert_eq!(
            categorize(&node("src/app/foo.test.ts", "file")),
            CoreCategory::Tests
        );
        assert_eq!(categorize(&node("tests/x.ts", "file")), CoreCategory::Tests);
        assert_eq!(
            categorize(&node("__tests__/x.ts", "file")),
            CoreCategory::Tests
        );
        assert_eq!(categorize(&node("spec/x.rb", "file")), CoreCategory::Tests);
        assert_eq!(
            categorize(&node("src/latest.ts", "file")),
            CoreCategory::Code
        );
        assert_eq!(
            categorize(&node("docs/readme.md", "docPage")),
            CoreCategory::Docs
        );
        assert_eq!(
            categorize(&node("notes/intro.mdx", "file")),
            CoreCategory::Docs
        );
        assert_eq!(categorize(&node("a/b.txt", "file")), CoreCategory::Docs);
        assert_eq!(
            categorize(&node("n:1", "noteDecision")),
            CoreCategory::Knowledge
        );
        assert_eq!(categorize(&node("c:1", "claim")), CoreCategory::Knowledge);
        assert_eq!(
            categorize(&node("src/a.ts", "function")),
            CoreCategory::Code
        );
        assert_eq!(
            categorize(&node_meta(
                "src/a.ts",
                "file",
                &[("source_file", "tests/a.ts")]
            )),
            CoreCategory::Tests
        );
        assert_eq!(categorize(&node("misc", "other")), CoreCategory::Other);
    }

    #[test]
    fn categorize_kind_first_doc_paths_beat_test_dirs_titles_never_scanned() {
        assert_eq!(
            categorize(&node("docs/spec/architecture.md", "file")),
            CoreCategory::Docs
        );
        assert_eq!(
            categorize(&node("docs/tests/x.md", "file")),
            CoreCategory::Docs
        );
        let mut titled = node("n:2", "noteTask");
        titled.title = "unit-test plan".to_string();
        assert_eq!(categorize(&titled), CoreCategory::Knowledge);
        let mut code_titled = node("src/plan.ts", "function");
        code_titled.title = "unit-test plan".to_string();
        assert_eq!(categorize(&code_titled), CoreCategory::Code);
    }

    #[test]
    fn categorize_reads_source_path_path_and_file_metadata() {
        for key in ["source_path", "path", "file"] {
            assert_eq!(
                categorize(&node_meta("src/a.ts", "file", &[(key, "tests/a.ts")])),
                CoreCategory::Tests,
                "key {key}"
            );
        }
        assert_eq!(
            categorize(&node_meta("src/a.ts", "file", &[("file", "src/a.ts")])),
            CoreCategory::Code
        );
    }

    #[test]
    fn categorize_ignores_empty_and_non_string_metadata() {
        let mut n = node("src/a.ts", "file");
        n.metadata.insert(
            "source_file".into(),
            serde_json::Value::String(String::new()),
        );
        n.metadata
            .insert("path".into(), serde_json::json!(["tests/a.ts"]));
        assert_eq!(categorize(&n), CoreCategory::Code);
    }

    #[test]
    fn test_path_edge_cases() {
        let yes = [
            "test",
            "tests",
            "spec",
            "__tests__",
            "/tests",
            "tests/",
            "a/tests/b.ts",
            "a-spec.rb",
            "spec_helper.rb",
            "TEST/x",
            "x.Tests",
            "a..test",
            "__tests__/x",
            "x/__tests__",
        ];
        let no = [
            "",
            "testing/x.ts",
            "contest.ts",
            "latest.ts",
            "respec/x",
            "specification.ts",
            "testsx",
            "src/a.ts",
            "tes/t.ts",
            "attest.ts",
            "my_testing.ts",
        ];
        for s in yes {
            assert!(matches_test_path(s), "expected test path: {s:?}");
        }
        for s in no {
            assert!(!matches_test_path(s), "expected not a test path: {s:?}");
        }
    }

    #[test]
    fn doc_extension_edge_cases() {
        assert!(matches_doc_ext("a.md"));
        assert!(matches_doc_ext("a.MDX"));
        assert!(matches_doc_ext("x/readme.Rst"));
        assert!(matches_doc_ext(".txt"));
        assert!(!matches_doc_ext("md"));
        assert!(!matches_doc_ext("a.md.ts"));
        assert!(!matches_doc_ext("a.mdz"));
        assert!(!matches_doc_ext(""));
    }

    #[test]
    fn js_cmp_orders_by_utf16_code_units() {
        // U+1F600 is the surrogate pair D83D DE00, which sorts before U+E000 in JS
        // but after it in UTF-8 byte order.
        assert_eq!(js_cmp("\u{1F600}", "\u{E000}"), Ordering::Less);
        assert_eq!(js_cmp("a", "b"), Ordering::Less);
        assert_eq!(js_cmp("ab", "a"), Ordering::Greater);
    }

    #[test]
    fn duplicate_node_ids_keep_the_first_occurrence() {
        let mut first = node("dup.ts", "file");
        first.title = "First".into();
        let mut second = node("dup.ts", "function");
        second.title = "Second".into();
        let g = build_system_graph(
            None,
            Some(&graph(
                vec![first, second, node("other.ts", "file")],
                vec![edge("dup.ts", "other.ts")],
            )),
            &defaults(),
        );
        let ids: Vec<&str> = g.core.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["dup.ts", "other.ts"]);
        assert_eq!(g.core[0].label, "First");
        assert_eq!(g.core[0].category, CoreCategory::Code);
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 2,
                kept_nodes: 2,
                kept_communities: 1
            }
        );
        assert_eq!(
            g.edges,
            vec![SystemCoreEdge {
                source: "dup.ts".into(),
                target: "other.ts".into(),
                weight: 1
            }]
        );
    }

    #[test]
    fn communities_tie_goes_to_the_smaller_label() {
        // Two stable triangles (b*, c*) joined only through zm, which is visited last.
        let ids = ["b1", "b2", "b3", "c1", "c2", "c3", "zm"];
        let edges = [
            ("b1", "b2"),
            ("b2", "b3"),
            ("b1", "b3"),
            ("c1", "c2"),
            ("c2", "c3"),
            ("c1", "c3"),
            ("zm", "c2"),
            ("zm", "b2"),
        ];
        let c = detect_communities(&ids, &edges);
        let expected: BTreeMap<String, usize> = [
            ("b1", 0),
            ("b2", 0),
            ("b3", 0),
            ("c1", 1),
            ("c2", 1),
            ("c3", 1),
            ("zm", 0),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect();
        assert_eq!(c, expected);
    }

    #[test]
    fn two_disconnected_triangles_give_two_communities_bigger_first() {
        let ids = ["a1", "a2", "a3", "b1", "b2", "b3", "b4"];
        let edges = [
            ("a1", "a2"),
            ("a2", "a3"),
            ("a1", "a3"),
            ("b1", "b2"),
            ("b2", "b3"),
            ("b1", "b3"),
            ("b3", "b4"),
        ];
        let c = detect_communities(&ids, &edges);
        assert_eq!(c["b1"], 0);
        assert_eq!(c["b4"], 0);
        assert_eq!(c["a1"], 1);
        assert_eq!(c["a2"], 1);
        let distinct: HashSet<usize> = c.values().copied().collect();
        assert_eq!(distinct.len(), 2);
    }

    #[test]
    fn isolated_nodes_get_their_own_community_and_result_is_order_independent() {
        let ids = ["x", "y", "z", "lone", "p", "q", "r", "s"];
        let edges = [
            ("x", "y"),
            ("y", "z"),
            ("x", "z"),
            ("p", "q"),
            ("q", "r"),
            ("r", "s"),
            ("p", "s"),
            ("q", "s"),
        ];
        let first = detect_communities(&ids, &edges);
        let mut rids = ids;
        rids.reverse();
        let mut redges = edges;
        redges.reverse();
        let second = detect_communities(&rids, &redges);
        assert_eq!(first, second);
        assert_ne!(first["lone"], first["x"]);
        assert_ne!(first["lone"], first["p"]);
        assert_eq!(first["lone"], 2, "size-1 group sorts last");
    }

    #[test]
    fn detect_communities_ignores_self_loops_and_unknown_ids() {
        let c = detect_communities(&["a", "b"], &[("a", "a"), ("a", "ghost"), ("ghost", "b")]);
        assert_eq!(c["a"], 0);
        assert_eq!(c["b"], 1);
    }

    #[test]
    fn greedy_fill_keeps_later_communities_that_fit_after_a_larger_one_is_skipped() {
        // Communities: 5-clique, pair, lone. Cap 6: clique fits, pair does not (5+2 > 6),
        // lone does (5+1 = 6).
        let big = ["c1", "c2", "c3", "c4", "c5"];
        let mut nodes: Vec<CGNode> = big.iter().map(|id| node(id, "file")).collect();
        nodes.extend(["s1", "s2", "lone"].iter().map(|id| node(id, "file")));
        let mut edges = Vec::new();
        for i in 0..big.len() {
            for j in i + 1..big.len() {
                edges.push(edge(big[i], big[j]));
            }
        }
        edges.push(edge("s1", "s2"));
        let g = build_system_graph(None, Some(&graph(nodes, edges)), &cap(6.0));
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 8,
                kept_nodes: 6,
                kept_communities: 2
            }
        );
        let mut expected: Vec<&str> = big.to_vec();
        expected.push("lone");
        expected.sort();
        let ids: Vec<&str> = g.core.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, expected);
    }

    #[test]
    fn capping_keeps_the_largest_communities_and_every_edge_between_kept_nodes() {
        let big = ["c1", "c2", "c3", "c4", "c5"];
        let mut nodes: Vec<CGNode> = big.iter().map(|id| node(id, "file")).collect();
        nodes.extend(["s1", "s2", "lone"].iter().map(|id| node(id, "file")));
        let mut edges = Vec::new();
        for i in 0..big.len() {
            for j in i + 1..big.len() {
                edges.push(edge(big[i], big[j]));
            }
        }
        edges.push(edge("s1", "s2"));
        let data = graph(nodes, edges);

        let full = build_system_graph(None, Some(&data), &defaults());
        assert_eq!(full.truncated.total_nodes, 8);

        let capped = build_system_graph(None, Some(&data), &cap(5.0));
        assert_eq!(
            capped.truncated,
            Truncated {
                total_nodes: 8,
                kept_nodes: 5,
                kept_communities: 1
            }
        );
        let mut kept: Vec<&str> = capped.core.iter().map(|n| n.id.as_str()).collect();
        kept.sort();
        assert_eq!(kept, big);
        let weight_sum: u64 = capped.edges.iter().map(|e| e.weight).sum();
        assert_eq!(weight_sum, 10);

        let cap7 = build_system_graph(None, Some(&data), &cap(7.0));
        assert_eq!(
            cap7.truncated,
            Truncated {
                total_nodes: 8,
                kept_nodes: 7,
                kept_communities: 2
            }
        );
        assert_eq!(cap7.edges.iter().map(|e| e.weight).sum::<u64>(), 11);

        let cap8 = build_system_graph(None, Some(&data), &cap(8.0));
        assert_eq!(
            cap8.truncated,
            Truncated {
                total_nodes: 8,
                kept_nodes: 8,
                kept_communities: 3
            }
        );
    }

    #[test]
    fn oversized_largest_community_is_trimmed_by_highest_degree() {
        let ids = ["hub", "a", "b", "c", "d"];
        let nodes: Vec<CGNode> = ids.iter().map(|id| node(id, "file")).collect();
        let edges: Vec<CGEdge> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| edge("hub", id))
            .collect();
        let g = build_system_graph(None, Some(&graph(nodes, edges)), &cap(2.0));
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 5,
                kept_nodes: 2,
                kept_communities: 1
            }
        );
        assert!(g.core.iter().any(|n| n.id == "hub"));
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn cap_zero_keeps_nothing_and_zero_communities() {
        let g = build_system_graph(
            None,
            Some(&graph(vec![node("a", "file")], vec![])),
            &cap(0.0),
        );
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 1,
                kept_nodes: 0,
                kept_communities: 0
            }
        );
        assert!(g.core.is_empty());
    }

    #[test]
    fn null_inputs_give_an_empty_graph() {
        let g = build_system_graph(None, None, &defaults());
        assert!(g.core.is_empty());
        assert!(g.edges.is_empty());
        assert!(g.ring.is_empty());
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 0,
                kept_nodes: 0,
                kept_communities: 0
            }
        );
    }

    #[test]
    fn duplicate_edges_collapse_to_weight_two_and_reversed_direction_counts_too() {
        let g = build_system_graph(
            None,
            Some(&graph(
                vec![node("a", "file"), node("b", "file")],
                vec![edge("a", "b"), edge("b", "a")],
            )),
            &defaults(),
        );
        assert_eq!(
            g.edges,
            vec![SystemCoreEdge {
                source: "a".into(),
                target: "b".into(),
                weight: 2
            }]
        );
        assert_eq!(g.core[0].degree, 2);
    }

    #[test]
    fn self_loops_and_dangling_edges_are_dropped() {
        let g = build_system_graph(
            None,
            Some(&graph(
                vec![node("a", "file"), node("b", "file")],
                vec![edge("a", "a"), edge("a", "missing"), edge("a", "b")],
            )),
            &defaults(),
        );
        assert_eq!(
            g.edges,
            vec![SystemCoreEdge {
                source: "a".into(),
                target: "b".into(),
                weight: 1
            }]
        );
    }

    #[test]
    fn core_is_sorted_by_id_with_categories_and_edges_sorted() {
        let g = build_system_graph(
            None,
            Some(&graph(
                vec![
                    node("z.ts", "file"),
                    node("a.test.ts", "file"),
                    node("m.md", "docPage"),
                ],
                vec![edge("z.ts", "m.md"), edge("a.test.ts", "z.ts")],
            )),
            &defaults(),
        );
        let ids: Vec<&str> = g.core.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["a.test.ts", "m.md", "z.ts"]);
        let cats: Vec<CoreCategory> = g.core.iter().map(|n| n.category).collect();
        assert_eq!(
            cats,
            [CoreCategory::Tests, CoreCategory::Docs, CoreCategory::Code]
        );
        let pairs: Vec<(&str, &str)> = g
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str()))
            .collect();
        assert_eq!(pairs, [("a.test.ts", "z.ts"), ("m.md", "z.ts")]);
    }

    #[test]
    fn ring_respects_max_ring_items_and_keeps_snapshot_order() {
        let snap = fixture_snapshot();
        let all = build_system_graph(Some(&snap), None, &defaults());
        let ids: Vec<&str> = all.ring.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["activity:3", "activity:2", "activity:1"]);
        let labels: Vec<&str> = all.ring.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, ["Third", "Second", "First"]);
        assert_eq!(all.ring[1].link.as_deref(), Some("/x"));
        assert_eq!(all.ring[0].at, "2026-10-27 09:03:00");
        assert_eq!(all.ring[0].link, None);

        let two = build_system_graph(
            Some(&snap),
            None,
            &BuildOptions {
                max_core_nodes: None,
                max_ring_items: Some(2.0),
            },
        );
        assert_eq!(two.ring.len(), 2);
        assert_eq!(two.ring[1].id, "activity:2");

        let none = build_system_graph(
            Some(&snap),
            None,
            &BuildOptions {
                max_core_nodes: None,
                max_ring_items: Some(0.0),
            },
        );
        assert!(none.ring.is_empty());
    }

    #[test]
    fn ring_ids_use_js_number_formatting_and_negative_limits_clamp() {
        let mut snap = fixture_snapshot();
        snap.activity.items[0].id = 12345678901234.0;
        let g = build_system_graph(
            Some(&snap),
            None,
            &BuildOptions {
                max_core_nodes: None,
                max_ring_items: Some(-5.0),
            },
        );
        assert!(g.ring.is_empty());
        let g = build_system_graph(
            Some(&snap),
            None,
            &BuildOptions {
                max_core_nodes: None,
                max_ring_items: Some(1.9),
            },
        );
        assert_eq!(g.ring[0].id, "activity:12345678901234");
    }

    #[test]
    fn building_is_deterministic() {
        let snap = fixture_snapshot();
        let project = graph(
            vec![
                node("a.ts", "file"),
                node("b.ts", "file"),
                node("c.ts", "file"),
            ],
            vec![edge("a.ts", "b.ts"), edge("b.ts", "c.ts")],
        );
        assert_eq!(
            build_system_graph(Some(&snap), Some(&project), &defaults()),
            build_system_graph(Some(&snap), Some(&project), &defaults())
        );
    }

    /// Seeded graph used by the perf smoke: `nodes` ids in `n` communities, `edges` random pairs.
    fn synthetic(nodes: usize, edges: usize, seed: f64) -> CGData {
        let mut rng = mulberry32(seed);
        let ns: Vec<CGNode> = (0..nodes)
            .map(|i| node(&format!("n{i:05}.ts"), "file"))
            .collect();
        let es: Vec<CGEdge> = (0..edges)
            .map(|_| {
                let a = (rng() * nodes as f64) as usize;
                let b = (rng() * nodes as f64) as usize;
                edge(&ns[a].id, &ns[b].id)
            })
            .collect();
        graph(ns, es)
    }

    #[test]
    fn perf_smoke_150k_nodes_no_edges_caps_quickly() {
        let nodes: Vec<CGNode> = (0..150_000)
            .map(|i| node(&format!("n{i}"), "file"))
            .collect();
        let data = graph(nodes, vec![]);
        let started = Instant::now();
        let g = build_system_graph(None, Some(&data), &cap(4000.0));
        let elapsed = started.elapsed();
        assert_eq!(
            g.truncated,
            Truncated {
                total_nodes: 150_000,
                kept_nodes: 4000,
                kept_communities: 4000
            }
        );
        assert_eq!(g.core.len(), 4000);
        if !cfg!(debug_assertions) {
            assert!(elapsed.as_secs_f64() < 2.0, "took {elapsed:?}");
        }
        eprintln!("builder 150k/0 edges cap 4000: {elapsed:?}");
    }

    #[test]
    fn perf_smoke_20k_nodes_60k_edges_builds_quickly() {
        let data = synthetic(20_000, 60_000, 99.0);
        let started = Instant::now();
        let g = build_system_graph(None, Some(&data), &defaults());
        let elapsed = started.elapsed();
        assert_eq!(g.truncated.total_nodes, 20_000);
        assert_eq!(g.truncated.kept_nodes, 4000, "default cap");
        if !cfg!(debug_assertions) {
            assert!(elapsed.as_secs_f64() < 2.0, "took {elapsed:?}");
        }
        eprintln!("builder 20k/60k: {elapsed:?}");
    }
}
