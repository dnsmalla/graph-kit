//! T0 spike: Rust port of the graph-kit 2D layout pipeline (GraphCore/Layout),
//! minus `LayoutQuality` (metrics are computed by the Swift harness instead).
//!
//! Stage order follows `GraphLayoutEngine.layout`: topology (EdgeWeight, parallel
//! collapse), PageRank, Louvain, radii/masses, cluster anchors, phyllotaxis seeds,
//! Barnes-Hut force loop with collision passes. Operation order follows the Swift
//! source where it is cheap to do so, so that bit-level drift can be attributed.
//!
//! Binary input (little endian):
//!   u32 n | u32 m | u8 kindCount | kindCount x (u8 len, utf8 name)
//!   m x (u32 from, u32 to, u8 kindIndex, u8 confidence[0 EXTRACTED,1 INFERRED,2 AMBIGUOUS])
//! Binary output (little endian):
//!   u32 n | u32 linkCount | u32 communityCount
//!   n x (f64 x, f64 y, f64 radius, u32 community, u32 degree, u32 inDegree)
//!   linkCount x f64 weight (collapsed links, creation order)

// Index loops mirror the Swift source line by line on purpose (parity review).
#![allow(clippy::needless_range_loop)]

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

pub const GOLDEN_ANGLE: f64 = 2.399963229728653;
const MIN_WEIGHT: f64 = 0.30;

// ---------------------------------------------------------------- EdgeWeight

pub fn base_weight(kind: &str) -> Option<f64> {
    Some(match kind {
        "contains" => 1.00,
        "inherits" | "implements" => 0.95,
        "defines" => 0.92,
        "definesSchema" | "imports" => 0.90,
        "exports" | "dependsOn" => 0.85,
        "calls" | "containsFlow" => 0.80,
        "flowStep" => 0.78,
        "middleware" => 0.72,
        "publishes" | "subscribes" | "readsFrom" | "writesTo" | "routes" => 0.70,
        "testedBy" | "configures" | "migrates" => 0.68,
        "deploys" | "serves" | "provisions" | "triggers" => 0.65,
        "transforms" | "validates" => 0.62,
        "documents" => 0.60,
        "references" | "cites" => 0.58,
        "buildsOn" => 0.55,
        "contradicts" => 0.52,
        "exemplifies" => 0.50,
        "categorizedUnder" => 0.48,
        "authoredBy" => 0.42,
        "crossDomain" => 0.40,
        "relatedTo" => 0.24,
        "similarTo" => 0.20,
        _ => return None,
    })
}

pub fn multiplier(confidence: u8) -> f64 {
    match confidence {
        0 => 1.00,
        1 => 0.75,
        _ => 0.45,
    }
}

pub fn is_hierarchical(kind: &str) -> bool {
    kind == "contains" || kind == "containsFlow"
}

// ---------------------------------------------------------------- Input

pub struct Input {
    pub n: usize,
    pub edges: Vec<(u32, u32, u8, u8)>, // from, to, kind index, confidence
    pub kinds: Vec<String>,
}

pub fn parse(bytes: &[u8]) -> Result<Input, String> {
    let mut at = 0usize;
    let take = |at: &mut usize, k: usize| -> Result<&[u8], String> {
        if *at + k > bytes.len() {
            return Err("truncated input".into());
        }
        let s = &bytes[*at..*at + k];
        *at += k;
        Ok(s)
    };
    let n = u32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap()) as usize;
    let m = u32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap()) as usize;
    let kind_count = take(&mut at, 1)?[0] as usize;
    let mut kinds = Vec::with_capacity(kind_count);
    for _ in 0..kind_count {
        let len = take(&mut at, 1)?[0] as usize;
        let name = std::str::from_utf8(take(&mut at, len)?).map_err(|e| e.to_string())?;
        if base_weight(name).is_none() {
            return Err(format!("unknown edge kind: {name}"));
        }
        kinds.push(name.to_string());
    }
    let mut edges = Vec::with_capacity(m);
    for _ in 0..m {
        let rec = take(&mut at, 10)?;
        let f = u32::from_le_bytes(rec[0..4].try_into().unwrap());
        let t = u32::from_le_bytes(rec[4..8].try_into().unwrap());
        edges.push((f, t, rec[8], rec[9]));
    }
    Ok(Input { n, edges, kinds })
}

// ---------------------------------------------------------------- Topology

