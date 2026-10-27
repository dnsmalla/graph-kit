//! Deterministic 3D "orbit" layout (canonical; the TypeScript layout it was ported from is removed).
//!
//! Same algorithm, constants, floating-point expression order and iteration order as
//! the TS, so the output is the same up to the last ulp of `sin`/`cos`/`cbrt` (V8 and
//! Rust's libm are not guaranteed bit-identical for those; `tests/parity.rs` measures it).

use crate::builder::SystemGraph;
use crate::models::lenient_f64;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Most relaxation steps run, whatever `iterations` asks for. The TS has no cap; a page
/// passing `1e300` would otherwise hang. Goldens stay below this.
pub const MAX_ITERATIONS: f64 = 10_000.0;

/// Largest radius used. Above this the squared norms overflow to infinity and output
/// coordinates would be non-finite (serialized as `null`). The TS has no cap.
pub const MAX_RADIUS: f64 = 1e150;

/// Options. `None` means "use the default" (as in the TS, invalid values also fall back).
/// Non-number values count as unset, the TS `typeof` check. See the README for the clamps.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbitOptions {
    /// Radius of the core sphere. Default 100.
    #[serde(default, deserialize_with = "lenient_f64")]
    pub core_radius: Option<f64>,
    /// Radius of the activity ring (plane y = 0). Default 170.
    #[serde(default, deserialize_with = "lenient_f64")]
    pub ring_radius: Option<f64>,
    /// Relaxation steps over the core. Default 60. Clamped to [`MAX_ITERATIONS`].
    #[serde(default, deserialize_with = "lenient_f64")]
    pub iterations: Option<f64>,
    /// PRNG seed for the initial scatter. Default 1.
    #[serde(default, deserialize_with = "lenient_f64")]
    pub seed: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bounds {
    pub radius: f64,
}

/// `core` and `ring` are ordered maps in the TS (insertion order). They serialize as
/// arrays of `[id, {x, y, z}]`, the form the golden files use.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbitLayout {
    pub core: Vec<(String, Vec3)>,
    pub ring: Vec<(String, Vec3)>,
    /// Index = COMPACTED community index (distinct values present, ascending -> 0..k-1).
    pub community_centers: Vec<Vec3>,
    pub bounds: Bounds,
}

const TAU: f64 = std::f64::consts::PI * 2.0;
const ORIGIN: Vec3 = Vec3 {
    x: 0.0,
    y: 0.0,
    z: 0.0,
};
/// Per-step pull toward the weighted neighbour mean.
const EDGE_PULL: f64 = 0.02;
/// Per-step spring toward the initial scattered position.
const ANCHOR_PULL: f64 = 0.05;
/// Max per-step expansion factor for a community below its target RMS radius.
const MAX_VOLUME_GAIN: f64 = 1.2;

/// `ToUint32`: truncate, then wrap modulo 2^32. Non-finite becomes 0.
fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4_294_967_296.0) as u32
}

