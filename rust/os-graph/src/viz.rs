//! The whole OS as one interactive graph, plus one graph per part (`VizGraph`).
//!
//! Every view the page draws is a [`VizGraph`]: one generic type, laid out by
//! [`crate::api::viz_layout_json`] and rendered by the page. [`build_os_graph`] is the top
//! level: one hub node per part of the OS, with that part's members around it.
//! [`build_hub_graph`] is one part in detail. The code part is not built here; its detail is
//! the existing [`crate::builder::SystemGraph`].
//!
//! Deterministic: ids are stable (`hub:models`, `model:<provider>/<model>`, `skill:<id>`, ...),
//! every list is sorted, and the output does not depend on the order of the input arrays.
//! Inputs are read leniently, as the rest of the JSON boundary is.

use crate::builder::{js_cmp, CoreCategory, SystemCoreNode, SystemGraph};
use crate::models::{lenient_value, lenient_vec};
use crate::snapshot::{
    ActivityId, OsActivityRow, OsChecks, OsCodeGraph, OsCounts, OsKindCount, OsKit, OsKnowledge,
    OsProjectMemory, OsSnapshotFull,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// One node of a [`VizGraph`]. `kind` is one of `hub`, `codeCluster`, `sourceKind`,
/// `memoryRepo`, `skill`, `skillSource`, `model`, `provider`, `caller`, `endpoint`,
/// `chatTurn`, `agentRun`, `liveSession`, `routine`, `kit`, `feature`, `check`, `activity`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VizNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    /// Cluster index for the layout: the hub's index at the OS level, a family within a hub.
    pub group: u32,
    /// 1.0 is normal; hubs are larger; models and sources scale with their weight (log).
    pub size: f64,
    /// Whether the page draws a text label.
    pub labelled: bool,
    /// Hub key to open (`code`, `knowledge`, ...); only hubs have one.
    pub drill: Option<String>,
    /// `ok`, `warn`, `off`, `running`, or none.
    pub status: Option<String>,
    /// Small facts for the details card: counts, tokens, schedule, path, ...
    pub meta: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VizEdge {
    pub source: String,
    pub target: String,
    /// `member` (hub to member), `requires`, `relates`, `source`, `provides`, `indexes`.
    pub kind: String,
    pub weight: f64,
    /// Short text for the edge when the data gives one (for example `indexed code graphs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VizGraph {
    /// `os`, or a hub key.
    pub level: String,
    pub title: String,
    pub nodes: Vec<VizNode>,
    pub edges: Vec<VizEdge>,
}

/// Per-community summary of the code graph (the top communities only).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CommunitySummary {
    /// Community index: 0 = largest.
    pub index: usize,
    /// Kept nodes in the community.
    pub size: usize,
    /// Most frequent category; ties go to the smaller name.
    pub dominant_category: String,
    /// Up to three labels, highest degree first.
    pub top_labels: Vec<String>,
}

/// The code part of the OS graph, summarised from a [`SystemGraph`] (see [`code_summary`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeSummary {
    pub total_nodes: usize,
    pub kept_nodes: usize,
    /// Communities in the whole kept graph, not only the ones listed.
    pub community_count: usize,
    /// Largest first.
    pub communities: Vec<CommunitySummary>,
}

/// A skill shown in the OS view (`OsSkill`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: Option<String>,
}

/// A scheduled routine shown in the OS view (`OsRoutine`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub title: String,
    pub schedule: Option<String>,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub enabled: bool,
}

/// Everything the OS view is built from. Every field is optional on the wire.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OsVizInput {
    #[serde(deserialize_with = "lenient_value")]
    pub snapshot: Option<OsSnapshotFull>,
    #[serde(deserialize_with = "lenient_vec")]
    pub skills: Vec<Skill>,
    #[serde(deserialize_with = "lenient_vec")]
    pub routines: Vec<Routine>,
    #[serde(deserialize_with = "lenient_value")]
    pub code: Option<CodeSummary>,
}

/// The `{os, hubs}` pair the page receives: the top level and every hub except `code`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OsView {
    pub os: VizGraph,
    pub hubs: BTreeMap<String, VizGraph>,
}

/// Hub keys in display order. `code` is the existing SystemGraph; the rest are built here.
pub const HUB_KEYS: [&str; 9] = [
    "code",
    "knowledge",
    "memory",
    "skills",
    "models",
    "agents",
    "routines",
    "kits",
    "activity",
];

/// Most members a hub shows at the OS level; the rest are counted in its `more` meta.
pub const OS_MEMBER_CAP: usize = 40;
/// The activity hub shows only the newest rows at the OS level (its drill-down shows
/// [`DRILL_MEMBER_CAP`]).
pub const ACTIVITY_OS_MEMBERS: usize = 24;
/// The activity drill-down labels its newest items up to this many (groups are always labelled).
const ACTIVITY_LABELLED: usize = 8;
/// Most leaf members a hub drill-down shows per list (models, callers, endpoints, skills per
/// source, ...); the rest are counted in the centre's `more` meta.
pub const DRILL_MEMBER_CAP: usize = 60;
/// The OS level labels only its hubs; a drill-down labels its largest members up to this many.
const LABELLED_HUB_MEMBERS: usize = 12;

fn hub_title(key: &str) -> &'static str {
    match key {
        "code" => "Code",
        "knowledge" => "Knowledge",
        "memory" => "Memory",
        "skills" => "Skills",
        "models" => "Models",
        "agents" => "Agents",
        "routines" => "Routines",
        "kits" => "Kits",
        "activity" => "Activity",
        _ => "",
    }
}

fn hub_index(key: &str) -> Option<u32> {
    HUB_KEYS.iter().position(|k| *k == key).map(|i| i as u32)
}

// ---- Code summary ----

fn category_name(c: CoreCategory) -> &'static str {
    match c {
        CoreCategory::Code => "code",
        CoreCategory::Docs => "docs",
        CoreCategory::Tests => "tests",
        CoreCategory::Knowledge => "knowledge",
        CoreCategory::Other => "other",
    }
}

fn core_label(n: &SystemCoreNode) -> String {
    n.label.clone().unwrap_or_else(|| n.id.clone())
}

/// Summarise a built code graph: the totals and the `top_communities` largest communities.
pub fn code_summary(graph: &SystemGraph, top_communities: usize) -> CodeSummary {
    let mut by: BTreeMap<usize, Vec<&SystemCoreNode>> = BTreeMap::new();
    for n in &graph.core {
        by.entry(n.community).or_default().push(n);
    }
    let community_count = by.len();
    let mut ranked: Vec<(usize, Vec<&SystemCoreNode>)> = by.into_iter().collect();
    ranked.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    let communities = ranked
        .into_iter()
        .take(top_communities)
        .map(|(index, mut nodes)| {
            let mut cats: BTreeMap<&str, usize> = BTreeMap::new();
            for n in &nodes {
                *cats.entry(category_name(n.category)).or_default() += 1;
            }
            let dominant = cats
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map_or("other", |(k, _)| *k);
            nodes.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| js_cmp(&a.id, &b.id)));
            CommunitySummary {
                index,
                size: nodes.len(),
                dominant_category: dominant.to_owned(),
                top_labels: nodes.iter().take(3).map(|n| core_label(n)).collect(),
            }
        })
        .collect();
    CodeSummary {
        total_nodes: graph.truncated.total_nodes,
        kept_nodes: graph.truncated.kept_nodes,
        community_count,
        communities,
    }
}

// ---- Small builders ----

fn node(id: String, label: String, kind: &str, group: u32, size: f64) -> VizNode {
    VizNode {
        id,
        label,
        kind: kind.to_owned(),
        group,
        size,
        labelled: false,
        drill: None,
        status: None,
        meta: BTreeMap::new(),
    }
}

impl VizNode {
    fn with(mut self, key: &str, value: Value) -> Self {
        self.meta.insert(key.to_owned(), value);
        self
    }

    fn status(mut self, status: &str) -> Self {
        self.status = Some(status.to_owned());
        self
    }
}

fn edge(source: &str, target: &str, kind: &str, weight: f64) -> VizEdge {
    VizEdge {
        source: source.to_owned(),
        target: target.to_owned(),
        kind: kind.to_owned(),
        weight,
        label: None,
    }
}

fn labelled_edge(source: &str, target: &str, kind: &str, label: &str) -> VizEdge {
    VizEdge {
        label: Some(label.to_owned()),
        ..edge(source, target, kind, 1.0)
    }
}

/// A grouping node that labels a family of rows (`By model`, `Enabled`, ...). Always labelled.
fn group_node(id: &str, label: &str, count: usize) -> VizNode {
    let mut n = node(id.to_owned(), label.to_owned(), "group", 0, 1.0);
    n.labelled = true;
    n.with("count", json!(count))
}

fn spoke(hub: &str, id: &str) -> VizEdge {
    edge(hub, id, "member", 1.0)
}

/// The hub node: size 6, labelled, opens its drill-down.
fn center(key: &str, status: &str, meta: BTreeMap<String, Value>) -> VizNode {
    let mut n = node(
        format!("hub:{key}"),
        hub_title(key).to_owned(),
        "hub",
        hub_index(key).unwrap_or(0),
        6.0,
    );
    n.labelled = true;
    n.drill = Some(key.to_owned());
    n.status = Some(status.to_owned());
    n.meta = meta;
    n
}

/// Log-scaled size in [1, 3]: `max` maps to 3, zero to 1.
fn log_size(value: f64, max: f64) -> f64 {
    if max <= 0.0 {
        return 1.0;
    }
    1.0 + 2.0 * (1.0 + value.max(0.0)).ln() / (1.0 + max).ln()
}

/// A count as a JSON integer when it is one.
fn int(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

fn opt(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| json!(s))
}

/// `part / whole`, or 0 when the whole is 0.
fn ratio(part: f64, whole: f64) -> f64 {
    if whole > 0.0 {
        part / whole
    } else {
        0.0
    }
}

/// Cache reads over all input-side tokens (fresh input, cache reads and cache writes).
fn cache_hit_ratio(c: &OsCounts) -> f64 {
    ratio(c.cache_read, c.input + c.cache_read + c.cache_write)
}

/// Adds one breakdown row into another with the same key (duplicate rows are summed).
fn add_counts(into: &mut OsCounts, c: &OsCounts) {
    into.calls += c.calls;
    into.runs += c.runs;
    into.input += c.input;
    into.output += c.output;
    into.cache_read += c.cache_read;
    into.cache_write += c.cache_write;
    into.billable += c.billable;
}

/// The token counts of one breakdown row, its `share` of the total billable tokens and its
/// `cacheHitRatio`.
fn with_counts(n: VizNode, c: &OsCounts, total_billable: f64) -> VizNode {
    n.with("calls", int(c.calls))
        .with("runs", int(c.runs))
        .with("input", int(c.input))
        .with("output", int(c.output))
        .with("cacheRead", int(c.cache_read))
        .with("cacheWrite", int(c.cache_write))
        .with("billable", int(c.billable))
        .with("share", json!(ratio(c.billable, total_billable)))
        .with("cacheHitRatio", json!(cache_hit_ratio(c)))
}

/// The rows of a breakdown keyed by name, largest billable first, then by key.
fn ranked_rows(by_key: BTreeMap<String, OsCounts>) -> Vec<(String, OsCounts)> {
    let mut rows: Vec<(String, OsCounts)> = by_key.into_iter().collect();
    rows.sort_by(|a, b| {
        b.1.billable
            .total_cmp(&a.1.billable)
            .then_with(|| js_cmp(&a.0, &b.0))
    });
    rows
}

/// Keeps the first `cap` nodes; returns them with how many were left out.
fn capped_nodes(mut nodes: Vec<VizNode>, cap: usize) -> (Vec<VizNode>, usize) {
    let more = nodes.len().saturating_sub(cap);
    nodes.truncate(cap);
    (nodes, more)
}