pub struct Link {
    pub source: usize,
    pub target: usize,
    pub weight: f64,
    pub hierarchical: bool,
}

pub struct Topology {
    pub n: usize,
    pub links: Vec<Link>,
    pub neighbors: Vec<Vec<usize>>,
    pub degree: Vec<usize>,
    pub weighted_degree: Vec<f64>,
    pub in_degree: Vec<usize>,
}

impl Topology {
    pub fn build(input: &Input, min_weight: f64) -> Topology {
        let n = input.n;
        // Per-kind weight, resolved once. Unknown kinds are an input error.
        let kind_weight: Vec<Option<f64>> = input.kinds.iter().map(|k| base_weight(k)).collect();
        let mut in_deg = vec![0usize; n];
        let mut neighbour_sets: Vec<std::collections::BTreeSet<usize>> = vec![Default::default(); n];
        let mut index_by_pair: HashMap<u64, usize> = HashMap::with_capacity(input.edges.len());
        let mut peak: Vec<f64> = Vec::new();
        let mut other: Vec<f64> = Vec::new();
        let mut hier: Vec<bool> = Vec::new();
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for &(f, t, k, c) in &input.edges {
            let (s, tg) = (f as usize, t as usize);
            if s == tg || s >= n || tg >= n {
                continue;
            }
            // Kinds are validated in `parse`, so this cannot be None for parsed input.
            let base = kind_weight[k as usize].unwrap_or(0.0);
            let weight = base * multiplier(c);
            if weight < min_weight {
                continue;
            }
            in_deg[tg] += 1;
            let key = if s < tg { (s * n + tg) as u64 } else { (tg * n + s) as u64 };
            let h = is_hierarchical(&input.kinds[k as usize]);
            if let Some(&existing) = index_by_pair.get(&key) {
                if weight > peak[existing] {
                    other[existing] += peak[existing];
                    peak[existing] = weight;
                } else {
                    other[existing] += weight;
                }
                hier[existing] = hier[existing] || h;
                continue;
            }
            index_by_pair.insert(key, pairs.len());
            pairs.push((s, tg));
            peak.push(weight);
            other.push(0.0);
            hier.push(h);
            neighbour_sets[s].insert(tg);
            neighbour_sets[tg].insert(s);
        }
        let mut links = Vec::with_capacity(pairs.len());
        let mut w_deg = vec![0.0f64; n];
        for (i, &(s, tg)) in pairs.iter().enumerate() {
            let weight = (peak[i] + other[i] * 0.15).min(1.0);
            w_deg[s] += weight;
            w_deg[tg] += weight;
            links.push(Link { source: s, target: tg, weight, hierarchical: hier[i] });
        }
        let neighbors: Vec<Vec<usize>> = neighbour_sets.into_iter().map(|s| s.into_iter().collect()).collect();
        let degree = neighbors.iter().map(|v| v.len()).collect();
        Topology { n, links, neighbors, degree, weighted_degree: w_deg, in_degree: in_deg }
    }

    pub fn page_rank(&self) -> Vec<f64> {
        let (n, damping, iterations) = (self.n, 0.85f64, 40);
        if n == 0 {
            return vec![];
        }
        if n == 1 {
            return vec![1.0];
        }
        let mut out_weight = vec![0.0f64; n];
        for l in &self.links {
            out_weight[l.source] += l.weight;
        }
        let mut rank = vec![1.0 / n as f64; n];
        let teleport = (1.0 - damping) / n as f64;
        let mut next = vec![0.0f64; n];
        for _ in 0..iterations {
            let mut dangling = 0.0;
            for i in 0..n {
                if out_weight[i] == 0.0 {
                    dangling += rank[i];
                }
            }
            let spread = damping * dangling / n as f64;
            for v in next.iter_mut() {
                *v = teleport;
            }
            for i in 0..n {
                next[i] += spread;
            }
            for l in &self.links {
                if out_weight[l.source] > 0.0 {
                    next[l.target] += damping * rank[l.source] * (l.weight / out_weight[l.source]);
                }
            }
            std::mem::swap(&mut rank, &mut next);
        }
        let peak = rank.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        if peak.is_nan() || peak <= 0.0 {
            return rank;
        }
        rank.iter().map(|r| r / peak).collect()
    }
}

// ---------------------------------------------------------------- Louvain

struct Level {
    neighbours: Vec<Vec<(usize, f64)>>,
    self_loops: Vec<f64>,
    degree: Vec<f64>,
    total: f64,
}