/// Deterministic PRNG (mulberry32). Returns floats in [0, 1). Uses u32 wrapping
/// arithmetic, which is bit-identical to the JS `Math.imul` / `>>> 0` sequence.
pub fn mulberry32(seed: f64) -> impl FnMut() -> f64 {
    let mut a = to_uint32(seed);
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// `n` points spread evenly on a sphere of the given radius (golden spiral).
pub fn fibonacci_sphere(n: usize, radius: f64) -> Vec<Vec3> {
    match n {
        0 => Vec::new(),
        1 => vec![Vec3 {
            x: 0.0,
            y: 0.0,
            z: radius,
        }],
        count => {
            let golden = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
            (0..count)
                .map(|i| {
                    let y = 1.0 - (i as f64 / (count - 1) as f64) * 2.0;
                    let r = (1.0 - y * y).max(0.0).sqrt();
                    let theta = golden * i as f64;
                    Vec3 {
                        x: theta.cos() * r * radius,
                        y: y * radius,
                        z: theta.sin() * r * radius,
                    }
                })
                .collect()
        }
    }
}

/// A positive radius, clamped to [`MAX_RADIUS`]; `fallback` when missing or not positive.
fn positive(v: Option<f64>, fallback: f64) -> f64 {
    match v {
        Some(x) if x.is_finite() && x > 0.0 => x.min(MAX_RADIUS),
        _ => fallback,
    }
}

/// Floored non-negative value, or `fallback` when missing / non-finite / negative.
fn non_neg_int(v: Option<f64>, fallback: f64) -> f64 {
    match v {
        Some(x) if x.is_finite() && x >= 0.0 => x.floor(),
        _ => fallback,
    }
}

fn norm(p: Vec3) -> f64 {
    (p.x * p.x + p.y * p.y + p.z * p.z).sqrt()
}

/// Lay out a [`SystemGraph`] in 3D. See the TS doc comment on `orbitLayout` for the model.
pub fn orbit_layout(graph: &SystemGraph, opts: &OrbitOptions) -> OrbitLayout {
    let core: Vec<(&str, Option<f64>)> = graph
        .core
        .iter()
        .map(|n| (n.id.as_str(), Some(n.community as f64)))
        .collect();
    let edges: Vec<(&str, &str, f64)> = graph
        .edges
        .iter()
        .map(|e| (e.source.as_str(), e.target.as_str(), e.weight as f64))
        .collect();
    let ring: Vec<&str> = graph.ring.iter().map(|r| r.id.as_str()).collect();
    layout_raw(&core, &edges, &ring, opts)
}

/// The layout over raw inputs: core `(id, community)`, edges `(source, target, weight)` and
/// ring ids. A missing community (`None`) and a non-finite weight both count as the TS does
/// for non-numbers: community 0, weight 0 (the edge is dropped). Negative or fractional
/// communities are floored / defaulted as in the TS `nonNegInt`. [`orbit_layout`] is this
/// over a [`SystemGraph`]; the split lets the JSON boundary feed it lenient inputs.
pub(crate) fn layout_raw(
    core_nodes: &[(&str, Option<f64>)],
    edges: &[(&str, &str, f64)],
    ring_ids: &[&str],
    opts: &OrbitOptions,
) -> OrbitLayout {
    let core_radius = positive(opts.core_radius, 100.0);
    let ring_radius = positive(opts.ring_radius, 170.0);
    let iterations = non_neg_int(opts.iterations, 60.0).min(MAX_ITERATIONS) as usize;
    let mut rng = mulberry32(opts.seed.unwrap_or(1.0));

    // ---- Core: index nodes (first occurrence wins on duplicate ids).
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut ids: Vec<&str> = Vec::new();
    let mut raw_community: Vec<f64> = Vec::new();
    for &(id, community) in core_nodes {
        if index.contains_key(id) {
            continue;
        }
        index.insert(id, ids.len());
        ids.push(id);
        raw_community.push(non_neg_int(community, 0.0));
    }
    let n = ids.len();

    // Compact community ids: distinct values present, ascending -> 0..k-1.
    let mut distinct = raw_community.clone();
    distinct.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    distinct.dedup();
    let k = distinct.len();
    let community: Vec<usize> = raw_community
        .iter()
        .map(|v| distinct.partition_point(|d| d < v))
        .collect();

    let mut sizes = vec![0usize; k];
    for &c in &community {
        sizes[c] += 1;
    }
    let largest = sizes.iter().copied().max().unwrap_or(0);

    // A single community sits at the origin.
    let community_centers: Vec<Vec3> = if k == 1 {
        vec![ORIGIN]
    } else {
        fibonacci_sphere(k, core_radius * 0.7)
    };
    let mut cx = vec![0.0f64; n];
    let mut cy = vec![0.0f64; n];
    let mut cz = vec![0.0f64; n];
    for i in 0..n {
        let center = community_centers
            .get(community[i])
            .copied()
            .unwrap_or(ORIGIN);
        cx[i] = center.x;
        cy[i] = center.y;
        cz[i] = center.z;
    }

    // Edges as index pairs. Self-loops, dangling endpoints and non-positive weights are dropped.
    let mut ea: Vec<usize> = Vec::new();
    let mut eb: Vec<usize> = Vec::new();
    let mut ew: Vec<f64> = Vec::new();
    for &(s, t, weight) in edges {
        let (Some(&a), Some(&b)) = (index.get(s), index.get(t)) else {
            continue;
        };
        if a == b {
            continue;
        }
        let w = if weight.is_finite() {
            weight.clamp(0.0, 4.0)
        } else {
            0.0
        };
        if w <= 0.0 {
            continue;
        }
        ea.push(a);
        eb.push(b);
        ew.push(w);
    }
    let edge_count = ea.len();

    // Initial scatter: uniform in a ball whose radius grows with community size.
    let ball_radius: Vec<f64> = (0..k)
        .map(|c| (sizes[c] as f64 / largest.max(1) as f64).sqrt() * core_radius * 0.35)
        .collect();
    // RMS radius of a uniform ball of radius R is R * sqrt(3/5): the volume target.
    let target_rms: Vec<f64> = ball_radius
        .iter()
        .map(|r| r * (3.0_f64 / 5.0).sqrt())
        .collect();
    let mut px = vec![0.0f64; n];
    let mut py = vec![0.0f64; n];
    let mut pz = vec![0.0f64; n];
    for i in 0..n {
        let r0 = ball_radius[community[i]];
        let u = rng();
        let dz = 2.0 * rng() - 1.0;
        let phi = TAU * rng();
        let rxy = (1.0 - dz * dz).max(0.0).sqrt();
        let r = r0 * u.cbrt();
        px[i] = cx[i] + r * rxy * phi.cos();
        py[i] = cy[i] + r * rxy * phi.sin();
        pz[i] = cz[i] + r * dz;
    }
    // Anchor positions: the scatter, held by a spring each step.
    let ax = px.clone();
    let ay = py.clone();
    let az = pz.clone();

    // Relaxation (Jacobi-style: accumulate per step, then apply).
    let mut sx = vec![0.0f64; n];
    let mut sy = vec![0.0f64; n];
    let mut sz = vec![0.0f64; n];
    let mut sw = vec![0.0f64; n];
    let mut mx = vec![0.0f64; k];
    let mut my = vec![0.0f64; k];
    let mut mz = vec![0.0f64; k];
    let mut rms = vec![0.0f64; k];
    let mut gain = vec![0.0f64; k];
    for _ in 0..iterations {
        sx.iter_mut().for_each(|v| *v = 0.0);
        sy.iter_mut().for_each(|v| *v = 0.0);
        sz.iter_mut().for_each(|v| *v = 0.0);
        sw.iter_mut().for_each(|v| *v = 0.0);
        for e in 0..edge_count {
            let (a, b, w) = (ea[e], eb[e], ew[e]);
            sx[a] += w * (px[b] - px[a]);
            sy[a] += w * (py[b] - py[a]);
            sz[a] += w * (pz[b] - pz[a]);
            sx[b] += w * (px[a] - px[b]);
            sy[b] += w * (py[a] - py[b]);
            sz[b] += w * (pz[a] - pz[b]);
            sw[a] += w;
            sw[b] += w;
        }
        for i in 0..n {
            if sw[i] > 0.0 {
                // Normalise by total edge weight so hubs do not overshoot.
                px[i] += (EDGE_PULL * sx[i]) / sw[i];
                py[i] += (EDGE_PULL * sy[i]) / sw[i];
                pz[i] += (EDGE_PULL * sz[i]) / sw[i];
            }
            px[i] += ANCHOR_PULL * (ax[i] - px[i]);
            py[i] += ANCHOR_PULL * (ay[i] - py[i]);
            pz[i] += ANCHOR_PULL * (az[i] - pz[i]);
        }

        // Volume term: a community whose RMS radius is below its target has its offsets
        // from the centroid scaled back out (the centroid is preserved).
        if k > 0 {
            mx.iter_mut().for_each(|v| *v = 0.0);
            my.iter_mut().for_each(|v| *v = 0.0);
            mz.iter_mut().for_each(|v| *v = 0.0);
            rms.iter_mut().for_each(|v| *v = 0.0);
            for i in 0..n {
                let c = community[i];
                mx[c] += px[i];
                my[c] += py[i];
                mz[c] += pz[i];
            }
            for c in 0..k {
                let s = sizes[c];
                if s > 0 {
                    mx[c] /= s as f64;
                    my[c] /= s as f64;
                    mz[c] /= s as f64;
                }
            }
            for i in 0..n {
                let c = community[i];
                let dx = px[i] - mx[c];
                let dy = py[i] - my[c];
                let dz = pz[i] - mz[c];
                rms[c] += dx * dx + dy * dy + dz * dz;
            }
            for c in 0..k {
                let s = sizes[c];
                let r = if s > 0 {
                    (rms[c] / s as f64).sqrt()
                } else {
                    0.0
                };
                gain[c] = if r > 0.0 && r < target_rms[c] {
                    (target_rms[c] / r).min(MAX_VOLUME_GAIN)
                } else {
                    1.0
                };
            }
            for i in 0..n {
                let c = community[i];
                let g = gain[c];
                if g != 1.0 {
                    px[i] = mx[c] + (px[i] - mx[c]) * g;
                    py[i] = my[c] + (py[i] - my[c]) * g;
                    pz[i] = mz[c] + (pz[i] - mz[c]) * g;
                }
            }
        }

        // Keep every node inside the core sphere.
        for i in 0..n {
            let d = (px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]).sqrt();
            if d > core_radius {
                let s = core_radius / d;
                px[i] *= s;
                py[i] *= s;
                pz[i] *= s;
            }
        }
    }

    let mut radius = 0.0f64;
    let mut core_out: Vec<(String, Vec3)> = Vec::with_capacity(n);
    for i in 0..n {
        let p = Vec3 {
            x: px[i],
            y: py[i],
            z: pz[i],
        };
        core_out.push((ids[i].to_string(), p));
        radius = radius.max(norm(p));
    }

    // Ring: unique ids evenly spaced in the XZ plane, newest at angle 0.
    let mut seen: HashSet<&str> = HashSet::new();
    let unique_ring: Vec<&str> = ring_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    let m = unique_ring.len();
    let mut ring_out: Vec<(String, Vec3)> = Vec::with_capacity(m);
    for (i, id) in unique_ring.iter().enumerate() {
        let angle = (TAU * i as f64) / m as f64;
        let p = Vec3 {
            x: ring_radius * angle.cos(),
            y: 0.0,
            z: ring_radius * angle.sin(),
        };
        ring_out.push((id.to_string(), p));
        radius = radius.max(norm(p));
    }

    OrbitLayout {
        core: core_out,
        ring: ring_out,
        community_centers,
        bounds: Bounds { radius },
    }
}

