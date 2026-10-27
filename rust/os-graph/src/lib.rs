//! Canonical Rust implementation of the graph-kit "OS view" graph core.
//!
//! * [`builder`] — `build_system_graph`: categorize, detect communities, cap, ring.
//! * [`orbit`] — `orbit_layout`: deterministic 3D orbit layout (mulberry32 + relaxation).
//! * [`models`] / [`snapshot`] — the canonical graph model and the slice of `OsSnapshot` read.
//! * [`api`] — JSON-in/JSON-out entry points used by the optional `wasm` feature.
//!
//! Parity with the TypeScript oracle (`typescript/src/system/`) is enforced by
//! `tests/parity.rs` against golden files written by `typescript/scripts/gen-os-golden.mjs`.

pub mod api;
pub mod builder;
pub mod models;
pub mod orbit;
pub mod snapshot;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use builder::{
    build_system_graph, categorize, detect_communities, BuildOptions, CoreCategory, SystemCoreEdge,
    SystemCoreNode, SystemGraph, SystemRingItem, Truncated,
};
pub use models::{CGData, CGEdge, CGLayer, CGNode, CGPosition, CGTourStep};
pub use orbit::{fibonacci_sphere, mulberry32, orbit_layout, OrbitLayout, OrbitOptions, Vec3};
pub use snapshot::OsSnapshot;