impl Level {
    fn new(neighbours: Vec<Vec<(usize, f64)>>, self_loops: Vec<f64>) -> Level {
        let n = neighbours.len();
        let mut degree = vec![0.0; n];
        let mut total = 0.0;
        for i in 0..n {
            let mut incident = 0.0;
            for &(_, w) in &neighbours[i] {
                incident += w;
            }
            degree[i] = incident + 2.0 * self_loops[i];
            total += incident / 2.0 + self_loops[i];
        }
        Level { neighbours, self_loops, degree, total }
    }
}

pub fn louvain(topo: &Topology, resolution: f64) -> Vec<usize> {
    let n = topo.n;
    if n == 0 {
        return vec![];
    }
    if topo.links.is_empty() {
        return (0..n).collect();
    }
    let mut neighbours: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for l in &topo.links {
        let w = if l.hierarchical { l.weight * 1.6 } else { l.weight };
        neighbours[l.source].push((l.target, w));
        neighbours[l.target].push((l.source, w));
    }
    let mut level = Level::new(neighbours, vec![0.0; n]);
    let mut assignment: Vec<usize> = (0..n).collect();
    for _ in 0..10 {
        let (community, improved) = move_nodes(&level, resolution);
        if !improved {
            break;
        }
        // Renumber by first appearance.
        let mut map = vec![usize::MAX; n];
        let mut count = 0usize;
        for &c in &community {
            if map[c] == usize::MAX {
                map[c] = count;
                count += 1;
            }
        }
        let of_level: Vec<usize> = community.iter().map(|&c| map[c]).collect();
        for a in assignment.iter_mut() {
            *a = of_level[*a];
        }
        if count >= level.neighbours.len() {
            break;
        }
        level = aggregate(&level, &of_level, count);
    }
    assignment
}

fn move_nodes(level: &Level, resolution: f64) -> (Vec<usize>, bool) {
    let n = level.neighbours.len();
    let mut community: Vec<usize> = (0..n).collect();
    let mut cdeg = level.degree.clone();
    let twice = 2.0 * level.total;
    if twice.is_nan() || twice <= 0.0 {
        return (community, false);
    }
    let mut improved_overall = false;
    for _ in 0..20 {
        let mut moved = false;
        for node in 0..n {
            let origin = community[node];
            let nd = level.degree[node];
            let mut w2c: BTreeMap<usize, f64> = BTreeMap::new();
            for &(nb, w) in &level.neighbours[node] {
                if nb != node {
                    *w2c.entry(community[nb]).or_insert(0.0) += w;
                }
            }
            cdeg[origin] -= nd;
            let origin_gain = w2c.get(&origin).copied().unwrap_or(0.0)
                - resolution * cdeg[origin] * nd / twice;
            let mut best = origin;
            let mut best_gain = origin_gain;
            for (&cand, &w) in &w2c {
                if cand == origin {
                    continue;
                }
                let gain = w - resolution * cdeg[cand] * nd / twice;
                if gain > best_gain + 1e-12 {
                    best_gain = gain;
                    best = cand;
                }
            }
            community[node] = best;
            cdeg[best] += nd;
            if best != origin {
                moved = true;
                improved_overall = true;
            }
        }
        if !moved {
            break;
        }
    }
    (community, improved_overall)
}

fn aggregate(level: &Level, of_level: &[usize], count: usize) -> Level {
    let mut self_loops = vec![0.0; count];
    let mut merged: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); count];
    for node in 0..level.neighbours.len() {
        let src = of_level[node];
        self_loops[src] += level.self_loops[node];
        for &(nb, w) in &level.neighbours[node] {
            let tgt = of_level[nb];
            if src == tgt {
                self_loops[src] += w / 2.0;
            } else {
                *merged[src].entry(tgt).or_insert(0.0) += w;
            }
        }
    }
    let neighbours = merged
        .into_iter()
        .map(|row| row.into_iter().collect::<Vec<(usize, f64)>>())
        .collect();
    Level::new(neighbours, self_loops)
}

/// Groups by community id, largest first, ties by lowest member (CommunityDetection.groups).
pub fn groups(community: &[usize]) -> Vec<Vec<usize>> {
    let count = community.iter().max().map(|m| m + 1).unwrap_or(0);
    let mut g: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (node, &id) in community.iter().enumerate() {
        g[id].push(node);
    }
    let mut g: Vec<Vec<usize>> = g.into_iter().filter(|v| !v.is_empty()).collect();
    g.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
    g
}

