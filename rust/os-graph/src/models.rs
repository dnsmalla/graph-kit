//! Canonical GraphKit graph model (mirror of `typescript/src/models.ts`).
//!
//! Field names follow the canonical JSON (camelCase). Unknown fields are ignored.
//! `kind`, `confidence` and metadata values are kept as plain strings/JSON values so
//! that the builder stays as lenient as the TS builder (it only ever reads string
//! metadata, and unknown kinds are treated as code, exactly like the TS).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CGPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGNode {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// Layout hint only — carries no semantic meaning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<CGPosition>,
    /// The schema says string values; non-string values are ignored by the categorizer.
    #[serde(default)]
    pub metadata: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGEdge {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub confidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGLayer {
    pub id: String,
    pub name: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGTourStep {
    pub node_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGData {
    #[serde(default)]
    pub nodes: Vec<CGNode>,
    #[serde(default)]
    pub edges: Vec<CGEdge>,
    #[serde(default)]
    pub layers: Vec<CGLayer>,
    #[serde(default)]
    pub tour: Vec<CGTourStep>,
}
