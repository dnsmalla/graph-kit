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

// ---- Lenient OS snapshot for the VizGraph builders (`viz.rs`). ----
//
// Every field has a default and every bad value falls back to it, so a server that adds or
// reshapes a field never fails the whole view. Only the parts the OS graph reads are declared.

use crate::models::{lenient_opt_string, lenient_string, lenient_value, lenient_vec};
use serde::de::DeserializeOwned;
use serde::Deserializer;
use serde_json::Value;
use std::collections::BTreeMap;

/// `T::default()` when the value does not fit `T`.
pub(crate) fn lenient_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    Ok(Option::<Value>::deserialize(d)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

/// A JSON number, else `0.0`.
pub(crate) fn lenient_num<'de, D>(d: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(d)?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0))
}

/// A JSON boolean, else `false`.
pub(crate) fn lenient_bool<'de, D>(d: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(d)?
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// An array of strings (non-string elements skipped); anything else is empty.
pub(crate) fn lenient_str_list<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(lenient_opt_str_list(d)?.unwrap_or_default())
}

/// An array of strings as `Some`; `null` or any other value as `None`.
pub(crate) fn lenient_opt_str_list<'de, D>(d: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Array(items)) => Some(
            items
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => None,
    })
}

/// A JSON object of numbers; non-number values are skipped.
pub(crate) fn lenient_num_map<'de, D>(d: D) -> Result<BTreeMap<String, f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Object(map)) => map
            .into_iter()
            .filter_map(|(k, v)| v.as_f64().map(|n| (k, n)))
            .collect(),
        _ => BTreeMap::new(),
    })
}

/// Lenient view of `OsSnapshot` (`typescript/src/system/types.ts`): the system, running,
/// token and knowledge parts the OS graph reads. Activity is not read here.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSnapshotFull {
    #[serde(default, deserialize_with = "lenient_default")]
    pub system: OsSystem,
    #[serde(default, deserialize_with = "lenient_default")]
    pub running: OsRunning,
    #[serde(default, deserialize_with = "lenient_default")]
    pub tokens: OsTokens,
    #[serde(default, deserialize_with = "lenient_default")]
    pub knowledge: OsKnowledge,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSystem {
    /// `null` (or not an array) means every feature is on.
    #[serde(default, deserialize_with = "lenient_opt_str_list")]
    pub features: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub kits: Vec<OsKit>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub status: String,
    /// `None` when the snapshot carries no checks (or they do not fit): the checks are then
    /// unknown, not failing.
    #[serde(default, deserialize_with = "lenient_value")]
    pub checks: Option<OsChecks>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsKit {
    #[serde(default, deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default, deserialize_with = "lenient_str_list")]
    pub requires: Vec<String>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsChecks {
    #[serde(default, deserialize_with = "lenient_bool")]
    pub db: bool,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub claude: bool,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub claude_error: Option<String>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub skills: bool,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub skills_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsRunning {
    #[serde(default, deserialize_with = "lenient_vec")]
    pub chat_turns: Vec<OsChatTurn>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub meeting_agent_runs: Vec<OsAgentRun>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub live_sessions: Vec<OsLiveSession>,
}

/// `cancel` is kept as JSON: an object when the item can be stopped, `null` otherwise.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsChatTurn {
    #[serde(default, deserialize_with = "lenient_string")]
    pub chat_session_id: String,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub started_at: Option<String>,
    #[serde(default)]
    pub cancel: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsAgentRun {
    #[serde(default, deserialize_with = "lenient_string")]
    pub session_id: String,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub plan_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub started_at: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub last_tick_at: Option<String>,
    #[serde(default)]
    pub cancel: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsLiveSession {
    #[serde(default, deserialize_with = "lenient_string")]
    pub session_id: String,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub meeting_title: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub started_at: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub last_write: Option<String>,
    #[serde(default, deserialize_with = "lenient_num")]
    pub caption_count: f64,
    #[serde(default)]
    pub cancel: Value,
}

/// Token counts shared by the totals and every breakdown row.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsCounts {
    #[serde(default, deserialize_with = "lenient_num")]
    pub calls: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub runs: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub input: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub output: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub cache_read: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub cache_write: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub billable: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTokens {
    #[serde(default, deserialize_with = "lenient_default")]
    pub totals: OsCounts,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub by_model: Vec<OsModelUsage>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub by_source: Vec<OsSourceUsage>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub by_endpoint: Vec<OsEndpointUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsModelUsage {
    #[serde(default, deserialize_with = "lenient_string")]
    pub provider: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub model: String,
    #[serde(flatten)]
    pub counts: OsCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSourceUsage {
    /// `api`, `cli` or `auto-task`.
    #[serde(default, deserialize_with = "lenient_string")]
    pub source: String,
    #[serde(flatten)]
    pub counts: OsCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsEndpointUsage {
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub endpoint: Option<String>,
    #[serde(flatten)]
    pub counts: OsCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsKnowledge {
    #[serde(default, deserialize_with = "lenient_default")]
    pub sources: OsSources,
    #[serde(default, deserialize_with = "lenient_default")]
    pub meetings: OsMeetings,
    #[serde(default, deserialize_with = "lenient_num")]
    pub pending_reviews: f64,
    #[serde(default, deserialize_with = "lenient_default")]
    pub outcomes: OsOutcomes,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub code_graph: Vec<OsCodeGraph>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub project_memory: Vec<OsProjectMemory>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSources {
    #[serde(default, deserialize_with = "lenient_num")]
    pub total: f64,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub by_kind: Vec<OsKindCount>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsKindCount {
    #[serde(default, deserialize_with = "lenient_string")]
    pub kind: String,
    #[serde(default, deserialize_with = "lenient_num")]
    pub count: f64,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub last_indexed_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsMeetings {
    #[serde(default, deserialize_with = "lenient_num")]
    pub count: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsOutcomes {
    #[serde(default, deserialize_with = "lenient_num")]
    pub total: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub terminal: f64,
    #[serde(default, deserialize_with = "lenient_num_map")]
    pub by_state: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsCodeGraph {
    #[serde(default, deserialize_with = "lenient_string")]
    pub repo_id: String,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub commit_sha: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsProjectMemory {
    #[serde(default, deserialize_with = "lenient_string")]
    pub repo_root: String,
    #[serde(default, deserialize_with = "lenient_num")]
    pub facts: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub active: f64,
    #[serde(default, deserialize_with = "lenient_num")]
    pub superseded: f64,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub last_confirmed_at: Option<String>,
}