/// Ascending by string, with `None` last (for ISO timestamps: oldest first).
fn none_last_asc(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => js_cmp(x, y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// Descending by string, with `None` last (for ISO timestamps: newest first).
fn none_last_desc(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => js_cmp(y, x),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// The newest of some optional ISO timestamps, if there is one.
fn newest<'a>(values: impl Iterator<Item = Option<&'a str>>) -> Option<String> {
    values.flatten().max().map(str::to_owned)
}

fn meta_str(n: &VizNode, key: &str) -> String {
    n.meta
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn meta_str_opt<'a>(n: &'a VizNode, key: &str) -> Option<&'a str> {
    n.meta.get(key).and_then(Value::as_str)
}

fn meta_f64(n: &VizNode, key: &str) -> f64 {
    n.meta.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn meta_bool(n: &VizNode, key: &str) -> bool {
    n.meta.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Cancel availability from an item's `cancel` JSON: a POST route exists when it has a path.
fn cancel_info(cancel: &Value) -> (bool, Value) {
    let path = cancel
        .get("path")
        .and_then(Value::as_str)
        .map_or(Value::Null, |p| json!(p));
    (path.is_string(), path)
}

/// Last path component of a repo root, or the root itself.
fn basename(root: &str) -> String {
    root.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(root)
        .to_owned()
}

fn feature_enabled(features: &Option<Vec<String>>, name: &str) -> bool {
    features
        .as_ref()
        .is_none_or(|list| list.iter().any(|f| f == name))
}

fn checks_ok(c: &OsChecks) -> bool {
    c.db && c.claude && c.skills
}

/// A member with its ranking value (larger ranks first at the OS level).
type Member = (VizNode, f64);

/// What one hub contributes at the OS level and to the top of its drill-down.
#[derive(Default)]
struct Part {
    status: String,
    meta: BTreeMap<String, Value>,
    members: Vec<Member>,
    edges: Vec<VizEdge>,
}

impl Part {
    fn new(status: &str) -> Self {
        Part {
            status: status.to_owned(),
            ..Part::default()
        }
    }
}

fn dedupe(members: Vec<Member>) -> Vec<Member> {
    let mut seen = BTreeSet::new();
    members
        .into_iter()
        .filter(|(n, _)| seen.insert(n.id.clone()))
        .collect()
}

/// Ranks by value, larger first, then by id. Each part ranks its own members before they are
/// capped, so a part's order is its ranking.
fn sort_by_value(members: &mut [Member]) {
    members.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| js_cmp(&a.0.id, &b.0.id)));
}

/// Labels the `k` largest nodes; the rest are drawn without text. Group nodes are always
/// labelled and do not count toward `k`.
fn mark_labels(nodes: &mut [VizNode], k: usize) {
    let mut order: Vec<usize> = (0..nodes.len())
        .filter(|&i| nodes[i].kind != "group")
        .collect();
    order.sort_by(|&a, &b| {
        nodes[b]
            .size
            .total_cmp(&nodes[a].size)
            .then_with(|| js_cmp(&nodes[a].id, &nodes[b].id))
    });
    let picked: Vec<usize> = order.into_iter().take(k).collect();
    for (i, n) in nodes.iter_mut().enumerate() {
        n.labelled = n.kind == "group" || picked.contains(&i);
    }
}

/// Keeps the first node per id, keeps only edges whose ends exist, drops duplicates and
/// self-loops, and sorts both lists. Every graph leaves through here.
fn finish(level: &str, title: &str, nodes: Vec<VizNode>, edges: Vec<VizEdge>) -> VizGraph {
    let mut seen = BTreeSet::new();
    let nodes: Vec<VizNode> = nodes
        .into_iter()
        .filter(|n| seen.insert(n.id.clone()))
        .collect();
    let mut edges: Vec<VizEdge> = edges
        .into_iter()
        .filter(|e| e.source != e.target && seen.contains(&e.source) && seen.contains(&e.target))
        .collect();
    edges.sort_by(|a, b| {
        js_cmp(&a.source, &b.source)
            .then_with(|| js_cmp(&a.target, &b.target))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    edges.dedup_by(|a, b| a.source == b.source && a.target == b.target && a.kind == b.kind);
    VizGraph {
        level: level.to_owned(),
        title: title.to_owned(),
        nodes,
        edges,
    }
}

// ---- Member producers, shared by the OS level and the drill-downs ----

fn unique_skills(skills: &[Skill]) -> Vec<&Skill> {
    fn label(s: &Skill) -> &str {
        if s.name.is_empty() {
            &s.id
        } else {
            &s.name
        }
    }
    let mut v: Vec<&Skill> = skills.iter().filter(|s| !s.id.is_empty()).collect();
    v.sort_by(|a, b| {
        js_cmp(
            a.source.as_deref().unwrap_or(""),
            b.source.as_deref().unwrap_or(""),
        )
        .then_with(|| js_cmp(label(a), label(b)))
        .then_with(|| js_cmp(&a.id, &b.id))
    });
    let mut seen = BTreeSet::new();
    v.retain(|s| seen.insert(s.id.as_str()));
    v
}

fn unique_routines(routines: &[Routine]) -> Vec<&Routine> {
    let mut v: Vec<&Routine> = routines.iter().filter(|r| !r.id.is_empty()).collect();
    v.sort_by(|a, b| js_cmp(&a.id, &b.id));
    let mut seen = BTreeSet::new();
    v.retain(|r| seen.insert(r.id.as_str()));
    v
}

fn unique_kits(kits: &[OsKit]) -> Vec<&OsKit> {
    let mut v: Vec<&OsKit> = kits.iter().filter(|k| !k.id.is_empty()).collect();
    v.sort_by(|a, b| js_cmp(&a.id, &b.id));
    let mut seen = BTreeSet::new();
    v.retain(|k| seen.insert(k.id.as_str()));
    v
}

fn routine_node(r: &Routine) -> VizNode {
    let label = if r.title.is_empty() {
        r.id.clone()
    } else {
        r.title.clone()
    };
    node(format!("routine:{}", r.id), label, "routine", 0, 1.0)
        .status(if r.enabled { "ok" } else { "off" })
        .with("schedule", opt(&r.schedule))
        .with("nextRunAt", opt(&r.next_run_at))
        .with("lastRunAt", opt(&r.last_run_at))
        .with("enabled", json!(r.enabled))
}

/// Chat turns, meeting-agent runs and live sessions that are running now.
fn agent_members(s: &OsSnapshotFull) -> Vec<Member> {
    let r = &s.running;
    let mut out: Vec<Member> = Vec::new();
    for t in r
        .chat_turns
        .iter()
        .filter(|t| !t.chat_session_id.is_empty())
    {
        let (can, path) = cancel_info(&t.cancel);
        let n = node(
            format!("chatTurn:{}", t.chat_session_id),
            format!("Chat {}", t.chat_session_id),
            "chatTurn",
            0,
            1.0,
        )
        .status("running")
        .with("startedAt", opt(&t.started_at))
        .with("cancellable", json!(can))
        .with("cancelPath", path);
        out.push((n, 1.0));
    }
    for a in r
        .meeting_agent_runs
        .iter()
        .filter(|a| !a.session_id.is_empty())
    {
        let (can, path) = cancel_info(&a.cancel);
        let n = node(
            format!("agentRun:{}", a.session_id),
            format!("Agent run {}", a.session_id),
            "agentRun",
            0,
            1.0,
        )
        .status("running")
        .with("planId", opt(&a.plan_id))
        .with("startedAt", opt(&a.started_at))
        .with("lastTickAt", opt(&a.last_tick_at))
        .with("cancellable", json!(can))
        .with("cancelPath", path);
        out.push((n, 1.0));
    }
    for l in r.live_sessions.iter().filter(|l| !l.session_id.is_empty()) {
        // A live capture session has no cancel route: it ends when its client stops.
        let label = match &l.meeting_title {
            Some(t) if !t.is_empty() => t.clone(),
            _ => format!("Live {}", l.session_id),
        };
        let n = node(
            format!("liveSession:{}", l.session_id),
            label,
            "liveSession",
            0,
            1.0,
        )
        .status("running")
        .with("meetingTitle", opt(&l.meeting_title))
        .with("startedAt", opt(&l.started_at))
        .with("lastWrite", opt(&l.last_write))
        .with("captionCount", int(l.caption_count))
        .with("cancellable", json!(false))
        .with("cancelPath", Value::Null);
        out.push((n, 1.0));
    }
    out
}

/// The label of an activity kind in a group node (the kinds `kb/activity.mjs` writes). An
/// unknown kind is labelled with its own name.
fn activity_kind_label(kind: &str) -> String {
    match kind {
        "knowledge_updated" => "Knowledge updated",
        "regression_done" => "Regression done",
        "loop_engineering_done" => "Loop engineering done",
        "issue_created" => "Issue created",
        "comment_added" => "Comment added",
        "dispatch_issue_created" => "Dispatch issue created",
        "outcome_changed" => "Outcome changed",
        "meeting_added" => "Meeting added",
        "email_fetched" => "Email fetched",
        "slack_fetched" => "Slack fetched",
        "model_fallback" => "Model fallback",
        other => other,
    }
    .to_owned()
}

/// The usable activity rows, in input order (newest first), with their node ids. A row needs
/// an id (a non-empty string, or a number) and a kind; a repeated id keeps its first row.
fn activity_rows(items: &[OsActivityRow]) -> Vec<(String, &OsActivityRow)> {
    let mut seen = BTreeSet::new();
    items
        .iter()
        .filter_map(|row| {
            let id = row.id.as_ref().map(ActivityId::to_js_string)?;
            if id.is_empty() || row.kind.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            Some((id, row))
        })
        .collect()
}

// ---- The OS level: one part per hub ----

fn os_part(key: &str, input: &OsVizInput) -> Part {
    match key {
        "activity" => activity_part(input),
        "code" => code_part(input),
        "knowledge" => knowledge_part(input),
        "memory" => memory_part(input),
        "skills" => skills_part(input),
        "models" => models_part(input),
        "agents" => agents_part(input),
        "routines" => routines_part(input),
        "kits" => kits_part(input),
        _ => Part::new("off"),
    }
}

fn code_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let (total, kept, communities) = input.code.as_ref().map_or((0, 0, 0), |c| {
        (c.total_nodes, c.kept_nodes, c.community_count)
    });
    part.meta.insert("totalNodes".into(), json!(total));
    part.meta.insert("keptNodes".into(), json!(kept));
    part.meta.insert("communities".into(), json!(communities));
    let Some(code) = &input.code else {
        return part;
    };
    let max = code.communities.iter().map(|c| c.size).max().unwrap_or(0) as f64;
    for c in &code.communities {
        let label = match c.top_labels.first().filter(|s| !s.is_empty()) {
            Some(top) => format!("Cluster {} · {top}", c.index.saturating_add(1)),
            None => format!("Cluster {}", c.index.saturating_add(1)),
        };
        let n = node(
            format!("cluster:{}", c.index),
            label,
            "codeCluster",
            0,
            log_size(c.size as f64, max),
        )
        .with("index", json!(c.index))
        .with("size", json!(c.size))
        .with("dominantCategory", json!(c.dominant_category))
        .with("topLabels", json!(c.top_labels));
        part.members.push((n, c.size as f64));
    }
    sort_by_value(&mut part.members);
    if !part.members.is_empty() {
        part.status = "ok".into();
    }
    part
}

/// The activity hub: the feed's rows, newest first. A row's size falls linearly from 1.0 (the
/// newest) to 0.6 (the oldest row of the feed), so newer rows draw larger.
fn activity_part(input: &OsVizInput) -> Part {
    let empty = OsSnapshotFull::default();
    let feed = &input.snapshot.as_ref().unwrap_or(&empty).activity;
    let rows = activity_rows(&feed.items);
    let total = rows.len();
    let mut part = Part::new(if total == 0 { "off" } else { "ok" });
    for (i, (id, row)) in rows.iter().enumerate() {
        let size = if total <= 1 {
            1.0
        } else {
            1.0 - 0.4 * i as f64 / (total - 1) as f64
        };
        let label = if row.title.is_empty() {
            activity_kind_label(&row.kind)
        } else {
            row.title.clone()
        };
        let created = (!row.created_at.is_empty()).then(|| row.created_at.clone());
        let n = node(format!("activity:{id}"), label, "activity", 0, size)
            .with("title", json!(row.title))
            .with("activityKind", json!(row.kind))
            .with("createdAt", opt(&created))
            .with("link", opt(&row.link))
            .with("detail", row.detail.clone().unwrap_or(Value::Null));
        // Rank by position so the list keeps its newest-first order.
        part.members.push((n, (total - i) as f64));
    }
    sort_by_value(&mut part.members);
    let newest_at = newest(
        rows.iter()
            .map(|(_, r)| (!r.created_at.is_empty()).then_some(r.created_at.as_str())),
    );
    part.meta.insert("unread".into(), int(feed.unread.max(0.0)));
    part.meta.insert("newestAt".into(), opt(&newest_at));
    part
}

fn knowledge_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let empty = OsSnapshotFull::default();
    let k: &OsKnowledge = &input.snapshot.as_ref().unwrap_or(&empty).knowledge;
    let mut kinds: Vec<&OsKindCount> = k
        .sources
        .by_kind
        .iter()
        .filter(|c| !c.kind.is_empty())
        .collect();
    kinds.sort_by(|a, b| js_cmp(&a.kind, &b.kind));
    let meetings = k.meetings.count;
    let pending = k.pending_reviews;
    let max = kinds.iter().map(|c| c.count).fold(meetings, f64::max);
    let has_data = !kinds.is_empty() || meetings > 0.0;
    for c in &kinds {
        let n = node(
            format!("source:{}", c.kind),
            c.kind.clone(),
            "sourceKind",
            0,
            log_size(c.count, max),
        )
        .with("count", int(c.count))
        .with("lastIndexedAt", opt(&c.last_indexed_at));
        part.members.push((n, c.count));
    }
    // Meetings and reviews appear only when there is something to show: an empty hub is its centre.
    if meetings > 0.0 {
        part.members.push((
            node(
                "knowledge:meetings".into(),
                "Meetings".into(),
                "sourceKind",
                0,
                log_size(meetings, max),
            )
            .with("count", int(meetings)),
            meetings,
        ));
    }
    if pending > 0.0 {
        part.members.push((
            node(
                "knowledge:reviews".into(),
                "Pending reviews".into(),
                "activity",
                0,
                1.0,
            )
            .status("warn")
            .with("count", int(pending)),
            pending,
        ));
    }
    sort_by_value(&mut part.members);
    part.meta.insert("sources".into(), int(k.sources.total));
    part.meta.insert("meetings".into(), int(meetings));
    part.meta.insert("pendingReviews".into(), int(pending));
    part.meta.insert("outcomes".into(), int(k.outcomes.total));
    part.meta
        .insert("outcomesTerminal".into(), int(k.outcomes.terminal));
    part.meta.insert(
        "lastIndexedAt".into(),
        opt(&newest(kinds.iter().map(|c| c.last_indexed_at.as_deref()))),
    );
    part.status = if pending > 0.0 {
        "warn"
    } else if has_data {
        "ok"
    } else {
        "off"
    }
    .into();
    part
}

fn memory_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let empty = OsSnapshotFull::default();
    let mut repos: Vec<&OsProjectMemory> = input
        .snapshot
        .as_ref()
        .unwrap_or(&empty)
        .knowledge
        .project_memory
        .iter()
        .filter(|r| !r.repo_root.is_empty())
        .collect();
    repos.sort_by(|a, b| js_cmp(&a.repo_root, &b.repo_root));
    let max = repos.iter().map(|r| r.facts).fold(0.0, f64::max);
    let (mut facts, mut active, mut superseded) = (0.0, 0.0, 0.0);
    for r in &repos {
        facts += r.facts;
        active += r.active;
        superseded += r.superseded;
        let n = node(
            format!("memory:{}", r.repo_root),
            basename(&r.repo_root),
            "memoryRepo",
            0,
            log_size(r.facts, max),
        )
        .status(if r.active > 0.0 { "ok" } else { "off" })
        .with("repoRoot", json!(r.repo_root))
        .with("facts", int(r.facts))
        .with("active", int(r.active))
        .with("superseded", int(r.superseded))
        .with("lastConfirmedAt", opt(&r.last_confirmed_at));
        part.members.push((n, r.facts));
    }
    sort_by_value(&mut part.members);
    part.meta.insert("repos".into(), json!(repos.len()));
    part.meta.insert("facts".into(), int(facts));
    part.meta.insert("active".into(), int(active));
    part.meta.insert("superseded".into(), int(superseded));
    part.status = if repos.is_empty() { "off" } else { "ok" }.into();
    part
}