// ---------------------------------------------------------------- Grid helpers

pub fn grid_index(value: f64, cell: f64) -> i64 {
    if !value.is_finite() || cell.is_nan() || cell <= 0.0 {
        return 0;
    }
    let scaled = (value / cell).floor().clamp(-1e15, 1e15);
    scaled as i64
}

#[inline]
fn grid_key(cx: i64, cy: i64) -> i64 {
    cx.wrapping_mul(73_856_093) ^ cy.wrapping_mul(19_349_663)
}

// ---------------------------------------------------------------- Anchors and seeds

fn cluster_anchors(groups: &[Vec<usize>], radii: &[f64], n: usize, spacing: f64) -> Vec<(f64, f64)> {
    let mut anchors = vec![(0.0f64, 0.0f64); n];
    if groups.is_empty() {
        return anchors;
    }
    let cluster_radii: Vec<f64> = groups
        .iter()
        .map(|members| {
            let area = members.iter().fold(0.0, |total, &i| {
                let r = radii[i] + 6.0;
                total + r * r * std::f64::consts::PI
            });
            (area / std::f64::consts::PI / 0.62).sqrt().max(30.0)
        })
        .collect();
    let mut placed: Vec<((f64, f64), f64)> = Vec::with_capacity(groups.len());
    let largest = cluster_radii.iter().cloned().fold(f64::NEG_INFINITY, f64::max).max(f64::MIN);
    let largest = if largest.is_finite() { largest } else { 1.0 };
    let cell = (largest * 2.0 * spacing).max(1.0);
    let mut grid: HashMap<i64, Vec<usize>> = HashMap::new();

    let overlaps = |grid: &HashMap<i64, Vec<usize>>, placed: &[((f64, f64), f64)], cand: (f64, f64), radius: f64| -> bool {
        let cx = grid_index(cand.0, cell);
        let cy = grid_index(cand.1, cell);
        for oy in -1i64..=1 {
            for ox in -1i64..=1 {
                if let Some(bucket) = grid.get(&grid_key(cx + ox, cy + oy)) {
                    for &idx in bucket {
                        let (c, r) = placed[idx];
                        let dx = cand.0 - c.0;
                        let dy = cand.1 - c.1;
                        let needed = (radius + r) * spacing;
                        if dx * dx + dy * dy < needed * needed {
                            return true;
                        }
                    }
                }
            }
        }
        false
    };

    for (gi, members) in groups.iter().enumerate() {
        let radius = cluster_radii[gi];
        let mut center = (0.0f64, 0.0f64);
        if !placed.is_empty() {
            let stride = (radius * 0.55).max(18.0);
            let mut found = false;
            let mut step = 0u32;
            while step < 60_000 {
                let t = step as f64;
                let sr = stride * t.sqrt();
                let angle = GOLDEN_ANGLE * t;
                let cand = (sr * angle.cos(), sr * angle.sin());
                if !overlaps(&grid, &placed, cand, radius) {
                    center = cand;
                    found = true;
                    break;
                }
                step += 1;
            }
            if !found {
                let outermost = placed.iter().fold(0.0f64, |limit, &(c, r)| {
                    limit.max((c.0 * c.0 + c.1 * c.1).sqrt() + r)
                });
                let angle = GOLDEN_ANGLE * gi as f64;
                let ring = outermost + (radius + largest) * spacing;
                center = (ring * angle.cos(), ring * angle.sin());
            }
        }
        grid.entry(grid_key(grid_index(center.0, cell), grid_index(center.1, cell)))
            .or_default()
            .push(placed.len());
        placed.push((center, radius));
        for &m in members {
            anchors[m] = center;
        }
    }
    anchors
}

fn seed_positions(groups: &[Vec<usize>], anchors: &[(f64, f64)], radii: &[f64], n: usize) -> Vec<(f64, f64)> {
    let mut pos = vec![(0.0f64, 0.0f64); n];
    for members in groups {
        let anchor = anchors[members[0]];
        let avg = members.iter().fold(0.0, |s, &m| s + radii[m]) / members.len().max(1) as f64;
        let stride = (avg * 2.1).max(12.0);
        for (offset, &m) in members.iter().enumerate() {
            let t = offset as f64;
            let sr = stride * t.sqrt();
            let angle = GOLDEN_ANGLE * t;
            pos[m] = (anchor.0 + sr * angle.cos(), anchor.1 + sr * angle.sin());
        }
    }
    pos
}