/// Members sit on a shell this fraction of the ring radius around their anchor.
const HUB_SHELL_FRACTION: f64 = 0.25;
/// Vertical stagger of the OS hubs, as a fraction of the ring radius (alternating up and down).
const HUB_STAGGER_FRACTION: f64 = 0.08;

/// One node of the hub layout: its id, whether it is a hub (the centre of a cluster) and its
/// group (the cluster it belongs to). Read leniently by the caller.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HubNode<'a> {
    pub id: &'a str,
    pub is_hub: bool,
    pub group: Option<f64>,
}

/// The hub layout of a graph with hub nodes (see `crate::api::viz_layout_json`).
///
/// * The OS (two or more hubs): the hubs sit evenly on a ring in the XZ plane, alternately
///   staggered up and down; each hub's members sit on a shell around it at a quarter of the
///   ring radius, spread by the golden angle.
/// * One hub (a drill-down): the hub is at the origin, the groups it holds are anchors evenly
///   on the ring, and each group's members sit on a shell around its anchor.
///
/// Deterministic: members are ordered by id within their group, so the input order does not
/// change the output. The first occurrence of a duplicate id wins, as in [`layout_raw`]. The
/// returned `community_centers` are the anchors (the hubs at the OS level).
pub(crate) fn hub_layout(nodes: &[HubNode], core_radius: f64) -> OrbitLayout {
    // The hubs (OS) or the family anchors (a drill-down) sit on a circle of the core radius.
    let ring_radius = core_radius;
    let shell_radius = ring_radius * HUB_SHELL_FRACTION;
    let mut seen: HashSet<&str> = HashSet::new();
    let items: Vec<&HubNode> = nodes.iter().filter(|n| seen.insert(n.id)).collect();
    let group_of = |n: &HubNode| non_neg_int(n.group, 0.0);

    let mut hubs: Vec<&HubNode> = items.iter().copied().filter(|n| n.is_hub).collect();
    hubs.sort_by(|a, b| group_of(a).total_cmp(&group_of(b)).then_with(|| crate::builder::js_cmp(a.id, b.id)));
    let mut members: Vec<&HubNode> = items.iter().copied().filter(|n| !n.is_hub).collect();
    members.sort_by(|a, b| group_of(a).total_cmp(&group_of(b)).then_with(|| crate::builder::js_cmp(a.id, b.id)));

    // Anchor of each group, and the centre hub's position.
    let mut anchors: Vec<(f64, Vec3)> = Vec::new();
    let mut centres: Vec<(&str, Vec3)> = Vec::new();
    let mut centre_of: HashMap<u64, Vec3> = HashMap::new();
    if hubs.len() >= 2 {
        let n = hubs.len();
        for (i, hub) in hubs.iter().enumerate() {
            let a = TAU * i as f64 / n as f64;
            let stagger = if i % 2 == 0 { -1.0 } else { 1.0 } * ring_radius * HUB_STAGGER_FRACTION;
            let p = Vec3 { x: ring_radius * a.cos(), y: stagger, z: ring_radius * a.sin() };
            centres.push((hub.id, p));
            centre_of.insert(group_of(hub).to_bits(), p);
            anchors.push((group_of(hub), p));
        }
    } else if hubs.len() == 1 {
        centres.push((hubs[0].id, ORIGIN));
        let mut groups: Vec<f64> = members.iter().map(|m| group_of(m)).collect();
        groups.dedup();
        let k = groups.len();
        for (i, g) in groups.iter().enumerate() {
            let a = TAU * i as f64 / k as f64;
            let p = Vec3 { x: ring_radius * a.cos(), y: 0.0, z: ring_radius * a.sin() };
            anchors.push((*g, p));
            centre_of.insert(g.to_bits(), p);
        }
    }

    // Members: a shell around their anchor, spread by the golden angle in id order.
    let mut placed: HashMap<&str, Vec3> = HashMap::new();
    for (id, p) in &centres {
        placed.insert(id, *p);
    }
    let mut i = 0;
    while i < members.len() {
        let g = group_of(members[i]);
        let mut j = i;
        while j < members.len() && group_of(members[j]) == g {
            j += 1;
        }
        let anchor = centre_of
            .get(&g.to_bits())
            .copied()
            .or_else(|| anchors.get((g as usize) % anchors.len().max(1)).map(|a| a.1))
            .unwrap_or(ORIGIN);
        let shell = fibonacci_sphere(j - i, shell_radius);
        for (k, member) in members[i..j].iter().enumerate() {
            let s = shell[k];
            placed.insert(member.id, Vec3 { x: anchor.x + s.x, y: anchor.y + s.y, z: anchor.z + s.z });
        }
        i = j;
    }

    let core: Vec<(String, Vec3)> = items
        .iter()
        .map(|n| (n.id.to_owned(), placed.get(n.id).copied().unwrap_or(ORIGIN)))
        .collect();
    let radius = core.iter().map(|(_, p)| norm(*p)).fold(0.0, f64::max);
    OrbitLayout {
        core,
        ring: Vec::new(),
        community_centers: anchors.iter().map(|a| a.1).collect(),
        bounds: Bounds { radius },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::{CoreCategory, SystemCoreEdge, SystemCoreNode, SystemRingItem, Truncated};
    use std::collections::BTreeMap;
    use std::time::Instant;

    fn dist(p: Vec3, q: Vec3) -> f64 {
        ((p.x - q.x).powi(2) + (p.y - q.y).powi(2) + (p.z - q.z).powi(2)).sqrt()
    }

    fn origin_dist(p: Vec3) -> f64 {
        dist(p, ORIGIN)
    }

    fn core_node(id: &str, community: usize) -> SystemCoreNode {
        SystemCoreNode {
            id: id.to_string(),
            label: Some(id.to_string()),
            category: CoreCategory::Code,
            community,
            degree: 0,
            path: None,
            kind: None,
        }
    }

    fn ring_item(id: &str) -> SystemRingItem {
        SystemRingItem {
            id: id.to_string(),
            label: id.to_string(),
            kind: "note".to_string(),
            at: "2026-10-27T00:00:00Z".to_string(),
            link: None,
        }
    }

    fn make_graph(
        core: Vec<SystemCoreNode>,
        edges: Vec<SystemCoreEdge>,
        ring: Vec<SystemRingItem>,
    ) -> SystemGraph {
        let communities = core
            .iter()
            .map(|n| n.community)
            .collect::<HashSet<_>>()
            .len();
        SystemGraph {
            truncated: Truncated {
                total_nodes: core.len(),
                kept_nodes: core.len(),
                kept_communities: communities,
            },
            core,
            edges,
            ring,
        }
    }

    fn edge(source: &str, target: &str, weight: u64) -> SystemCoreEdge {
        SystemCoreEdge {
            source: source.to_string(),
            target: target.to_string(),
            weight,
        }
    }

    /// Two well-separated communities of `size` nodes: a ring plus seeded chords.
    fn two_communities(size: usize) -> SystemGraph {
        let mut rng = mulberry32(42.0);
        let mut core = Vec::new();
        let mut edges = Vec::new();
        for c in 0..2 {
            for i in 0..size {
                core.push(core_node(&format!("c{c}:{i:03}"), c));
            }
            for i in 0..size {
                edges.push(edge(
                    &format!("c{c}:{i:03}"),
                    &format!("c{c}:{:03}", (i + 1) % size),
                    1,
                ));
            }
            for _ in 0..size * 2 {
                let a = (rng() * size as f64).floor() as usize;
                let b = (rng() * size as f64).floor() as usize;
                if a != b {
                    edges.push(edge(&format!("c{c}:{a:03}"), &format!("c{c}:{b:03}"), 1));
                }
            }
        }
        make_graph(core, edges, vec![])
    }

    /// Five communities (400/300/200/150/100), ~deg 3 ring+chords, 5% cross edges.
    fn five_communities() -> SystemGraph {
        let sizes = [400usize, 300, 200, 150, 100];
        let mut rng = mulberry32(7.0);
        let mut core = Vec::new();
        let mut edges = Vec::new();
        for (c, &s) in sizes.iter().enumerate() {
            for i in 0..s {
                core.push(core_node(&format!("c{c}:{i}"), c));
            }
            for i in 0..s {
                edges.push(edge(
                    &format!("c{c}:{i}"),
                    &format!("c{c}:{}", (i + 1) % s),
                    1,
                ));
            }
            for _ in 0..s / 2 {
                let a = (rng() * s as f64).floor() as usize;
                let b = (rng() * s as f64).floor() as usize;
                if a != b {
                    edges.push(edge(&format!("c{c}:{a}"), &format!("c{c}:{b}"), 1));
                }
            }
        }
        let community_of: HashMap<String, usize> =
            core.iter().map(|n| (n.id.clone(), n.community)).collect();
        let cross = ((edges.len() as f64) * 0.05 / 0.95).round() as usize;
        for _ in 0..cross {
            let a = &core[(rng() * core.len() as f64).floor() as usize].id;
            let b = &core[(rng() * core.len() as f64).floor() as usize].id;
            if community_of[a] != community_of[b] {
                edges.push(edge(a, b, 1));
            }
        }
        make_graph(core, edges, vec![])
    }

    fn by_id(points: &[(String, Vec3)]) -> HashMap<&str, Vec3> {
        points.iter().map(|(id, p)| (id.as_str(), *p)).collect()
    }

    #[test]
    fn mulberry32_is_repeatable_in_range_and_seed_sensitive() {
        let mut a = mulberry32(7.0);
        let mut b = mulberry32(7.0);
        let seq_a: Vec<f64> = (0..50).map(|_| a()).collect();
        let seq_b: Vec<f64> = (0..50).map(|_| b()).collect();
        assert_eq!(seq_a, seq_b);
        let mut c = mulberry32(8.0);
        let seq_c: Vec<f64> = (0..50).map(|_| c()).collect();
        assert_ne!(seq_a, seq_c);
        assert!(seq_a.iter().all(|v| (0.0..1.0).contains(v)));
    }

    #[test]
    fn mulberry32_matches_the_js_reference_values() {
        // Values printed by the removed TS mulberry32 (node, typescript/dist/src/system/orbit.js).
        let mut one = mulberry32(1.0);
        let got: Vec<f64> = (0..3).map(|_| one()).collect();
        let want = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522];
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-15, "{g} vs {w}");
        }
        let mut seven = mulberry32(7.0);
        assert!((seven() - 0.011704753153026104).abs() < 1e-15);
        assert!((seven() - 0.06195825757458806).abs() < 1e-15);
    }

    #[test]
    fn mulberry32_wraps_seeds_like_uint32() {
        // ToUint32: -1 -> 2^32 - 1, 2^32 + 5 -> 5, 5.9 -> 5.
        let mut neg = mulberry32(-1.0);
        let mut max = mulberry32(4_294_967_295.0);
        assert_eq!(neg(), max());
        let mut big = mulberry32(4_294_967_301.0);
        let mut five = mulberry32(5.0);
        assert_eq!(big(), five());
        let mut frac = mulberry32(5.9);
        let mut five_again = mulberry32(5.0);
        assert_eq!(frac(), five_again());
    }

    #[test]
    fn fibonacci_sphere_points_lie_on_the_sphere_and_edge_counts_are_handled() {
        assert!(fibonacci_sphere(0, 10.0).is_empty());
        let one = fibonacci_sphere(1, 10.0);
        assert_eq!(one.len(), 1);
        assert!((origin_dist(one[0]) - 10.0).abs() < 1e-9);
        let pts = fibonacci_sphere(50, 37.0);
        assert_eq!(pts.len(), 50);
        for p in pts {
            assert!((origin_dist(p) - 37.0).abs() < 1e-9);
        }
    }

    /// An owned spec for a hub-layout input: `(id, is_hub, group)`. The ids live in the caller.
    fn spec(ids: &[(String, bool, f64)]) -> Vec<HubNode<'_>> {
        ids.iter()
            .map(|(id, is_hub, group)| HubNode { id, is_hub: *is_hub, group: Some(*group) })
            .collect()
    }

    fn at(layout: &OrbitLayout, id: &str) -> Vec3 {
        layout.core.iter().find(|(i, _)| i == id).map(|(_, p)| *p).expect("placed")
    }

    #[test]
    fn hub_layout_os_puts_eight_hubs_on_a_ring_with_a_slight_stagger() {
        let mut ids: Vec<(String, bool, f64)> = (0..8).map(|g| (format!("hub:{g}"), true, g as f64)).collect();
        for g in 0..8 {
            ids.push((format!("m:{g}:a"), false, g as f64));
        }
        let layout = hub_layout(&spec(&ids), 100.0);
        assert_eq!(layout.community_centers.len(), 8);
        for g in 0..8 {
            let h = at(&layout, &format!("hub:{g}"));
            // On the XZ ring of the core radius, staggered only a little in Y.
            assert!((h.x * h.x + h.z * h.z).sqrt() - 100.0 < 1e-9);
            assert!(h.y.abs() <= 100.0 * HUB_STAGGER_FRACTION + 1e-9);
        }
        // Neighbouring hubs are well apart: the ring spacing is 2R sin(pi/8), about 76 units.
        let spacing = dist(at(&layout, "hub:0"), at(&layout, "hub:1"));
        assert!(spacing > 70.0, "neighbouring hubs too close: {spacing}");
    }

    #[test]
    fn hub_layout_members_sit_on_their_hubs_shell_and_groups_do_not_overlap() {
        let mut ids: Vec<(String, bool, f64)> = vec![
            ("hub:a".into(), true, 0.0),
            ("hub:b".into(), true, 1.0),
            ("hub:c".into(), true, 2.0),
        ];
        for i in 0..30 {
            ids.push((format!("a{i:02}"), false, 0.0));
            ids.push((format!("b{i:02}"), false, 1.0));
        }
        let layout = hub_layout(&spec(&ids), 100.0);
        let shell = 100.0 * HUB_SHELL_FRACTION;
        let hub = at(&layout, "hub:a");
        for i in 0..30 {
            let d = dist(at(&layout, &format!("a{i:02}")), hub);
            assert!((d - shell).abs() < 1e-6, "member off its shell: {d}");
        }
        // No member of one hub comes closer to another hub's members than the gap between the shells.
        let mut closest = f64::INFINITY;
        for (ia, pa) in layout.core.iter().filter(|(id, _)| id.starts_with('a')) {
            for (ib, pb) in layout.core.iter().filter(|(id, _)| id.starts_with('b')) {
                let _ = (ia, ib);
                closest = closest.min(dist(*pa, *pb));
            }
        }
        assert!(closest > 2.0 * shell, "groups overlap: {closest}");
    }

    #[test]
    fn hub_layout_drill_centres_the_hub_and_rings_its_groups() {
        let mut ids: Vec<(String, bool, f64)> = vec![("hub:models".into(), true, 4.0)];
        for g in 1..=3 {
            for i in 0..4 {
                ids.push((format!("g{g}:{i}"), false, g as f64));
            }
        }
        let layout = hub_layout(&spec(&ids), 100.0);
        assert_eq!(at(&layout, "hub:models"), ORIGIN);
        assert_eq!(layout.community_centers.len(), 3, "one anchor per group");
        for c in &layout.community_centers {
            assert!((norm(*c) - 100.0).abs() < 1e-9, "anchor off the ring");
        }
        let shell = 100.0 * HUB_SHELL_FRACTION;
        for g in 1..=3 {
            let anchor = layout.community_centers[g - 1];
            for i in 0..4 {
                assert!((dist(at(&layout, &format!("g{g}:{i}")), anchor) - shell).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn hub_layout_ignores_input_order_and_drops_duplicate_ids() {
        let ids: Vec<(String, bool, f64)> = vec![
            ("hub:x".into(), true, 0.0),
            ("hub:y".into(), true, 1.0),
            ("m1".into(), false, 0.0),
            ("m2".into(), false, 0.0),
            ("m1".into(), false, 0.0),
        ];
        let a = spec(&ids);
        let mut b = a.clone();
        b.reverse();
        let la = hub_layout(&a, 100.0);
        let lb = hub_layout(&b, 100.0);
        for (id, p) in &la.core {
            assert!(dist(*p, at(&lb, id)) < 1e-12, "{id} moved with the input order");
        }
        assert_eq!(la.core.iter().filter(|(id, _)| id == "m1").count(), 1);
    }

    #[test]
    fn orbit_layout_is_identical_across_runs() {
        let g = two_communities(40);
        let opts = OrbitOptions {
            seed: Some(3.0),
            ..Default::default()
        };
        let first = orbit_layout(&g, &opts);
        let second = orbit_layout(&g, &opts);
        assert_eq!(first, second);
    }

    #[test]
    fn every_core_point_lies_within_core_radius() {
        let g = two_communities(60);
        let layout = orbit_layout(
            &g,
            &OrbitOptions {
                core_radius: Some(100.0),
                ..Default::default()
            },
        );
        assert_eq!(layout.core.len(), g.core.len());
        for (_, p) in &layout.core {
            assert!(
                origin_dist(*p) <= 100.0 + 1e-9,
                "outside core: {}",
                origin_dist(*p)
            );
        }
    }

    #[test]
    fn ring_sits_flat_at_ring_radius_in_angle_order_newest_at_angle_zero() {
        let ring: Vec<SystemRingItem> = ["r0", "r1", "r2", "r3"]
            .iter()
            .map(|id| ring_item(id))
            .collect();
        let layout = orbit_layout(
            &make_graph(vec![], vec![], ring),
            &OrbitOptions {
                ring_radius: Some(170.0),
                ..Default::default()
            },
        );
        assert_eq!(layout.ring.len(), 4);
        let ring = by_id(&layout.ring);
        for p in ring.values() {
            assert_eq!(p.y, 0.0);
            assert!((origin_dist(*p) - 170.0).abs() < 1e-9);
        }
        let r0 = ring["r0"];
        assert!((r0.x - 170.0).abs() < 1e-9 && r0.z.abs() < 1e-9);
        let r1 = ring["r1"];
        assert!(r1.x.abs() < 1e-9 && (r1.z - 170.0).abs() < 1e-9);
        let r2 = ring["r2"];
        assert!((r2.x + 170.0).abs() < 1e-9 && r2.z.abs() < 1e-9);
        assert!(layout.bounds.radius >= 170.0 - 1e-9);
    }

    #[test]
    fn empty_graph_gives_empty_layout_radius_zero() {
        let layout = orbit_layout(
            &make_graph(vec![], vec![], vec![]),
            &OrbitOptions::default(),
        );
        assert!(layout.core.is_empty());
        assert!(layout.ring.is_empty());
        assert!(layout.community_centers.is_empty());
        assert_eq!(layout.bounds.radius, 0.0);
    }

    #[test]
    fn single_community_sits_at_origin_and_dangling_or_self_edges_are_ignored() {
        let core = vec![core_node("a", 0), core_node("b", 0)];
        let edges = vec![edge("a", "b", 9), edge("a", "ghost", 1), edge("a", "a", 1)];
        let layout = orbit_layout(&make_graph(core, edges, vec![]), &OrbitOptions::default());
        assert_eq!(layout.community_centers, vec![ORIGIN]);
        for (_, p) in &layout.core {
            assert!(p.x.is_finite() && p.y.is_finite() && p.z.is_finite());
        }
    }

    #[test]
    fn nodes_sit_closer_to_their_own_community_center() {
        let g = two_communities(40);
        let layout = orbit_layout(&g, &OrbitOptions::default());
        assert_eq!(layout.community_centers.len(), 2);
        let (c0, c1) = (layout.community_centers[0], layout.community_centers[1]);
        let pos = by_id(&layout.core);
        let (mut own, mut other) = (0.0, 0.0);
        for n in &g.core {
            let p = pos[n.id.as_str()];
            let (mine, theirs) = if n.community == 0 { (c0, c1) } else { (c1, c0) };
            own += dist(p, mine);
            other += dist(p, theirs);
        }
        let count = g.core.len() as f64;
        assert!(
            own / count < other / count,
            "own {} vs other {}",
            own / count,
            other / count
        );
    }

    #[test]
    fn clusters_keep_volume_for_communities_of_at_least_100_nodes() {
        let g = five_communities();
        let layout = orbit_layout(
            &g,
            &OrbitOptions {
                core_radius: Some(100.0),
                ..Default::default()
            },
        );
        let pos = by_id(&layout.core);
        let mut by_comm: BTreeMap<usize, Vec<Vec3>> = BTreeMap::new();
        for n in &g.core {
            by_comm
                .entry(n.community)
                .or_default()
                .push(pos[n.id.as_str()]);
        }
        for (c, pts) in &by_comm {
            if pts.len() < 100 {
                continue;
            }
            let len = pts.len() as f64;
            let centroid = Vec3 {
                x: pts.iter().map(|p| p.x).sum::<f64>() / len,
                y: pts.iter().map(|p| p.y).sum::<f64>() / len,
                z: pts.iter().map(|p| p.z).sum::<f64>() / len,
            };
            let spread = pts.iter().map(|p| dist(*p, centroid)).sum::<f64>() / len;
            assert!(spread >= 10.0, "community {c} spread {spread}");
        }
    }

    #[test]
    fn mean_inter_community_distance_is_at_least_three_times_intra() {
        let g = five_communities();
        let layout = orbit_layout(
            &g,
            &OrbitOptions {
                core_radius: Some(100.0),
                ..Default::default()
            },
        );
        let pos = by_id(&layout.core);
        let points: Vec<(usize, Vec3)> = g
            .core
            .iter()
            .map(|n| (n.community, pos[n.id.as_str()]))
            .collect();
        let (mut intra, mut intra_n, mut inter, mut inter_n) = (0.0, 0u64, 0.0, 0u64);
        for i in 0..points.len() {
            for j in i + 1..points.len() {
                let d = dist(points[i].1, points[j].1);
                if points[i].0 == points[j].0 {
                    intra += d;
                    intra_n += 1;
                } else {
                    inter += d;
                    inter_n += 1;
                }
            }
        }
        let (mean_intra, mean_inter) = (intra / intra_n as f64, inter / inter_n as f64);
        assert!(
            mean_inter >= 3.0 * mean_intra,
            "inter {mean_inter} vs intra {mean_intra}"
        );
    }

    #[test]
    fn core_reaches_at_least_70_percent_of_core_radius() {
        let layout = orbit_layout(
            &five_communities(),
            &OrbitOptions {
                core_radius: Some(100.0),
                ..Default::default()
            },
        );
        assert!(
            layout.bounds.radius >= 70.0,
            "radius {}",
            layout.bounds.radius
        );
    }

    #[test]
    fn sparse_community_id_lays_out_fast_and_compacts() {
        let core = vec![
            core_node("a", 0),
            core_node("b", 1_000_000_000),
            core_node("c", 1_000_000_000),
        ];
        let edges = vec![edge("b", "c", 1)];
        let started = Instant::now();
        let layout = orbit_layout(&make_graph(core, edges, vec![]), &OrbitOptions::default());
        let elapsed = started.elapsed();
        assert_eq!(layout.core.len(), 3);
        assert_eq!(layout.community_centers.len(), 2);
        if !cfg!(debug_assertions) {
            assert!(elapsed.as_secs_f64() < 2.0, "took {elapsed:?}");
        }
        for (_, p) in &layout.core {
            assert!(p.x.is_finite() && p.y.is_finite() && p.z.is_finite());
        }
    }

    #[test]
    fn non_finite_and_non_positive_edge_weights_count_as_zero() {
        let core = [("a", Some(0.0)), ("b", Some(0.0))];
        let edges = [
            ("a", "b", f64::NAN),
            ("a", "b", f64::INFINITY),
            ("a", "b", -3.0),
        ];
        let layout = layout_raw(&core, &edges, &[], &OrbitOptions::default());
        for (_, p) in &layout.core {
            assert!(p.x.is_finite() && p.y.is_finite() && p.z.is_finite());
        }
        // With every edge dropped the layout must match the edgeless one exactly.
        let edgeless = layout_raw(&core, &[], &[], &OrbitOptions::default());
        assert_eq!(layout.core, edgeless.core);
    }

    #[test]
    fn duplicate_ring_ids_leave_no_gap() {
        let ring: Vec<SystemRingItem> = ["a", "b", "a", "c"]
            .iter()
            .map(|id| ring_item(id))
            .collect();
        let layout = orbit_layout(
            &make_graph(vec![], vec![], ring),
            &OrbitOptions {
                ring_radius: Some(170.0),
                ..Default::default()
            },
        );
        assert_eq!(layout.ring.len(), 3);
        let ring = by_id(&layout.ring);
        let step = 2.0 * std::f64::consts::PI / 3.0;
        let (a, b, c) = (ring["a"], ring["b"], ring["c"]);
        assert!((a.x - 170.0).abs() < 1e-9 && a.z.abs() < 1e-9);
        assert!((b.x - 170.0 * step.cos()).abs() < 1e-9 && (b.z - 170.0 * step.sin()).abs() < 1e-9);
        assert!(
            (c.x - 170.0 * (2.0 * step).cos()).abs() < 1e-9
                && (c.z - 170.0 * (2.0 * step).sin()).abs() < 1e-9
        );
    }

    #[test]
    fn perf_smoke_20k_nodes_60k_edges_lays_out_quickly() {
        let mut rng = mulberry32(99.0);
        let nodes = 20_000usize;
        let core: Vec<SystemCoreNode> = (0..nodes)
            .map(|i| core_node(&format!("n{i:05}"), (rng() * 12.0).floor() as usize))
            .collect();
        let edges: Vec<SystemCoreEdge> = (0..60_000)
            .map(|_| {
                let a = (rng() * nodes as f64).floor() as usize;
                let b = (rng() * nodes as f64).floor() as usize;
                edge(&core[a].id, &core[b].id, 1 + (rng() * 3.0).floor() as u64)
            })
            .collect();
        let g = make_graph(core, edges, vec![]);
        let started = Instant::now();
        let layout = orbit_layout(&g, &OrbitOptions::default());
        let elapsed = started.elapsed();
        assert_eq!(layout.core.len(), nodes);
        if !cfg!(debug_assertions) {
            assert!(elapsed.as_secs_f64() < 2.0, "took {elapsed:?}");
        }
        eprintln!("orbit 20k/60k: {elapsed:?}");
    }
}