fn skills_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let skills = unique_skills(&input.skills);
    let mut by_src: BTreeMap<&str, usize> = BTreeMap::new();
    for s in &skills {
        *by_src.entry(s.source.as_deref().unwrap_or("")).or_default() += 1;
    }
    let max = by_src.values().copied().max().unwrap_or(0) as f64;
    for (src, count) in &by_src {
        let label = if src.is_empty() { "unsourced" } else { *src };
        let n = node(
            format!("skillSource:{src}"),
            label.to_owned(),
            "skillSource",
            0,
            log_size(*count as f64, max),
        )
        .with("count", json!(count))
        .with("source", json!(src));
        part.members.push((n, *count as f64));
    }
    sort_by_value(&mut part.members);
    part.meta.insert("skills".into(), json!(skills.len()));
    part.meta.insert("sources".into(), json!(by_src.len()));
    part.status = if skills.is_empty() { "off" } else { "ok" }.into();
    part
}

fn models_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let empty = OsSnapshotFull::default();
    let tokens = &input.snapshot.as_ref().unwrap_or(&empty).tokens;
    let total = tokens.totals.billable;
    // A (provider, model) pair listed twice is one row: its counts are summed.
    let mut by_pair: BTreeMap<(&str, &str), OsCounts> = BTreeMap::new();
    for m in tokens
        .by_model
        .iter()
        .filter(|m| !m.provider.is_empty() || !m.model.is_empty())
    {
        add_counts(
            by_pair
                .entry((m.provider.as_str(), m.model.as_str()))
                .or_default(),
            &m.counts,
        );
    }
    let mut rows: Vec<((&str, &str), OsCounts)> = by_pair.into_iter().collect();
    rows.sort_by(|a, b| {
        b.1.billable
            .total_cmp(&a.1.billable)
            .then_with(|| js_cmp(a.0 .0, b.0 .0))
            .then_with(|| js_cmp(a.0 .1, b.0 .1))
    });
    let max = rows.iter().map(|(_, c)| c.billable).fold(0.0, f64::max);
    for ((provider, model), counts) in &rows {
        // Only the per-model totals are in the snapshot, so models link to the hub alone.
        let label = if model.is_empty() {
            "unknown".to_owned()
        } else {
            (*model).to_owned()
        };
        let n = with_counts(
            node(
                format!("model:{provider}/{model}"),
                label,
                "model",
                0,
                log_size(counts.billable, max),
            ),
            counts,
            total,
        )
        .with("provider", json!(provider))
        .with("model", json!(model));
        part.members.push((n, counts.billable));
    }
    sort_by_value(&mut part.members);
    part.meta.insert("billable".into(), int(total));
    part.meta.insert("calls".into(), int(tokens.totals.calls));
    part.meta.insert("models".into(), json!(rows.len()));
    part.meta.insert(
        "note".into(),
        json!("three separate breakdowns of the same total: by model, by caller, by endpoint"),
    );
    part.status = if rows.is_empty() { "off" } else { "ok" }.into();
    part
}

fn agents_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let empty = OsSnapshotFull::default();
    let s = input.snapshot.as_ref().unwrap_or(&empty);
    let mut members = agent_members(s);
    // Running first, then the newest start.
    members.sort_by(|a, b| {
        let running = |n: &VizNode| n.status.as_deref() != Some("running");
        running(&a.0)
            .cmp(&running(&b.0))
            .then_with(|| {
                none_last_desc(
                    meta_str_opt(&a.0, "startedAt"),
                    meta_str_opt(&b.0, "startedAt"),
                )
            })
            .then_with(|| js_cmp(&a.0.id, &b.0.id))
    });
    let running = members.len();
    part.members = members;
    part.meta.insert("running".into(), json!(running));
    part.meta
        .insert("chatTurns".into(), json!(s.running.chat_turns.len()));
    part.meta.insert(
        "agentRuns".into(),
        json!(s.running.meeting_agent_runs.len()),
    );
    part.meta
        .insert("liveSessions".into(), json!(s.running.live_sessions.len()));
    part.status = if running > 0 { "running" } else { "off" }.into();
    part
}

fn routines_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let routines = unique_routines(&input.routines);
    let enabled = routines.iter().filter(|r| r.enabled).count();
    for r in &routines {
        part.members.push((routine_node(r), 1.0));
    }
    // Enabled first, then the soonest next run (none last), then by id.
    part.members.sort_by(|a, b| {
        meta_bool(&b.0, "enabled")
            .cmp(&meta_bool(&a.0, "enabled"))
            .then_with(|| {
                none_last_asc(
                    meta_str_opt(&a.0, "nextRunAt"),
                    meta_str_opt(&b.0, "nextRunAt"),
                )
            })
            .then_with(|| js_cmp(&a.0.id, &b.0.id))
    });
    part.meta.insert("routines".into(), json!(routines.len()));
    part.meta.insert("enabled".into(), json!(enabled));
    part.meta.insert(
        "lastRunAt".into(),
        opt(&newest(routines.iter().map(|r| r.last_run_at.as_deref()))),
    );
    part.status = if enabled > 0 { "ok" } else { "off" }.into();
    part
}

fn kits_part(input: &OsVizInput) -> Part {
    let mut part = Part::new("off");
    let empty = OsSnapshotFull::default();
    let system = &input.snapshot.as_ref().unwrap_or(&empty).system;
    let kits = unique_kits(&system.kits);
    let mut features: BTreeSet<&str> = BTreeSet::new();
    for kit in &kits {
        for f in kit.requires.iter().filter(|f| !f.is_empty()) {
            features.insert(f);
        }
    }
    let enabled = kits.iter().filter(|k| k.enabled).count();
    for kit in &kits {
        let kit_id = format!("kit:{}", kit.id);
        let n = node(kit_id.clone(), kit.id.clone(), "kit", 0, 1.0)
            .status(if kit.enabled { "ok" } else { "off" })
            .with("enabled", json!(kit.enabled))
            .with("requires", json!(kit.requires));
        // Kits rank above features; enabled kits first.
        part.members.push((n, if kit.enabled { 3.0 } else { 2.0 }));
        for f in kit.requires.iter().filter(|f| !f.is_empty()) {
            part.edges
                .push(edge(&kit_id, &format!("feature:{f}"), "requires", 1.0));
        }
    }
    for f in &features {
        let on = feature_enabled(&system.features, f);
        let n = node(format!("feature:{f}"), (*f).to_owned(), "feature", 0, 1.0)
            .status(if on { "ok" } else { "off" })
            .with("enabled", json!(on));
        part.members.push((n, 1.0));
    }
    sort_by_value(&mut part.members);
    // Checks absent: unknown, not failing. The kits hub then warns only for its own kits.
    let checks_good = system.checks.as_ref().map(checks_ok);
    part.meta.insert("kits".into(), json!(kits.len()));
    part.meta.insert("enabled".into(), json!(enabled));
    part.meta.insert("features".into(), json!(features.len()));
    part.meta.insert("checksOk".into(), json!(checks_good));
    part.status = if kits.is_empty() {
        "off"
    } else if enabled < kits.len() || checks_good == Some(false) {
        "warn"
    } else if checks_good.is_none() {
        "unknown"
    } else {
        "ok"
    }
    .into();
    part
}

