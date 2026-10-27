//! The slice of `OsSnapshot` (`typescript/src/system/types.ts`) that the builder reads.
//! Everything else in the server response is ignored.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSnapshot {
    pub activity: OsActivity,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsActivity {
    /// Newest first.
    #[serde(default)]
    pub items: Vec<OsActivityItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsActivityItem {
    /// SQLite rowid. Kept as f64 so the ring id is formatted exactly like the JS template literal.
    pub id: f64,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub link: Option<String>,
    pub created_at: String,
}