// ---------------------------------------------------------------- Barnes-Hut tree

#[derive(Clone, Copy)]
struct Cell {
    cmx: f64,
    cmy: f64,
    mass: f64,
    minx: f64,
    miny: f64,
    size: f64,
    first_child: i32,
    count: u32,
    head: i32,
    tail: i32,
}

const NIL: i32 = -1;

struct SpatialTree {
    cells: Vec<Cell>,
    next: Vec<i32>, // leaf point chains, indexed by point
    max_depth: u32,
    leaf_capacity: u32,
}

impl SpatialTree {
    fn new(n: usize) -> SpatialTree {
        SpatialTree { cells: Vec::with_capacity(2 * n + 8), next: vec![NIL; n], max_depth: 20, leaf_capacity: 1 }
    }

    fn rebuild(&mut self, pos: &[(f64, f64)], masses: &[f64]) {
        self.cells.clear();
        if pos.is_empty() {
            return;
        }
        let (mut minx, mut maxx) = (pos[0].0, pos[0].0);
        let (mut miny, mut maxy) = (pos[0].1, pos[0].1);
        for p in pos {
            minx = minx.min(p.0);
            maxx = maxx.max(p.0);
            miny = miny.min(p.1);
            maxy = maxy.max(p.1);
        }
        let side = (maxx - minx).max(maxy - miny).max(1.0) * 1.02;
        self.cells.push(Cell {
            cmx: 0.0, cmy: 0.0, mass: 0.0,
            minx: minx - side * 0.01, miny: miny - side * 0.01, size: side,
            first_child: NIL, count: 0, head: NIL, tail: NIL,
        });
        for i in 0..pos.len() {
            self.insert(i, pos, masses);
        }
    }

    #[inline]
    fn child(&self, cell: usize, x: f64, y: f64) -> usize {
        let c = &self.cells[cell];
        let half = c.size / 2.0;
        let mut q = 0;
        if x >= c.minx + half {
            q |= 1;
        }
        if y >= c.miny + half {
            q |= 2;
        }
        (c.first_child + q) as usize
    }

    fn push_point(&mut self, cell: usize, p: usize) {
        self.next[p] = NIL;
        let tail = self.cells[cell].tail;
        if tail == NIL {
            self.cells[cell].head = p as i32;
        } else {
            self.next[tail as usize] = p as i32;
        }
        self.cells[cell].tail = p as i32;
        self.cells[cell].count += 1;
    }

    fn insert(&mut self, p: usize, pos: &[(f64, f64)], masses: &[f64]) {
        let mut cell = 0usize;
        let mut depth = 0u32;
        let (x, y) = pos[p];
        let mass = masses[p].max(0.0001);
        loop {
            let c = self.cells[cell];
            let total = c.mass + mass;
            let cm = &mut self.cells[cell];
            cm.cmx = (c.cmx * c.mass + x * mass) / total;
            cm.cmy = (c.cmy * c.mass + y * mass) / total;
            cm.mass = total;
            if self.cells[cell].first_child == NIL {
                if self.cells[cell].count < self.leaf_capacity || depth >= self.max_depth {
                    self.push_point(cell, p);
                    return;
                }
                self.subdivide(cell, pos, masses);
            }
            cell = self.child(cell, x, y);
            depth += 1;
        }
    }

    fn subdivide(&mut self, cell: usize, pos: &[(f64, f64)], masses: &[f64]) {
        let half = self.cells[cell].size / 2.0;
        let (bx, by) = (self.cells[cell].minx, self.cells[cell].miny);
        let first = self.cells.len() as i32;
        for q in 0..4 {
            self.cells.push(Cell {
                cmx: 0.0, cmy: 0.0, mass: 0.0,
                minx: bx + if q & 1 == 1 { half } else { 0.0 },
                miny: by + if q & 2 == 2 { half } else { 0.0 },
                size: half, first_child: NIL, count: 0, head: NIL, tail: NIL,
            });
        }
        self.cells[cell].first_child = first;
        let mut p = self.cells[cell].head;
        self.cells[cell].head = NIL;
        self.cells[cell].tail = NIL;
        self.cells[cell].count = 0;
        while p != NIL {
            let pi = p as usize;
            let nxt = self.next[pi];
            let (x, y) = pos[pi];
            let mass = masses[pi].max(0.0001);
            let target = self.child(cell, x, y);
            let t = self.cells[target];
            let total = t.mass + mass;
            let tc = &mut self.cells[target];
            tc.cmx = (t.cmx * t.mass + x * mass) / total;
            tc.cmy = (t.cmy * t.mass + y * mass) / total;
            tc.mass = total;
            self.push_point(target, pi);
            p = nxt;
        }
    }