/// Most members a hub shows at the OS level.
fn os_member_cap(key: &str) -> usize {
    if key == "activity" {
        ACTIVITY_OS_MEMBERS
    } else {
        OS_MEMBER_CAP
    }
}

/// The OS graph: one hub per part, each hub's members around it (capped), and the cross-hub
/// edges the data states.
pub fn build_os_graph(input: &OsVizInput) -> VizGraph {
    let mut nodes: Vec<VizNode> = Vec::new();
    let mut edges: Vec<VizEdge> = Vec::new();
    for (i, key) in HUB_KEYS.iter().enumerate() {
        let group = i as u32;
        let hub = format!("hub:{key}");
        let part = os_part(key, input);
        // Each part ranks its own members, so deduping keeps that order.
        let members = dedupe(part.members);
        let total = members.len();
        let shown = total.min(os_member_cap(key));
        let mut meta = part.meta;
        meta.insert("members".into(), json!(total));
        meta.insert("more".into(), json!(total - shown));
        nodes.push(center(key, &part.status, meta));
        let mut list: Vec<VizNode> = members
            .into_iter()
            .take(shown)
            .map(|(mut n, _)| {
                n.group = group;
                n
            })
            .collect();
        // The OS level labels its hubs only: members are dots until the part is opened.
        mark_labels(&mut list, 0);
        for n in &list {
            edges.push(spoke(&hub, &n.id));
        }
        nodes.extend(list);
        edges.extend(part.edges);
    }

    let empty = OsSnapshotFull::default();
    let s = input.snapshot.as_ref().unwrap_or(&empty);
    // Knowledge indexes the code graphs; the edge exists only when there are some.
    if !s.knowledge.code_graph.is_empty() {
        edges.push(labelled_edge(
            "hub:knowledge",
            "hub:code",
            "indexes",
            "indexed code graphs",
        ));
    }
    finish("os", "OS", nodes, edges)
}

// ---- Drill-downs: the same part in more detail ----

/// One hub's drill-down. `members` counts the leaf rows before the caps, `more` the rows the
/// caps left out; both go to the centre's meta, as the OS-level hubs' do.
struct Detail {
    nodes: Vec<VizNode>,
    edges: Vec<VizEdge>,
    members: usize,
    more: usize,
}

/// The members of one hub's drill-down, with their spokes and the detail edges.
fn hub_detail(key: &str, input: &OsVizInput, part: Part) -> Detail {
    let hub = format!("hub:{key}");
    let empty = OsSnapshotFull::default();
    let s = input.snapshot.as_ref().unwrap_or(&empty);
    let mut nodes: Vec<VizNode> = dedupe(part.members).into_iter().map(|(n, _)| n).collect();
    let mut edges = part.edges;
    let (mut members, mut more) = (nodes.len(), 0);
    match key {
        "activity" => {
            // The newest rows up to the drill cap, each kind under its own labelled group. A
            // group hangs off the hub and its items hang off the group.
            let all = std::mem::take(&mut nodes);
            members = all.len();
            let (kept, left) = capped_nodes(all, DRILL_MEMBER_CAP);
            more = left;
            let kinds: BTreeSet<String> = kept.iter().map(|n| meta_str(n, "activityKind")).collect();
            for (gi, kind) in kinds.iter().enumerate() {
                let count = kept
                    .iter()
                    .filter(|n| meta_str(n, "activityKind") == *kind)
                    .count();
                let gid = format!("group:activity:{kind}");
                let mut g = group_node(&gid, &activity_kind_label(kind), count);
                g.group = 1 + gi as u32;
                nodes.push(g);
                edges.push(spoke(&hub, &gid));
            }
            for mut n in kept {
                let kind = meta_str(&n, "activityKind");
                n.group = 1 + kinds.iter().position(|k| *k == kind).unwrap_or(0) as u32;
                edges.push(edge(&n.id, &format!("group:activity:{kind}"), "member", 1.0));
                nodes.push(n);
            }
        }
        "knowledge" => {
            let k = &s.knowledge;
            let max = k.outcomes.by_state.values().copied().fold(0.0, f64::max);
            let outcomes: Vec<VizNode> = k
                .outcomes
                .by_state
                .iter()
                .filter(|(state, _)| !state.is_empty())
                .map(|(state, count)| {
                    node(
                        format!("outcome:{state}"),
                        state.clone(),
                        "activity",
                        0,
                        log_size(*count, max),
                    )
                    .with("count", int(*count))
                })
                .collect();
            let mut repos: Vec<&OsCodeGraph> = k
                .code_graph
                .iter()
                .filter(|c| !c.repo_id.is_empty())
                .collect();
            repos.sort_by(|a, b| js_cmp(&a.repo_id, &b.repo_id));
            let repos: Vec<VizNode> = repos
                .into_iter()
                .map(|r| {
                    node(
                        format!("codegraph:{}", r.repo_id),
                        r.repo_id.clone(),
                        "codeCluster",
                        0,
                        1.0,
                    )
                    .with("commitSha", opt(&r.commit_sha))
                    .with("generatedAt", opt(&r.generated_at))
                })
                .collect();
            members += outcomes.len() + repos.len();
            let (outcomes, out_more) = capped_nodes(outcomes, DRILL_MEMBER_CAP);
            let (repos, repo_more) = capped_nodes(repos, DRILL_MEMBER_CAP);
            more = out_more + repo_more;
            nodes.extend(outcomes);
            nodes.extend(repos);
            for n in &nodes {
                edges.push(spoke(&hub, &n.id));
            }
        }
        "skills" => {
            // The members are the sources; each skill hangs off its source. A source lists its
            // skills alphabetically, up to the cap, and its `more` says how many it left out.
            let mut by_src: BTreeMap<String, Vec<&Skill>> = BTreeMap::new();
            for sk in unique_skills(&input.skills) {
                by_src
                    .entry(sk.source.clone().unwrap_or_default())
                    .or_default()
                    .push(sk);
            }
            members = by_src.values().map(Vec::len).sum();
            for n in &nodes {
                edges.push(spoke(&hub, &n.id));
            }
            for (src, list) in by_src {
                let src_id = format!("skillSource:{src}");
                let shown = list.len().min(DRILL_MEMBER_CAP);
                let left = list.len() - shown;
                more += left;
                if let Some(source) = nodes.iter_mut().find(|n| n.id == src_id) {
                    source.meta.insert("more".into(), json!(left));
                }
                for sk in list.into_iter().take(shown) {
                    let label = if sk.name.is_empty() {
                        sk.id.clone()
                    } else {
                        sk.name.clone()
                    };
                    let id = format!("skill:{}", sk.id);
                    nodes.push(
                        node(id.clone(), label, "skill", 0, 1.0)
                            .with("name", json!(sk.name))
                            .with("description", opt(&sk.description))
                            .with("source", json!(src)),
                    );
                    edges.push(edge(&id, &src_id, "source", 1.0));
                }
            }
        }
        "models" => {
            // Three breakdowns of the same total: by model (grouped by provider), by caller and
            // by endpoint. Each is under its own labelled group node.
            let total = s.tokens.totals.billable;
            let models = std::mem::take(&mut nodes);
            let model_rows = models.len();
            let mut billable_by_provider: BTreeMap<String, f64> = BTreeMap::new();
            for m in &models {
                *billable_by_provider
                    .entry(meta_str(m, "provider"))
                    .or_default() += meta_f64(m, "billable");
            }
            let (kept_models, model_more) = capped_nodes(models, DRILL_MEMBER_CAP);
            let kept_providers: BTreeSet<String> = kept_models
                .iter()
                .map(|m| meta_str(m, "provider"))
                .collect();
            let max_p = billable_by_provider.values().copied().fold(0.0, f64::max);
            if model_rows > 0 {
                nodes.push(
                    group_node("group:by-model", "By model", model_rows)
                        .with("more", json!(model_more)),
                );
                edges.push(spoke(&hub, "group:by-model"));
            }
            for (p, billable) in &billable_by_provider {
                if !kept_providers.contains(p) {
                    continue;
                }
                let id = format!("provider:{p}");
                let label = if p.is_empty() { "unknown" } else { p.as_str() }.to_owned();
                nodes.push(
                    node(id.clone(), label, "provider", 0, log_size(*billable, max_p))
                        .with("billable", int(*billable))
                        .with("share", json!(ratio(*billable, total))),
                );
                edges.push(edge("group:by-model", &id, "member", 1.0));
            }
            for m in kept_models {
                edges.push(edge(
                    &format!("provider:{}", meta_str(&m, "provider")),
                    &m.id,
                    "provides",
                    1.0,
                ));
                nodes.push(m);
            }

            let mut by_caller: BTreeMap<String, OsCounts> = BTreeMap::new();
            for c in s.tokens.by_source.iter().filter(|c| !c.source.is_empty()) {
                add_counts(by_caller.entry(c.source.clone()).or_default(), &c.counts);
            }
            let callers = ranked_rows(by_caller);
            let max_c = callers.iter().map(|(_, c)| c.billable).fold(0.0, f64::max);
            let caller_rows = callers.len();
            let callers: Vec<VizNode> = callers
                .into_iter()
                .map(|(src, c)| {
                    let id = format!("caller:{src}");
                    with_counts(
                        node(id, src.clone(), "caller", 0, log_size(c.billable, max_c)),
                        &c,
                        total,
                    )
                })
                .collect();
            let (callers, caller_more) = capped_nodes(callers, DRILL_MEMBER_CAP);
            if caller_rows > 0 {
                nodes.push(
                    group_node("group:by-caller", "By caller", caller_rows)
                        .with("more", json!(caller_more)),
                );
                edges.push(spoke(&hub, "group:by-caller"));
            }
            for c in callers {
                edges.push(edge("group:by-caller", &c.id, "member", 1.0));
                nodes.push(c);
            }

            let mut by_endpoint: BTreeMap<String, OsCounts> = BTreeMap::new();
            for e in &s.tokens.by_endpoint {
                add_counts(
                    by_endpoint
                        .entry(e.endpoint.clone().unwrap_or_default())
                        .or_default(),
                    &e.counts,
                );
            }
            let endpoints = ranked_rows(by_endpoint);
            let max_e = endpoints
                .iter()
                .map(|(_, c)| c.billable)
                .fold(0.0, f64::max);
            let endpoint_rows = endpoints.len();
            let endpoints: Vec<VizNode> = endpoints
                .into_iter()
                .map(|(ep, c)| {
                    let label = if ep.is_empty() {
                        "(no endpoint)".to_owned()
                    } else {
                        ep.clone()
                    };
                    let id = format!("endpoint:{ep}");
                    with_counts(
                        node(id, label, "endpoint", 0, log_size(c.billable, max_e)),
                        &c,
                        total,
                    )
                })
                .collect();
            let (endpoints, endpoint_more) = capped_nodes(endpoints, DRILL_MEMBER_CAP);
            if endpoint_rows > 0 {
                nodes.push(
                    group_node("group:by-endpoint", "By endpoint", endpoint_rows)
                        .with("more", json!(endpoint_more)),
                );
                edges.push(spoke(&hub, "group:by-endpoint"));
            }
            for e in endpoints {
                edges.push(edge("group:by-endpoint", &e.id, "member", 1.0));
                nodes.push(e);
            }
            members = model_rows + caller_rows + endpoint_rows;
            more = model_more + caller_more + endpoint_more;
        }
        "routines" => {
            // Routines grouped under an enabled and a disabled node. The routines arrive in
            // rank order (enabled first, soonest run first); the groups count all of them.
            let routines = std::mem::take(&mut nodes);
            let total = routines.len();
            let on = routines.iter().filter(|r| meta_bool(r, "enabled")).count();
            let off = total - on;
            let (routines, routine_more) = capped_nodes(routines, DRILL_MEMBER_CAP);
            members = total;
            more = routine_more;
            // An empty hub is its centre only, so the groups exist only with routines.
            if total > 0 {
                let on_id = "routines:enabled";
                let off_id = "routines:disabled";
                nodes.push(group_node(on_id, "Enabled", on).status(if on > 0 {
                    "ok"
                } else {
                    "off"
                }));
                nodes.push(group_node(off_id, "Disabled", off).status("off"));
                edges.push(spoke(&hub, on_id));
                edges.push(spoke(&hub, off_id));
                for r in routines {
                    let parent = if meta_bool(&r, "enabled") {
                        on_id
                    } else {
                        off_id
                    };
                    edges.push(edge(parent, &r.id, "member", 1.0));
                    nodes.push(r);
                }
            }
        }
        "kits" => {
            // Kits (enabled first), then features; the checks follow when they are known.
            let (kept, kit_more) = capped_nodes(std::mem::take(&mut nodes), DRILL_MEMBER_CAP);
            nodes = kept;
            more = kit_more;
            for n in &nodes {
                edges.push(spoke(&hub, &n.id));
            }
            if let Some(c) = s.system.checks.as_ref() {
                let checks = [
                    ("db", "db", c.db, None),
                    ("claude", "claude CLI", c.claude, c.claude_error.clone()),
                    ("skills", "skills", c.skills, c.skills_error.clone()),
                ];
                for (name, label, ok, error) in checks {
                    let id = format!("check:{name}");
                    nodes.push(
                        node(id.clone(), label.to_owned(), "check", 0, 1.0)
                            .status(if ok { "ok" } else { "warn" })
                            .with("ok", json!(ok))
                            .with("error", opt(&error)),
                    );
                    edges.push(spoke(&hub, &id));
                }
            }
        }
        _ => {
            // memory, agents: every member is a direct child of the hub, in rank order.
            let (kept, left) = capped_nodes(std::mem::take(&mut nodes), DRILL_MEMBER_CAP);
            nodes = kept;
            more = left;
            for n in &nodes {
                edges.push(spoke(&hub, &n.id));
            }
        }
    }
    Detail {
        nodes,
        edges,
        members,
        more,
    }
}

