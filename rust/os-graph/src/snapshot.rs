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

/// The TS template literal `activity:${item.id}` formats the id with `String(id)`. A number
/// (SQLite rowid) is kept as f64 and formatted the same way; a string is used verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActivityId {
    Number(f64),
    Text(String),
}

impl ActivityId {
    /// `String(id)` in JS.
    pub fn to_js_string(&self) -> String {
        match self {
            ActivityId::Number(n) => crate::builder::js_number_string(*n),
            ActivityId::Text(s) => s.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsActivityItem {
    /// Activity id: a JSON number or string (see [`ActivityId`]).
    pub id: ActivityId,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub link: Option<String>,
    pub created_at: String,
}