    /// Repulsion delta on point `point`, as `repulsion(on:)` in SpatialTree.swift.
    fn repulsion(&self, point: usize, pos: &[(f64, f64)], masses: &[f64], strength: f64, theta: f64, alpha: f64) -> (f64, f64) {
        if self.cells.is_empty() {
            return (0.0, 0.0);
        }
        let (mut ddx, mut ddy) = (0.0f64, 0.0f64);
        let mut stack: Vec<usize> = Vec::with_capacity(64);
        stack.push(0);
        let (px, py) = pos[point];
        while let Some(cell) = stack.pop() {
            let c = &self.cells[cell];
            // NaN-safe: a NaN mass is skipped as well.
            if c.mass.is_nan() || c.mass <= 0.0 {
                continue;
            }
            if c.first_child == NIL {
                let mut p = c.head;
                while p != NIL {
                    let other = p as usize;
                    p = self.next[other];
                    if other == point {
                        continue;
                    }
                    let mut dx = pos[other].0 - px;
                    let mut dy = pos[other].1 - py;
                    let mut d2 = dx * dx + dy * dy;
                    if d2 < 1e-12 {
                        let (low, high) = if point < other { (point, other) } else { (other, point) };
                        let angle = ((low as i64).wrapping_mul(2_654_435_761).wrapping_add(high as i64) % 360) as f64
                            * std::f64::consts::PI / 180.0;
                        let sign = if point < other { -1.0 } else { 1.0 };
                        dx = angle.cos() * sign;
                        dy = angle.sin() * sign;
                        d2 = 1.0;
                    }
                    let softened = d2 + 0.5;
                    let scale = strength * alpha * masses[other].max(0.0001) / softened;
                    ddx += dx * scale;
                    ddy += dy * scale;
                }
                continue;
            }
            let dx = c.cmx - px;
            let dy = c.cmy - py;
            let d2 = dx * dx + dy * dy + 0.5;
            let size = c.size;
            let contains = px >= c.minx && px < c.minx + size && py >= c.miny && py < c.miny + size;
            if !contains && size * size < theta * theta * d2 {
                let scale = strength * alpha * c.mass / d2;
                ddx += dx * scale;
                ddy += dy * scale;
            } else {
                let f = c.first_child as usize;
                for q in 0..4 {
                    stack.push(f + q);
                }
            }
        }
        (ddx, ddy)
    }
}

// ---------------------------------------------------------------- Collision

fn resolve_overlaps(pos: &mut [(f64, f64)], radii: &[f64], passes: u32) {
    let n = pos.len();
    if n <= 1 {
        return;
    }
    let max_r = radii.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let cell = (max_r * 2.0).max(1.0);
    for _ in 0..passes.max(1) {
        let mut buckets: HashMap<i64, Vec<usize>> = HashMap::with_capacity(n * 2);
        for i in 0..n {
            buckets
                .entry(grid_key(grid_index(pos[i].0, cell), grid_index(pos[i].1, cell)))
                .or_default()
                .push(i);
        }
        let mut moved = false;
        for i in 0..n {
            let cx = grid_index(pos[i].0, cell);
            let cy = grid_index(pos[i].1, cell);
            for oy in -1i64..=1 {
                for ox in -1i64..=1 {
                    let Some(bucket) = buckets.get(&grid_key(cx + ox, cy + oy)) else { continue };
                    for &j in bucket {
                        if j <= i {
                            continue;
                        }
                        let minimum = radii[i] + radii[j] + 2.0;
                        let mut dx = pos[j].0 - pos[i].0;
                        let mut dy = pos[j].1 - pos[i].1;
                        let mut distance = (dx * dx + dy * dy).sqrt();
                        if distance >= minimum {
                            continue;
                        }
                        if distance < 1e-6 {
                            let angle = ((i as i64).wrapping_mul(2_654_435_761).wrapping_add(j as i64) % 360) as f64
                                * std::f64::consts::PI / 180.0;
                            dx = angle.cos();
                            dy = angle.sin();
                            distance = 1.0;
                        }
                        let push = (minimum - distance) / distance * 0.5;
                        let (sx, sy) = (dx * push, dy * push);
                        pos[i].0 -= sx;
                        pos[i].1 -= sy;
                        pos[j].0 += sx;
                        pos[j].1 += sy;
                        moved = true;
                    }
                }
            }
        }
        if !moved {
            break;
        }
    }
}