/// One part of the OS in detail. `None` for `code` (the existing SystemGraph) and for any
/// key that is not a hub. A hub with no data is returned with its centre only.
pub fn build_hub_graph(hub: &str, input: &OsVizInput) -> Option<VizGraph> {
    if hub == "code" || !HUB_KEYS.contains(&hub) {
        return None;
    }
    let part = os_part(hub, input);
    let status = part.status.clone();
    let mut meta = part.meta.clone();
    let detail = hub_detail(hub, input, part);
    meta.insert("members".into(), json!(detail.members));
    meta.insert("more".into(), json!(detail.more));
    let mut members = detail.nodes;
    // Families within a hub get their own group, numbered by kind (sorted); the centre is 0.
    // The activity drill sets its own groups (one per kind) in `hub_detail`.
    if hub != "activity" {
        let kinds: BTreeSet<String> = members.iter().map(|n| n.kind.clone()).collect();
        for n in members.iter_mut() {
            n.group = 1 + kinds.iter().position(|k| *k == n.kind).unwrap_or(0) as u32;
        }
    }
    let labelled = if hub == "activity" {
        ACTIVITY_LABELLED
    } else {
        LABELLED_HUB_MEMBERS
    };
    mark_labels(&mut members, labelled);
    let mut nodes = vec![center(hub, &status, meta)];
    nodes.extend(members);
    Some(finish(hub, hub_title(hub), nodes, detail.edges))
}

