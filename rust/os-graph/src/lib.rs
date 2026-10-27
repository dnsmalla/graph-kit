//! Canonical Rust implementation of the graph-kit "OS view" graph core.
//!
//! * [`builder`] — `build_system_graph`: categorize, detect communities, cap, ring.
//! * [`orbit`] — `orbit_layout`: deterministic 3D orbit layout (mulberry32 + relaxation).
//! * [`models`] / [`snapshot`] — the canonical graph model and the slice of `OsSnapshot` read.
//! * [`viz`] — `VizGraph`: the whole OS as one graph plus one graph per part.
//! * [`api`] — JSON-in/JSON-out entry points used by the optional `wasm` feature.
//!
//! Behaviour is pinned by unit tests and by `tests/parity.rs`, which checks frozen golden
//! files in `tests/golden/`. The goldens were recorded from the TypeScript implementation
//! before it was removed; to add a case, write the golden by hand or from this crate.

pub mod api;
pub mod builder;
pub mod models;
pub mod orbit;
pub mod snapshot;
pub mod viz;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use builder::{
    build_system_graph, categorize, detect_communities, BuildOptions, CoreCategory, SystemCoreEdge,
    SystemCoreNode, SystemGraph, SystemRingItem, Truncated,
};
pub use models::{CGData, CGEdge, CGLayer, CGNode, CGPosition, CGTourStep};
pub use orbit::{
    fibonacci_sphere, mulberry32, orbit_layout, OrbitLayout, OrbitOptions, Vec3, MAX_ITERATIONS,
    MAX_RADIUS,
};
pub use snapshot::ActivityId;
pub use snapshot::OsSnapshot;
pub use snapshot::OsSnapshotFull;
pub use viz::{
    build_hub_graph, build_os_graph, build_os_view, code_summary, CodeSummary, CommunitySummary,
    OsView, OsVizInput, Routine, Skill, VizEdge, VizGraph, VizNode, HUB_KEYS,
};