// ---------------------------------------------------------------- Force loop

pub struct ForceConfig {
    pub iterations: u32,
    pub theta: f64,
    pub velocity_decay: f64,
    pub repulsion: f64,
    pub link_spacing: f64,
    pub collision_passes: u32,
    pub cluster_gravity: f64,
    pub inter_community_scale: f64,
    pub alpha_min: f64,
}

impl Default for ForceConfig {
    fn default() -> Self {
        ForceConfig {
            iterations: 300, theta: 0.9, velocity_decay: 0.6, repulsion: -190.0, link_spacing: 46.0,
            collision_passes: 2, cluster_gravity: 0.16, inter_community_scale: 0.3, alpha_min: 0.001,
        }
    }
}

struct Spring {
    s: usize,
    t: usize,
    distance: f64,
    strength: f64,
    bias: f64,
}

// The 0.7071 literal is the Swift source's constant; keep it for bit parity.
#[allow(clippy::approx_constant)]
fn force_run(topo: &Topology, initial: Vec<(f64, f64)>, radii: &[f64], masses: &[f64],
             anchors: &[(f64, f64)], community: &[usize], cfg: &ForceConfig) -> Vec<(f64, f64)> {
    let n = topo.n;
    if n <= 1 || initial.len() != n {
        return initial;
    }
    let mut pos = initial;
    let mut vx = vec![0.0f64; n];
    let mut vy = vec![0.0f64; n];
    let mut tree = SpatialTree::new(n);
    let springs: Vec<Spring> = topo
        .links
        .iter()
        .map(|l| {
            let sd = topo.degree[l.source].max(1);
            let td = topo.degree[l.target].max(1);
            let rim = radii[l.source] + radii[l.target];
            let distance = rim + cfg.link_spacing * (1.65 - l.weight);
            let crosses = community[l.source] != community[l.target];
            let damping = if crosses { cfg.inter_community_scale } else { 1.0 };
            let strength = l.weight * damping / (sd.min(td) as f64);
            let bias = sd as f64 / (sd + td) as f64;
            Spring { s: l.source, t: l.target, distance, strength, bias }
        })
        .collect();

    let iterations = cfg.iterations.max(1);
    let alpha_decay = 1.0 - cfg.alpha_min.powf(1.0 / iterations as f64);
    let mut alpha = 1.0f64;

    for _ in 0..iterations {
        alpha += (0.0 - alpha) * alpha_decay;
        tree.rebuild(&pos, masses);
        for i in 0..n {
            let (dx, dy) = tree.repulsion(i, &pos, masses, cfg.repulsion, cfg.theta, alpha);
            vx[i] += dx;
            vy[i] += dy;
        }
        for sp in &springs {
            let (s, t) = (sp.s, sp.t);
            let mut dx = pos[t].0 + vx[t] - pos[s].0 - vx[s];
            let mut dy = pos[t].1 + vy[t] - pos[s].1 - vy[s];
            let mut distance = (dx * dx + dy * dy).sqrt();
            if distance < 1e-6 {
                dx = 0.7071;
                dy = 0.7071;
                distance = 1.0;
            }
            let scale = (distance - sp.distance) / distance * alpha * sp.strength;
            dx *= scale;
            dy *= scale;
            vx[t] -= dx * sp.bias;
            vy[t] -= dy * sp.bias;
            vx[s] += dx * (1.0 - sp.bias);
            vy[s] += dy * (1.0 - sp.bias);
        }
        for i in 0..n {
            vx[i] += (anchors[i].0 - pos[i].0) * cfg.cluster_gravity * alpha;
            vy[i] += (anchors[i].1 - pos[i].1) * cfg.cluster_gravity * alpha;
        }
        for i in 0..n {
            vx[i] *= cfg.velocity_decay;
            vy[i] *= cfg.velocity_decay;
            let step = (vx[i] * vx[i] + vy[i] * vy[i]).sqrt();
            let limit = 60.0;
            if step > limit {
                let clamp = limit / step;
                vx[i] *= clamp;
                vy[i] *= clamp;
            }
            if !vx[i].is_finite() || !vy[i].is_finite() {
                vx[i] = 0.0;
                vy[i] = 0.0;
                continue;
            }
            pos[i].0 += vx[i];
            pos[i].1 += vy[i];
        }
        if alpha < 0.35 {
            resolve_overlaps(&mut pos, radii, cfg.collision_passes);
        }
    }
    resolve_overlaps(&mut pos, radii, 4);
    pos
}