/// The whole view: the OS graph and every hub except `code`.
pub fn build_os_view(input: &OsVizInput) -> OsView {
    let hubs = HUB_KEYS
        .iter()
        .filter_map(|k| build_hub_graph(k, input).map(|g| ((*k).to_owned(), g)))
        .collect();
    OsView {
        os: build_os_graph(input),
        hubs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(text: &str) -> OsSnapshotFull {
        serde_json::from_str(text).expect("lenient snapshot")
    }

    fn ids(g: &VizGraph) -> Vec<&str> {
        g.nodes.iter().map(|n| n.id.as_str()).collect()
    }

    #[test]
    fn empty_input_gives_nine_hubs_all_off_except_none() {
        let g = build_os_graph(&OsVizInput::default());
        assert_eq!(g.level, "os");
        let hubs: Vec<&VizNode> = g.nodes.iter().filter(|n| n.kind == "hub").collect();
        assert_eq!(hubs.len(), 9);
        assert!(hubs.iter().all(|h| h.status.as_deref() == Some("off")));
        assert!(hubs.iter().all(|h| h.labelled && h.size == 6.0));
        let drills: Vec<&str> = hubs.iter().filter_map(|h| h.drill.as_deref()).collect();
        assert_eq!(
            drills,
            [
                "code",
                "knowledge",
                "memory",
                "skills",
                "models",
                "agents",
                "routines",
                "kits",
                "activity"
            ]
        );
        // The code-feature edge needs a feature node, so it is gone with no kits.
        assert!(g.edges.is_empty(), "{:?}", g.edges);
    }

    #[test]
    fn empty_hub_graphs_are_just_the_centre() {
        let input = OsVizInput::default();
        for key in [
            "knowledge",
            "memory",
            "skills",
            "models",
            "agents",
            "routines",
            "kits",
        ] {
            let g = build_hub_graph(key, &input).expect("hub graph");
            assert_eq!(g.nodes.len(), 1, "{key}");
            assert_eq!(g.nodes[0].id, format!("hub:{key}"));
            assert!(g.edges.is_empty(), "{key}");
        }
        assert!(build_hub_graph("code", &input).is_none());
        assert!(build_hub_graph("nope", &input).is_none());
    }

    #[test]
    fn os_level_labels_hubs_only_and_a_drill_labels_at_most_twelve_members() {
        let rows: Vec<String> = (0..30)
            .map(|i| format!(r#"{{"provider":"p","model":"m{i:02}","billable":{}}}"#, i + 1))
            .collect();
        let text = format!(r#"{{"tokens":{{"byModel":[{}]}}}}"#, rows.join(","));
        let input = input_of(snapshot(&text));
        let os = build_os_graph(&input);
        for n in &os.nodes {
            assert_eq!(n.labelled, n.kind == "hub", "{} labelled {}", n.id, n.labelled);
        }
        let drill = build_hub_graph("models", &input).expect("models drill");
        let members: Vec<&VizNode> = drill.nodes.iter().filter(|n| n.kind == "model").collect();
        assert_eq!(members.len(), 30);
        // The cap counts every member (a provider row shares it with the models); group rows are always labelled.
        let capped: Vec<&VizNode> = drill
            .nodes
            .iter()
            .filter(|n| n.labelled && n.kind != "hub" && n.kind != "group")
            .collect();
        assert_eq!(capped.len(), LABELLED_HUB_MEMBERS);
        let labelled: Vec<&&VizNode> = members.iter().filter(|n| n.labelled).collect();
        // The labelled ones are the largest: m29 (billable 30) is among them, m00 is not.
        assert!(labelled.iter().any(|n| n.id == "model:p/m29"));
        assert!(!labelled.iter().any(|n| n.id == "model:p/m00"));
        assert!(drill.nodes.iter().find(|n| n.kind == "hub").unwrap().labelled);
    }

    #[test]
    fn models_get_one_node_per_model_linked_to_the_hub_only() {
        let snap = snapshot(
            r#"{"tokens":{"totals":{"billable":2800,"calls":2},
              "byModel":[{"provider":"anthropic","model":"claude-sonnet-5","billable":2800,"calls":1,"input":1200,"output":300,"cacheRead":8000,"cacheWrite":400},
                         {"provider":"anthropic","model":"claude-haiku-5-5","billable":0,"calls":1}],
              "bySource":[{"source":"api","billable":2800,"calls":1},{"source":"auto-task","billable":0,"calls":3}],
              "byEndpoint":[{"endpoint":"/agent/v2/stream","billable":2800,"calls":1},{"endpoint":null,"calls":1}]}}"#,
        );
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let model_ids: Vec<&str> = os
            .nodes
            .iter()
            .filter(|n| n.kind == "model")
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(
            model_ids,
            [
                "model:anthropic/claude-sonnet-5",
                "model:anthropic/claude-haiku-5-5"
            ]
        );
        // The biggest model is the largest node.
        let sonnet = os.nodes.iter().find(|n| n.kind == "model").unwrap();
        assert_eq!(sonnet.size, 3.0);
        // Only hub spokes: no model-to-caller invention at the OS level.
        assert!(!os.edges.iter().any(|e| e.source.starts_with("model:")));

        let models = build_hub_graph("models", &input).unwrap();
        let ids = ids(&models);
        assert!(ids.contains(&"provider:anthropic"));
        assert!(ids.contains(&"caller:api"));
        assert!(ids.contains(&"caller:auto-task"));
        assert!(ids.contains(&"endpoint:/agent/v2/stream"));
        assert!(ids.contains(&"endpoint:"));
        let provides = models.edges.iter().filter(|e| e.kind == "provides").count();
        assert_eq!(provides, 2);
        let caller_edges: Vec<&VizEdge> = models
            .edges
            .iter()
            .filter(|e| e.target.starts_with("caller:"))
            .collect();
        // Callers hang off their group, which hangs off the hub.
        assert!(caller_edges.iter().all(|e| e.source == "group:by-caller"));
        assert!(models
            .edges
            .iter()
            .any(|e| e.source == "hub:models" && e.target == "group:by-caller"));
    }

    #[test]
    fn running_agents_are_members_with_cancel_meta() {
        let snap = snapshot(
            r#"{"running":{
              "chatTurns":[{"chatSessionId":"chat-1","startedAt":"t","cancel":{"method":"POST","path":"/agent/v2/cancel"}}],
              "meetingAgentRuns":[{"sessionId":"live-1","cancel":{"method":"POST","path":"/kb/agent/stop"}}],
              "liveSessions":[{"sessionId":"live-1","meetingTitle":"Weekly sync","captionCount":2,"cancel":null}]}}"#,
        );
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let g = build_hub_graph("agents", &input).unwrap();
        assert_eq!(g.nodes[0].status.as_deref(), Some("running"));
        let chat = g.nodes.iter().find(|n| n.id == "chatTurn:chat-1").unwrap();
        assert_eq!(chat.meta["cancellable"], json!(true));
        assert_eq!(chat.meta["cancelPath"], json!("/agent/v2/cancel"));
        let live = g
            .nodes
            .iter()
            .find(|n| n.id == "liveSession:live-1")
            .unwrap();
        assert_eq!(live.label, "Weekly sync");
        assert_eq!(live.meta["cancellable"], json!(false));
        assert_eq!(live.meta["captionCount"], json!(2));
        // The agent-run and the live session share a session id, but ids differ by kind.
        assert!(g.nodes.iter().any(|n| n.id == "agentRun:live-1"));
    }

    #[test]
    fn skills_drill_down_groups_skills_under_their_source() {
        let input = OsVizInput {
            skills: vec![
                Skill {
                    id: "skill-b".into(),
                    name: "beta".into(),
                    description: None,
                    source: Some("kit".into()),
                },
                Skill {
                    id: "skill-a".into(),
                    name: "alpha".into(),
                    description: Some("first".into()),
                    source: Some("kit".into()),
                },
                Skill {
                    id: "skill-c".into(),
                    name: "gamma".into(),
                    description: None,
                    source: None,
                },
            ],
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let sources: Vec<&VizNode> = os
            .nodes
            .iter()
            .filter(|n| n.kind == "skillSource")
            .collect();
        assert_eq!(sources.len(), 2);
        // OS level: sources only, no individual skills.
        assert!(os.nodes.iter().all(|n| n.kind != "skill"));
        let g = build_hub_graph("skills", &input).unwrap();
        let skill_nodes = g.nodes.iter().filter(|n| n.kind == "skill").count();
        assert_eq!(skill_nodes, 3);
        let kit_edges: Vec<&VizEdge> = g
            .edges
            .iter()
            .filter(|e| e.kind == "source" && e.target == "skillSource:kit")
            .collect();
        assert_eq!(kit_edges.len(), 2);
        let unsourced = g.nodes.iter().find(|n| n.id == "skillSource:").unwrap();
        assert_eq!(unsourced.label, "unsourced");
    }

    #[test]
    fn routines_group_by_enabled_and_link_their_next_run() {
        let input = OsVizInput {
            routines: vec![
                Routine {
                    id: "r1".into(),
                    title: "Regression".into(),
                    schedule: Some("Every weekday at 09:00".into()),
                    next_run_at: Some("2026-10-28T00:00:00Z".into()),
                    last_run_at: None,
                    enabled: true,
                },
                Routine {
                    id: "r2".into(),
                    title: "Digest".into(),
                    schedule: None,
                    next_run_at: None,
                    last_run_at: None,
                    enabled: false,
                },
            ],
            ..OsVizInput::default()
        };
        let g = build_hub_graph("routines", &input).unwrap();
        let r1 = g.nodes.iter().find(|n| n.id == "routine:r1").unwrap();
        assert_eq!(r1.status.as_deref(), Some("ok"));
        assert_eq!(r1.meta["nextRunAt"], json!("2026-10-28T00:00:00Z"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "routines:enabled" && e.target == "routine:r1"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "routines:disabled" && e.target == "routine:r2"));
        let os = build_os_graph(&input);
        let hub = os.nodes.iter().find(|n| n.id == "hub:routines").unwrap();
        assert_eq!(hub.status.as_deref(), Some("ok"));
    }

    #[test]
    fn kits_link_to_features_and_checks_flag_failures() {
        let snap = snapshot(
            r#"{"system":{"features":["file_explorer"],
              "kits":[{"id":"graph-kit","requires":["code_graph_3d"],"enabled":true},
                      {"id":"workspace-kit","requires":["file_explorer","terminal"],"enabled":false}],
              "checks":{"db":true,"claude":false,"claudeError":"no cli","skills":true}}}"#,
        );
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        assert!(os.edges.iter().any(|e| e.source == "kit:graph-kit"
            && e.target == "feature:code_graph_3d"
            && e.kind == "requires"));
        // No invented cross-hub edge: the Code hub links to nothing it does not state.
        assert!(!os.edges.iter().any(|e| e.source == "hub:code"));
        let feature = os
            .nodes
            .iter()
            .find(|n| n.id == "feature:code_graph_3d")
            .unwrap();
        assert_eq!(feature.status.as_deref(), Some("off"));
        let file = os
            .nodes
            .iter()
            .find(|n| n.id == "feature:file_explorer")
            .unwrap();
        assert_eq!(file.status.as_deref(), Some("ok"));
        let hub = os.nodes.iter().find(|n| n.id == "hub:kits").unwrap();
        assert_eq!(hub.status.as_deref(), Some("warn"));

        let g = build_hub_graph("kits", &input).unwrap();
        let claude = g.nodes.iter().find(|n| n.id == "check:claude").unwrap();
        assert_eq!(claude.status.as_deref(), Some("warn"));
        assert_eq!(claude.meta["error"], json!("no cli"));
        assert_eq!(
            g.nodes
                .iter()
                .find(|n| n.id == "check:db")
                .unwrap()
                .status
                .as_deref(),
            Some("ok")
        );
    }

    #[test]
    fn cross_hub_edges_only_where_the_data_states_them() {
        let snap = snapshot(
            r#"{"knowledge":{"codeGraph":[{"repoId":"example-repo","commitSha":"abc"}]},
              "tokens":{"bySource":[{"source":"auto-task","calls":1,"billable":0}]}}"#,
        );
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let indexes = os
            .edges
            .iter()
            .find(|e| e.source == "hub:knowledge" && e.target == "hub:code")
            .expect("knowledge indexes the code hub");
        assert_eq!(indexes.kind, "indexes");
        assert_eq!(indexes.label.as_deref(), Some("indexed code graphs"));
        // Auto Task usage is not the routines list: no routines-to-models edge.
        assert!(!os
            .edges
            .iter()
            .any(|e| e.source == "hub:routines" || e.target == "hub:routines"));

        let quiet = build_os_graph(&OsVizInput::default());
        assert!(!quiet.edges.iter().any(|e| e.kind == "relates"));
    }

    #[test]
    fn os_members_are_capped_largest_first_with_a_more_count() {
        let mut snap = OsSnapshotFull::default();
        for i in 0..50 {
            snap.knowledge.project_memory.push(OsProjectMemory {
                repo_root: format!("/repos/r{i:02}"),
                facts: i as f64,
                active: 1.0,
                ..OsProjectMemory::default()
            });
        }
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let hub = os.nodes.iter().find(|n| n.id == "hub:memory").unwrap();
        assert_eq!(hub.meta["members"], json!(50));
        assert_eq!(hub.meta["more"], json!(10));
        let shown: Vec<&VizNode> = os.nodes.iter().filter(|n| n.kind == "memoryRepo").collect();
        assert_eq!(shown.len(), OS_MEMBER_CAP);
        // The smallest repos are the ones dropped.
        assert!(!shown.iter().any(|n| n.id == "memory:/repos/r00"));
        assert!(shown.iter().any(|n| n.id == "memory:/repos/r49"));
        // Spokes never point at a dropped member.
        assert!(os.edges.iter().all(|e| {
            os.nodes.iter().any(|n| n.id == e.target) && os.nodes.iter().any(|n| n.id == e.source)
        }));
    }

    #[test]
    fn output_is_independent_of_input_order() {
        let text = r#"{"tokens":{"byModel":[
              {"provider":"b","model":"m2","billable":5},{"provider":"a","model":"m1","billable":5},
              {"provider":"a","model":"m3","billable":1}]}}"#;
        let shuffled = r#"{"tokens":{"byModel":[
              {"provider":"a","model":"m3","billable":1},{"provider":"a","model":"m1","billable":5},
              {"provider":"b","model":"m2","billable":5}]}}"#;
        let a = build_os_view(&OsVizInput {
            snapshot: Some(snapshot(text)),
            ..OsVizInput::default()
        });
        let b = build_os_view(&OsVizInput {
            snapshot: Some(snapshot(shuffled)),
            ..OsVizInput::default()
        });
        assert_eq!(a, b);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn lenient_input_ignores_bad_fields_and_unknown_keys() {
        let text = r#"{"snapshot":{"system":"nope","running":{"chatTurns":[7,{"chatSessionId":"ok"}]},
              "tokens":{"totals":{"billable":"lots"},"byModel":[{"provider":"p","model":"m","billable":4}]},
              "extra":true},
              "skills":[{"id":"s1","name":"one"},"bad",{"name":"no id"}],
              "routines":[{"id":"r1","enabled":"yes"},{"id":"r2","title":"ok","enabled":true}],
              "code":{"totalNodes":3,"communities":"x"}}"#;
        let input: OsVizInput = serde_json::from_str(text).expect("lenient");
        assert_eq!(input.skills.len(), 2);
        // A routine whose `enabled` is not a boolean does not fit and is dropped.
        assert_eq!(input.routines.len(), 1);
        assert_eq!(input.routines[0].id, "r2");
        assert!(input.routines[0].enabled);
        let snap = input.snapshot.as_ref().expect("snapshot");
        assert!(snap.system.kits.is_empty());
        assert_eq!(snap.running.chat_turns.len(), 1);
        assert_eq!(snap.tokens.by_model.len(), 1);
        let g = build_os_graph(&input);
        assert!(g.nodes.iter().any(|n| n.id == "model:p/m"));
        let agents = build_hub_graph("agents", &input).unwrap();
        assert!(agents.nodes.iter().any(|n| n.id == "chatTurn:ok"));
    }

    #[test]
    fn code_summary_reports_top_communities_largest_first() {
        use crate::builder::{build_system_graph, BuildOptions};
        use crate::models::CGData;
        let project: CGData = serde_json::from_str(
            r#"{"nodes":[
                {"id":"a.ts","title":"a","kind":"file","metadata":{"path":"src/a.ts"}},
                {"id":"b.ts","title":"b","kind":"file","metadata":{"path":"src/b.ts"}},
                {"id":"c.ts","title":"c","kind":"file","metadata":{"path":"src/c.ts"}},
                {"id":"d.md","title":"d","kind":"docPage","metadata":{"path":"docs/d.md"}}],
              "edges":[{"fromId":"a.ts","toId":"b.ts"},{"fromId":"b.ts","toId":"c.ts"},
                       {"fromId":"d.md","toId":"d.md"}]}"#,
        )
        .unwrap();
        let graph = build_system_graph(None, Some(&project), &BuildOptions::default());
        let summary = code_summary(&graph, 5);
        assert_eq!(summary.total_nodes, 4);
        assert_eq!(summary.kept_nodes, 4);
        assert_eq!(summary.community_count, 2);
        assert_eq!(summary.communities[0].size, 3);
        assert_eq!(summary.communities[0].dominant_category, "code");
        assert_eq!(summary.communities[0].top_labels.len(), 3);
        assert_eq!(summary.communities[1].dominant_category, "docs");
        assert_eq!(code_summary(&graph, 1).communities.len(), 1);
    }

    #[test]
    fn hub_ids_are_stable_and_every_edge_has_both_ends() {
        let snap = snapshot(
            r#"{"knowledge":{"sources":{"byKind":[{"kind":"code","count":1}]},"meetings":{"count":0},
                "pendingReviews":1,"outcomes":{"byState":{"open":1,"merged":2}},
                "codeGraph":[{"repoId":"r","commitSha":"x"}]},
               "system":{"kits":[{"id":"k","requires":["f"],"enabled":true}]}}"#,
        );
        let input = OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        };
        let view = build_os_view(&input);
        assert!(view.hubs.contains_key("knowledge"));
        assert!(!view.hubs.contains_key("code"));
        let k = &view.hubs["knowledge"];
        assert!(k.nodes.iter().any(|n| n.id == "outcome:merged"));
        assert!(k.nodes.iter().any(|n| n.id == "codegraph:r"));
        assert_eq!(
            k.nodes
                .iter()
                .find(|n| n.id == "knowledge:reviews")
                .unwrap()
                .status
                .as_deref(),
            Some("warn")
        );
        for g in std::iter::once(&view.os).chain(view.hubs.values()) {
            let known: BTreeSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
            assert_eq!(known.len(), g.nodes.len(), "{}: duplicate ids", g.level);
            for e in &g.edges {
                assert!(
                    known.contains(e.source.as_str()),
                    "{}: {}",
                    g.level,
                    e.source
                );
                assert!(
                    known.contains(e.target.as_str()),
                    "{}: {}",
                    g.level,
                    e.target
                );
            }
        }
    }

    fn input_of(snap: OsSnapshotFull) -> OsVizInput {
        OsVizInput {
            snapshot: Some(snap),
            ..OsVizInput::default()
        }
    }

    #[test]
    fn non_array_list_fields_are_empty_and_never_fail_the_call() {
        let text = r#"{"skills":{"a":1},"routines":"none","code":{"communities":5},
              "snapshot":{"system":{"kits":{"x":1}},"tokens":{"totals":{"billable":5},"byModel":{"p":"m"}},
              "knowledge":{"sources":{"byKind":7}},"running":{"chatTurns":null}}}"#;
        let input: OsVizInput =
            serde_json::from_str(text).expect("a non-array list is empty, not an error");
        assert!(input.skills.is_empty());
        assert!(input.routines.is_empty());
        let snap = input.snapshot.as_ref().expect("snapshot");
        assert!(snap.system.kits.is_empty());
        assert!(snap.tokens.by_model.is_empty());
        assert!(snap.knowledge.sources.by_kind.is_empty());
        assert!(snap.running.chat_turns.is_empty());
        // The rest of the snapshot still counts.
        assert_eq!(snap.tokens.totals.billable, 5.0);
        assert_eq!(build_os_view(&input).hubs.len(), 8);
    }

    #[test]
    fn absent_checks_are_unknown_not_a_failure() {
        let input = input_of(snapshot(
            r#"{"system":{"kits":[{"id":"graph-kit","requires":[],"enabled":true}]}}"#,
        ));
        let os = build_os_graph(&input);
        let hub = os.nodes.iter().find(|n| n.id == "hub:kits").unwrap();
        assert_eq!(hub.status.as_deref(), Some("unknown"));
        assert_eq!(hub.meta["checksOk"], Value::Null);
        let g = build_hub_graph("kits", &input).unwrap();
        assert!(!g.nodes.iter().any(|n| n.kind == "check"));
        assert_eq!(g.nodes[0].meta["members"], json!(1));

        // A kit that is off still warns: that is the kits' own state.
        let off = input_of(snapshot(
            r#"{"system":{"kits":[{"id":"k","requires":[],"enabled":false}]}}"#,
        ));
        let hub = build_os_graph(&off)
            .nodes
            .into_iter()
            .find(|n| n.id == "hub:kits")
            .unwrap();
        assert_eq!(hub.status.as_deref(), Some("warn"));

        // Checks that are present and failing warn; present and passing are ok.
        let failing = input_of(snapshot(
            r#"{"system":{"kits":[{"id":"k","requires":[],"enabled":true}],
              "checks":{"db":true,"claude":true,"skills":false}}}"#,
        ));
        let hub = build_os_graph(&failing)
            .nodes
            .into_iter()
            .find(|n| n.id == "hub:kits")
            .unwrap();
        assert_eq!(hub.status.as_deref(), Some("warn"));
        let passing = input_of(snapshot(
            r#"{"system":{"kits":[{"id":"k","requires":[],"enabled":true}],
              "checks":{"db":true,"claude":true,"skills":true}}}"#,
        ));
        let hub = build_os_graph(&passing)
            .nodes
            .into_iter()
            .find(|n| n.id == "hub:kits")
            .unwrap();
        assert_eq!(hub.status.as_deref(), Some("ok"));
        assert_eq!(hub.meta["checksOk"], json!(true));
    }

    #[test]
    fn kits_outrank_features_under_the_os_cap_and_enabled_kits_come_first() {
        let kits: Vec<String> = (0..30)
            .map(|i| {
                format!(
                    r#"{{"id":"kit-{i:02}","requires":["feat-{i:02}"],"enabled":{}}}"#,
                    i % 2 == 0
                )
            })
            .collect();
        let text = format!(
            r#"{{"system":{{"kits":[{}],"checks":{{"db":true,"claude":true,"skills":true}}}}}}"#,
            kits.join(",")
        );
        let os = build_os_graph(&input_of(snapshot(&text)));
        let hub = os.nodes.iter().find(|n| n.id == "hub:kits").unwrap();
        assert_eq!(hub.meta["members"], json!(60));
        assert_eq!(hub.meta["more"], json!(20));
        // All 30 kits are shown; the 10 features that fit come after them.
        assert_eq!(os.nodes.iter().filter(|n| n.kind == "kit").count(), 30);
        assert_eq!(os.nodes.iter().filter(|n| n.kind == "feature").count(), 10);
        // Enabled kits (even indexes) before the disabled ones.
        let order: Vec<&str> = os
            .nodes
            .iter()
            .filter(|n| n.kind == "kit")
            .map(|n| n.id.as_str())
            .collect();
        let first_disabled = order
            .iter()
            .position(|id| *id == "kit:kit-01")
            .expect("kit-01 is shown");
        assert!(order[..first_disabled].iter().all(|id| id
            .trim_start_matches("kit:kit-")
            .parse::<u32>()
            .unwrap()
            % 2
            == 0));
    }

    #[test]
    fn skills_drill_down_caps_each_source_alphabetically_with_more() {
        let skills: Vec<Skill> = (0..70)
            .map(|i| Skill {
                id: format!("s{i:02}"),
                name: format!("skill {i:02}"),
                description: None,
                source: Some("kit".into()),
            })
            .collect();
        let input = OsVizInput {
            skills,
            ..OsVizInput::default()
        };
        let g = build_hub_graph("skills", &input).unwrap();
        assert_eq!(
            g.nodes.iter().filter(|n| n.kind == "skill").count(),
            DRILL_MEMBER_CAP
        );
        let source = g.nodes.iter().find(|n| n.id == "skillSource:kit").unwrap();
        assert_eq!(source.meta["count"], json!(70));
        assert_eq!(source.meta["more"], json!(10));
        assert_eq!(g.nodes[0].meta["members"], json!(70));
        assert_eq!(g.nodes[0].meta["more"], json!(10));
        // The first 60 by name are kept; the last ten are not.
        assert!(g.nodes.iter().any(|n| n.id == "skill:s59"));
        assert!(!g.nodes.iter().any(|n| n.id == "skill:s60"));
    }

    #[test]
    fn duplicate_model_rows_are_summed_not_dropped() {
        let input = input_of(snapshot(
            r#"{"tokens":{"totals":{"billable":30},"byModel":[
              {"provider":"anthropic","model":"m","billable":10,"input":5,"cacheRead":5},
              {"provider":"anthropic","model":"m","billable":20,"input":5,"cacheRead":15,"calls":2}]}}"#,
        ));
        let g = build_hub_graph("models", &input).unwrap();
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "model").count(), 1);
        let m = g
            .nodes
            .iter()
            .find(|n| n.id == "model:anthropic/m")
            .unwrap();
        assert_eq!(m.meta["billable"], json!(30));
        assert_eq!(m.meta["input"], json!(10));
        assert_eq!(m.meta["cacheRead"], json!(20));
        assert_eq!(m.meta["calls"], json!(2));
        assert_eq!(m.meta["share"], json!(1.0));
    }

    #[test]
    fn models_drill_down_has_three_labelled_dimensions_with_share_and_cache_ratio() {
        let input = input_of(snapshot(
            r#"{"tokens":{"totals":{"billable":100},
              "byModel":[{"provider":"anthropic","model":"a","billable":75,"input":100,"cacheRead":300,"cacheWrite":100},
                         {"provider":"openai","model":"b","billable":25}],
              "bySource":[{"source":"api","billable":100,"calls":3}],
              "byEndpoint":[{"endpoint":"/x","billable":100,"calls":3},{"endpoint":null,"billable":0}]}}"#,
        ));
        let g = build_hub_graph("models", &input).unwrap();
        for (id, label) in [
            ("group:by-model", "By model"),
            ("group:by-caller", "By caller"),
            ("group:by-endpoint", "By endpoint"),
        ] {
            let n = g.nodes.iter().find(|n| n.id == id).unwrap();
            assert_eq!(n.kind, "group");
            assert!(n.labelled);
            assert_eq!(n.label, label);
        }
        // Each row sits under its own dimension.
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "group:by-model" && e.target == "provider:anthropic"));
        assert!(g.edges.iter().any(|e| e.source == "provider:anthropic"
            && e.target == "model:anthropic/a"
            && e.kind == "provides"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "group:by-caller" && e.target == "caller:api"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "group:by-endpoint" && e.target == "endpoint:/x"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "group:by-endpoint" && e.target == "endpoint:"));

        let a = g
            .nodes
            .iter()
            .find(|n| n.id == "model:anthropic/a")
            .unwrap();
        assert_eq!(a.meta["share"], json!(0.75));
        // 300 / (100 + 300 + 100).
        assert!((a.meta["cacheHitRatio"].as_f64().unwrap() - 0.6).abs() < 1e-12);
        let b = g.nodes.iter().find(|n| n.id == "model:openai/b").unwrap();
        assert_eq!(b.meta["cacheHitRatio"], json!(0.0));
        let caller = g.nodes.iter().find(|n| n.id == "caller:api").unwrap();
        assert_eq!(caller.meta["share"], json!(1.0));
        let note = g.nodes[0].meta["note"].as_str().unwrap();
        assert!(note.contains("same total"), "{note}");
    }

    #[test]
    fn share_and_cache_ratio_are_zero_when_their_total_is_zero() {
        let input = input_of(snapshot(
            r#"{"tokens":{"byModel":[{"provider":"p","model":"m","billable":0,"input":0}]}}"#,
        ));
        let g = build_hub_graph("models", &input).unwrap();
        let m = g.nodes.iter().find(|n| n.id == "model:p/m").unwrap();
        assert_eq!(m.meta["share"], json!(0.0));
        assert_eq!(m.meta["cacheHitRatio"], json!(0.0));
    }

    #[test]
    fn hub_meta_carries_last_indexed_and_last_run_and_ids_are_prefixed() {
        let input = OsVizInput {
            snapshot: Some(snapshot(
                r#"{"knowledge":{"meetings":{"count":3},"sources":{"byKind":[
                  {"kind":"box","count":2,"lastIndexedAt":"2026-10-20T00:00:00Z"},
                  {"kind":"email","count":1,"lastIndexedAt":"2026-10-26T09:00:00Z"}]}}}"#,
            )),
            routines: vec![
                Routine {
                    id: "r1".into(),
                    last_run_at: Some("2026-10-25T00:00:00Z".into()),
                    ..Routine::default()
                },
                Routine {
                    id: "r2".into(),
                    last_run_at: Some("2026-10-26T00:00:00Z".into()),
                    ..Routine::default()
                },
            ],
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let k = os.nodes.iter().find(|n| n.id == "hub:knowledge").unwrap();
        assert_eq!(k.meta["lastIndexedAt"], json!("2026-10-26T09:00:00Z"));
        let r = os.nodes.iter().find(|n| n.id == "hub:routines").unwrap();
        assert_eq!(r.meta["lastRunAt"], json!("2026-10-26T00:00:00Z"));
        // The drill-down centre carries the same meta, and the ids are prefixed.
        let kd = build_hub_graph("knowledge", &input).unwrap();
        assert_eq!(
            kd.nodes[0].meta["lastIndexedAt"],
            json!("2026-10-26T09:00:00Z")
        );
        assert_eq!(kd.nodes[0].meta["members"], json!(kd.nodes.len() - 1));
        assert!(kd.nodes.iter().any(|n| n.id == "knowledge:meetings"));
        assert!(!kd.nodes.iter().any(|n| n.id == "meetings"));
    }

    #[test]
    fn routines_rank_enabled_first_then_soonest_next_run() {
        let r = |id: &str, enabled: bool, next: Option<&str>| Routine {
            id: id.into(),
            title: id.into(),
            next_run_at: next.map(str::to_owned),
            enabled,
            ..Routine::default()
        };
        let input = OsVizInput {
            routines: vec![
                r("a", true, Some("2026-10-30T00:00:00Z")),
                r("c", true, None),
                r("d", false, Some("2026-10-01T00:00:00Z")),
                r("b", true, Some("2026-10-28T00:00:00Z")),
            ],
            ..OsVizInput::default()
        };
        let g = build_hub_graph("routines", &input).unwrap();
        let order: Vec<&str> = g
            .nodes
            .iter()
            .filter(|n| n.kind == "routine")
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(order, ["routine:b", "routine:a", "routine:c", "routine:d"]);
        let enabled = g.nodes.iter().find(|n| n.id == "routines:enabled").unwrap();
        assert_eq!(enabled.kind, "group");
        assert_eq!(enabled.meta["count"], json!(3));
    }

    #[test]
    fn running_agents_rank_newest_start_first() {
        let input = input_of(snapshot(
            r#"{"running":{"chatTurns":[
              {"chatSessionId":"a","startedAt":"2026-10-01T00:00:00Z"},
              {"chatSessionId":"b","startedAt":"2026-10-03T00:00:00Z"},
              {"chatSessionId":"c","startedAt":"2026-10-02T00:00:00Z"},
              {"chatSessionId":"d"}]}}"#,
        ));
        let g = build_hub_graph("agents", &input).unwrap();
        let order: Vec<&str> = g
            .nodes
            .iter()
            .filter(|n| n.kind == "chatTurn")
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(
            order,
            ["chatTurn:b", "chatTurn:c", "chatTurn:a", "chatTurn:d"]
        );
    }

    #[test]
    fn cluster_index_at_the_top_of_usize_saturates_instead_of_overflowing() {
        let input = OsVizInput {
            code: Some(CodeSummary {
                communities: vec![CommunitySummary {
                    index: usize::MAX,
                    size: 1,
                    dominant_category: "code".into(),
                    top_labels: vec!["x".into()],
                }],
                ..CodeSummary::default()
            }),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let cluster = os.nodes.iter().find(|n| n.kind == "codeCluster").unwrap();
        assert!(cluster.label.starts_with("Cluster "), "{}", cluster.label);
    }

    #[test]
    fn no_invented_edges_from_the_code_or_routines_hubs() {
        let input = input_of(snapshot(
            r#"{"system":{"kits":[{"id":"graph-kit","requires":["code_graph_3d"],"enabled":true}]},
              "tokens":{"bySource":[{"source":"auto-task","calls":4,"billable":9}],
                        "byModel":[{"provider":"p","model":"m","billable":9}]}}"#,
        ));
        let os = build_os_graph(&input);
        assert!(!os.edges.iter().any(|e| e.source == "hub:code"));
        assert!(!os
            .edges
            .iter()
            .any(|e| e.source == "hub:routines" || e.target == "hub:routines"));
    }

    /// An OS input whose activity feed holds `n` rows, newest first (ids `n` down to 1).
    /// Even rows are `meeting_added` with a detail object; odd rows are `knowledge_updated`.
    fn activity_input(n: usize, unread: u32) -> OsVizInput {
        let items: Vec<Value> = (0..n)
            .map(|i| {
                let id = n - i;
                let even = id.is_multiple_of(2);
                json!({
                    "id": id,
                    "kind": if even { "meeting_added" } else { "knowledge_updated" },
                    "title": format!("Row {id}"),
                    "detail": if even { json!({"count": id}) } else { Value::Null },
                    "link": if even { Value::Null } else { json!("https://example.com/x") },
                    "createdAt": format!("2026-10-{:02} 09:00:00", 1 + (id % 27)),
                })
            })
            .collect();
        let text = json!({"activity": {"unread": unread, "items": items}}).to_string();
        OsVizInput {
            snapshot: Some(snapshot(&text)),
            ..OsVizInput::default()
        }
    }

    fn activity_hub(g: &VizGraph) -> &VizNode {
        g.nodes.iter().find(|n| n.id == "hub:activity").expect("activity hub")
    }

    #[test]
    fn activity_hub_is_the_ninth_hub_and_shows_the_newest_24_rows() {
        let input = activity_input(30, 4);
        let os = build_os_graph(&input);
        let hub = activity_hub(&os);
        assert_eq!(hub.kind, "hub");
        assert_eq!(hub.group, 8);
        assert_eq!(hub.drill.as_deref(), Some("activity"));
        assert_eq!(hub.status.as_deref(), Some("ok"));
        assert_eq!(hub.size, 6.0);
        assert_eq!(hub.meta["members"], json!(30));
        assert_eq!(hub.meta["more"], json!(6));
        assert_eq!(hub.meta["unread"], json!(4));
        // The newest timestamp of the whole feed (the maximum, not the first row's).
        assert_eq!(hub.meta["newestAt"], json!("2026-10-27 09:00:00"));
        let members: Vec<&VizNode> = os.nodes.iter().filter(|n| n.group == 8 && n.kind != "hub").collect();
        assert_eq!(members.len(), 24);
        // Newest first: the first input row is `activity:30`, the 24th is `activity:7`.
        assert_eq!(members[0].id, "activity:30");
        assert_eq!(members[23].id, "activity:7");
        assert!(members.iter().all(|m| m.kind == "activity" && m.status.is_none()));
        // Size falls from 1.0 (newest) to 0.6 (the 24th row), linearly.
        assert_eq!(members[0].size, 1.0);
        assert!((members[23].size - (1.0 - 0.4 * 23.0 / 29.0)).abs() < 1e-12);
        for m in &members {
            assert!(os.edges.iter().any(|e| e.source == "hub:activity"
                && e.target == m.id
                && e.kind == "member"));
        }
    }

    #[test]
    fn activity_member_meta_carries_title_kind_time_link_and_detail() {
        let os = build_os_graph(&activity_input(2, 0));
        let even = os.nodes.iter().find(|n| n.id == "activity:2").unwrap();
        assert_eq!(even.label, "Row 2");
        assert_eq!(even.meta["title"], json!("Row 2"));
        assert_eq!(even.meta["activityKind"], json!("meeting_added"));
        assert_eq!(even.meta["createdAt"], json!("2026-10-03 09:00:00"));
        assert_eq!(even.meta["link"], Value::Null);
        assert_eq!(even.meta["detail"], json!({"count": 2}));
        let odd = os.nodes.iter().find(|n| n.id == "activity:1").unwrap();
        assert_eq!(odd.meta["activityKind"], json!("knowledge_updated"));
        assert_eq!(odd.meta["link"], json!("https://example.com/x"));
        assert_eq!(odd.meta["detail"], Value::Null);
    }

    #[test]
    fn activity_drill_caps_at_60_and_groups_by_kind() {
        let input = activity_input(70, 0);
        let g = build_hub_graph("activity", &input).expect("activity drill");
        assert_eq!(g.level, "activity");
        let centre = &g.nodes[0];
        assert_eq!(centre.id, "hub:activity");
        assert_eq!(centre.meta["members"], json!(70));
        assert_eq!(centre.meta["more"], json!(10));
        let items: Vec<&VizNode> = g.nodes.iter().filter(|n| n.kind == "activity").collect();
        assert_eq!(items.len(), DRILL_MEMBER_CAP);
        // The cap keeps the newest 60 (ids 70 down to 11).
        assert!(items.iter().any(|n| n.id == "activity:11"));
        assert!(!items.iter().any(|n| n.id == "activity:10"));
        let groups: Vec<&VizNode> = g.nodes.iter().filter(|n| n.kind == "group").collect();
        assert_eq!(groups.len(), 2);
        let meeting = groups.iter().find(|n| n.id == "group:activity:meeting_added").unwrap();
        assert_eq!(meeting.label, "Meeting added");
        assert!(meeting.labelled);
        assert_eq!(meeting.meta["count"], json!(30));
        let knowledge = groups.iter().find(|n| n.id == "group:activity:knowledge_updated").unwrap();
        assert_eq!(knowledge.label, "Knowledge updated");
        assert_eq!(knowledge.meta["count"], json!(30));
        // Every item hangs off its kind's group, and every group off the hub.
        for item in &items {
            let group = if item.meta["activityKind"] == json!("meeting_added") {
                "group:activity:meeting_added"
            } else {
                "group:activity:knowledge_updated"
            };
            assert!(g.edges.iter().any(|e| e.source == item.id && e.target == group));
            let group_node = groups.iter().find(|n| n.id == group).unwrap();
            assert_eq!(item.group, group_node.group, "{} shares its group's anchor", item.id);
        }
        for group in &groups {
            assert!(g.edges.iter().any(|e| e.source == "hub:activity" && e.target == group.id));
        }
    }

    #[test]
    fn activity_drill_labels_groups_and_the_eight_newest_items() {
        let g = build_hub_graph("activity", &activity_input(20, 0)).unwrap();
        for n in &g.nodes {
            if n.kind == "group" || n.kind == "hub" {
                assert!(n.labelled, "{} is labelled", n.id);
            }
        }
        let labelled: Vec<&str> = g
            .nodes
            .iter()
            .filter(|n| n.kind == "activity" && n.labelled)
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(labelled.len(), ACTIVITY_LABELLED);
        for id in ["activity:20", "activity:13"] {
            assert!(labelled.contains(&id), "{id} is among the 8 newest");
        }
        assert!(!labelled.contains(&"activity:12"));
    }

    #[test]
    fn empty_activity_is_the_hub_centre_only_and_off() {
        let os = build_os_graph(&OsVizInput::default());
        let hub = activity_hub(&os);
        assert_eq!(hub.status.as_deref(), Some("off"));
        assert_eq!(hub.meta["members"], json!(0));
        assert_eq!(hub.meta["more"], json!(0));
        assert_eq!(hub.meta["unread"], json!(0));
        assert_eq!(hub.meta["newestAt"], Value::Null);
        assert!(!os.edges.iter().any(|e| e.source == "hub:activity"));
        let drill = build_hub_graph("activity", &OsVizInput::default()).unwrap();
        assert_eq!(drill.nodes.len(), 1);
        assert_eq!(drill.nodes[0].id, "hub:activity");
        assert!(drill.edges.is_empty());
    }

    #[test]
    fn malformed_activity_rows_are_skipped_and_the_rest_counts() {
        let text = r#"{"activity":{"unread":"lots","items":[
            {"id":5,"kind":"meeting_added","title":"ok","createdAt":"2026-10-02 10:00:00","detail":[1]},
            {"id":true,"kind":"x","title":"bad id"},
            {"kind":"x","title":"no id"},
            {"id":6,"title":"no kind"},
            {"id":"","kind":"x","title":"empty id"},
            {"id":5,"kind":"meeting_added","title":"duplicate of 5"},
            "not an object",
            null,
            {"id":"s-1","kind":"knowledge_updated","title":"","link":42,"createdAt":""}
        ]}}"#;
        let input = OsVizInput {
            snapshot: Some(snapshot(text)),
            ..OsVizInput::default()
        };
        let os = build_os_graph(&input);
        let hub = activity_hub(&os);
        // Two usable rows: 5 (first wins over its duplicate) and "s-1". Unread is not a count.
        assert_eq!(hub.meta["members"], json!(2));
        assert_eq!(hub.meta["unread"], json!(0));
        assert_eq!(hub.meta["newestAt"], json!("2026-10-02 10:00:00"));
        let five = os.nodes.iter().find(|n| n.id == "activity:5").unwrap();
        assert_eq!(five.meta["title"], json!("ok"));
        // A non-object detail is kept as null.
        assert_eq!(five.meta["detail"], Value::Null);
        let s1 = os.nodes.iter().find(|n| n.id == "activity:s-1").unwrap();
        // An empty title falls back to the kind's label; an empty createdAt is null.
        assert_eq!(s1.label, "Knowledge updated");
        assert_eq!(s1.meta["createdAt"], Value::Null);
        assert_eq!(s1.meta["link"], Value::Null);
        assert_eq!(s1.size, 0.6);
    }

    #[test]
    fn activity_ids_are_prefixed_unique_and_input_order_independent() {
        let a = activity_input(10, 1);
        let g = build_hub_graph("activity", &a).unwrap();
        let mut ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before);
        assert!(g.nodes.iter().filter(|n| n.kind == "activity").all(|n| n.id.starts_with("activity:")));
        assert!(g.nodes.iter().filter(|n| n.kind == "group").all(|n| n.id.starts_with("group:activity:")));
        // Edges are sorted, as every graph's are.
        let sorted = g.edges.windows(2).all(|w| js_cmp(&w[0].source, &w[1].source) != Ordering::Greater);
        assert!(sorted);
    }
}