// ---------------------------------------------------------------- Orchestration

/// GraphLayoutOptions.automatic(nodeCount:) tiers, minus the quality flag.
pub fn automatic_options(n: usize) -> (u32, f64, f64) {
    match n {
        0..=199 => (400, 5.0, 26.0),
        200..=799 => (320, 5.0, 26.0),
        800..=2499 => (240, 5.0, 22.0),
        2500..=7999 => (170, 4.0, 18.0),
        _ => (120, 3.0, 14.0),
    }
}

pub struct LayoutOut {
    pub pos: Vec<(f64, f64)>,
    pub radius: Vec<f64>,
    pub community: Vec<usize>,
    pub degree: Vec<usize>,
    pub in_degree: Vec<usize>,
    pub link_weights: Vec<f64>,
    pub community_count: usize,
}

pub fn layout(input: &Input) -> LayoutOut {
    let (iterations, min_r, max_r) = automatic_options(input.n);
    let topo = Topology::build(input, MIN_WEIGHT);
    let n = topo.n;
    let importance = topo.page_rank();
    let community = louvain(&topo, 1.0);
    let groups = groups(&community);
    let span = max_r - min_r;
    let radii: Vec<f64> = (0..n).map(|i| min_r + span * importance[i].sqrt()).collect();
    let masses: Vec<f64> = (0..n).map(|i| 1.0 + topo.weighted_degree[i].sqrt()).collect();
    let anchors = cluster_anchors(&groups, &radii, n, 1.28);
    let seed = seed_positions(&groups, &anchors, &radii, n);
    let cfg = ForceConfig { iterations, ..ForceConfig::default() };
    let settled = force_run(&topo, seed, &radii, &masses, &anchors, &community, &cfg);
    LayoutOut {
        pos: settled,
        radius: radii,
        community,
        degree: topo.degree.clone(),
        in_degree: topo.in_degree.clone(),
        link_weights: topo.links.iter().map(|l| l.weight).collect(),
        community_count: groups.len(),
    }
}

pub fn encode_output(out: &LayoutOut) -> Vec<u8> {
    let n = out.pos.len();
    let mut buf = Vec::with_capacity(12 + n * 36 + out.link_weights.len() * 8);
    buf.extend_from_slice(&(n as u32).to_le_bytes());
    buf.extend_from_slice(&(out.link_weights.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(out.community_count as u32).to_le_bytes());
    for i in 0..n {
        buf.extend_from_slice(&out.pos[i].0.to_le_bytes());
        buf.extend_from_slice(&out.pos[i].1.to_le_bytes());
        buf.extend_from_slice(&out.radius[i].to_le_bytes());
        buf.extend_from_slice(&(out.community[i] as u32).to_le_bytes());
        buf.extend_from_slice(&(out.degree[i] as u32).to_le_bytes());
        buf.extend_from_slice(&(out.in_degree[i] as u32).to_le_bytes());
    }
    for w in &out.link_weights {
        buf.extend_from_slice(&w.to_le_bytes());
    }
    buf
}

pub fn run_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    let parsed = parse(input)?;
    Ok(encode_output(&layout(&parsed)))
}

// ---------------------------------------------------------------- WASM C ABI

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocate `len` bytes in the module's memory for the host to write the input into.
#[no_mangle]
pub extern "C" fn t0_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must be a pair returned by `t0_alloc` and not yet freed.
/// Free a buffer returned by `t0_alloc` with the same length.
#[no_mangle]
pub unsafe extern "C" fn t0_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr` must point to `len` readable bytes owned by the caller.
/// Run the layout on `len` input bytes at `ptr`. Returns 0 on success, nonzero on a bad input.
/// The output is retrieved with `t0_out_ptr` / `t0_out_len`.
#[no_mangle]
pub unsafe extern "C" fn t0_layout(ptr: *const u8, len: usize) -> i32 {
    let input = std::slice::from_raw_parts(ptr, len);
    match run_bytes(input) {
        Ok(out) => {
            OUT.with(|o| *o.borrow_mut() = out);
            0
        }
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn t0_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn t0_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}
