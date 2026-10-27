//! Canonical GraphKit graph model (mirror of `typescript/src/models.ts`).
//!
//! Field names follow the canonical JSON (camelCase). The JSON boundary is as lenient as the
//! TS builder, which reads only a few fields and never throws on a missing or odd one:
//!
//! * unknown fields are ignored;
//! * a missing or non-string `title` leaves the label absent (the TS gives `undefined`, which
//!   `JSON.stringify` drops), and a missing `kind` / edge `kind` / `confidence` is `""`;
//! * `metadata` may be `null`, a non-object, or hold any values: only **string** values are
//!   kept, everything else is skipped (a later duplicate key that is not a string removes the
//!   earlier one, as `JSON.parse` keeps the last value);
//! * a node without a string `id`, or an element that does not fit the model, is skipped
//!   rather than failing the whole project;
//! * an edge without a string `fromId` / `toId` is dropped by the builder, as in the TS.
//!
//! Known remaining strictness: nesting deeper than serde_json's fixed 128-level limit is
//! rejected for the whole document (`JSON.parse` has no such limit).

use serde::de::{self, DeserializeOwned, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CGPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGNode {
    pub id: String,
    /// Missing or non-string title: `None` (the label is then omitted from the system graph).
    #[serde(
        default,
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub kind: String,
    /// Layout hint only — carries no semantic meaning. Malformed values are ignored.
    #[serde(
        default,
        deserialize_with = "lenient_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub position: Option<CGPosition>,
    /// Only string values survive (see the module docs).
    #[serde(default, deserialize_with = "lenient_metadata")]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CGEdge {
    /// `None` when missing or not a string: the builder drops such an edge, as the TS does.
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub from_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_opt_string")]
    pub to_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub kind: String,
    #[serde(default, deserialize_with = "lenient_string")]
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
    #[serde(default, deserialize_with = "lenient_vec")]
    pub nodes: Vec<CGNode>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub edges: Vec<CGEdge>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub layers: Vec<CGLayer>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub tour: Vec<CGTourStep>,
}

/// A JSON array whose elements are each deserialized as `T`; elements that do not fit are
/// dropped. A `null`, a missing value, or any non-array (an object, a string, a number) is
/// empty: a list field of the wrong shape never fails the document around it.
pub(crate) fn lenient_vec<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let values = match Option::<serde_json::Value>::deserialize(d)? {
        Some(serde_json::Value::Array(items)) => items,
        _ => Vec::new(),
    };
    Ok(values
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

/// Any JSON value as `Option<T>`: `None` when it does not fit `T`.
pub(crate) fn lenient_value<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| serde_json::from_value(v).ok()))
}

/// A JSON number as `f64`, anything else (including `null` and numeric strings) as `None`.
/// Matches the TS checks `typeof v === "number"`; it does not coerce strings.
pub(crate) fn lenient_f64<'de, D>(d: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| v.as_f64()))
}

/// A JSON string, or `None` for any other value (the builder reads only string fields).
pub(crate) fn lenient_opt_string<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    d.deserialize_any(OptStringVisitor)
}

/// A JSON string, or `""` for any other value.
pub(crate) fn lenient_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(lenient_opt_string(d)?.unwrap_or_default())
}

/// `metadata`: an object keeps its string-valued entries; `null`, a non-object, and any
/// non-string value are skipped without error. The last duplicate key wins, like `JSON.parse`.
pub(crate) fn lenient_metadata<'de, D>(d: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: Deserializer<'de>,
{
    d.deserialize_any(MetadataVisitor)
}

/// Newtype so a map value can go through the lenient string visitor.
struct OptString(Option<String>);

impl<'de> Deserialize<'de> for OptString {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        lenient_opt_string(d).map(OptString)
    }
}

struct OptStringVisitor;

impl<'de> Visitor<'de> for OptStringVisitor {
    type Value = Option<String>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(Some(v))
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        IgnoredAny::deserialize(d)?;
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(None)
    }
}

struct MetadataVisitor;

impl<'de> Visitor<'de> for MetadataVisitor {
    type Value = BTreeMap<String, String>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            match map.next_value::<OptString>()?.0 {
                Some(value) => {
                    out.insert(key, value);
                }
                // A later non-string duplicate hides an earlier string, as in JS.
                None => {
                    out.remove(&key);
                }
            }
        }
        Ok(out)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(BTreeMap::new())
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_string<E: de::Error>(self, _: String) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(BTreeMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> CGData {
        serde_json::from_str(text).unwrap_or_else(|e| panic!("{e}: {text}"))
    }

    #[test]
    fn metadata_keeps_only_string_values() {
        let data = parse(
            r#"{"nodes":[{"id":"a.ts","title":"a","kind":"file","metadata":{
                "path":"docs/a.md","source_file":5,"file":{"x":[1,{"y":null}]},
                "source_path":"","other":[true,null],"flag":false,"n":null,"deep":[[[[]]]]}}]}"#,
        );
        let m = &data.nodes[0].metadata;
        assert_eq!(m.len(), 2, "{m:?}");
        assert_eq!(m["path"], "docs/a.md");
        assert_eq!(m["source_path"], "");
    }

    #[test]
    fn metadata_null_missing_and_non_object_give_an_empty_map() {
        let data = parse(
            r#"{"nodes":[
                {"id":"n1","metadata":null},
                {"id":"n2"},
                {"id":"n3","metadata":["docs/x.md"]},
                {"id":"n4","metadata":"docs/x.md"},
                {"id":"n5","metadata":7}]}"#,
        );
        assert_eq!(data.nodes.len(), 5);
        assert!(data.nodes.iter().all(|n| n.metadata.is_empty()));
    }

    #[test]
    fn a_later_non_string_duplicate_hides_the_earlier_string_as_in_js() {
        // JSON.parse keeps the last value of a duplicated key.
        let data = parse(r#"{"nodes":[{"id":"a","metadata":{"path":"docs/a.md","path":5}}]}"#);
        assert!(!data.nodes[0].metadata.contains_key("path"));
        let data = parse(r#"{"nodes":[{"id":"a","metadata":{"path":5,"path":"tests/a.ts"}}]}"#);
        assert_eq!(data.nodes[0].metadata["path"], "tests/a.ts");
    }

    #[test]
    fn missing_title_kind_and_edge_fields_are_accepted() {
        let data = parse(
            r#"{"nodes":[{"id":"a.ts"}],
                "edges":[{"fromId":"a.ts"},{"toId":"a.ts","kind":"calls"}]}"#,
        );
        assert_eq!(data.nodes[0].title, None);
        assert_eq!(data.nodes[0].kind, "");
        assert_eq!(data.edges[0].kind, "");
        assert_eq!(data.edges[0].confidence, "");
        assert_eq!(data.edges[0].to_id, None);
        assert_eq!(data.edges[1].from_id, None);
    }

    #[test]
    fn non_string_title_and_endpoints_become_absent() {
        let data = parse(
            r#"{"nodes":[{"id":"a","title":5,"kind":true}],"edges":[{"fromId":3,"toId":"a"}]}"#,
        );
        assert_eq!(data.nodes[0].title, None);
        assert_eq!(data.nodes[0].kind, "");
        assert_eq!(data.edges[0].from_id, None);
    }

    #[test]
    fn nodes_without_a_string_id_and_malformed_entries_are_skipped() {
        let data = parse(
            r#"{"nodes":[{"id":"ok"},{"title":"no id"},{"id":7},null,"text",{"id":"ok2"}],
                "edges":[{"fromId":"ok","toId":"ok2"},17],
                "layers":[{"id":"x"}],"tour":[{"nodeId":"ok","title":"t","body":"b"}]}"#,
        );
        let ids: Vec<&str> = data.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["ok", "ok2"]);
        assert_eq!(data.edges.len(), 1);
        assert!(data.layers.is_empty());
        assert_eq!(data.tour.len(), 1);
    }

    #[test]
    fn malformed_position_is_ignored_not_fatal() {
        let data = parse(r#"{"nodes":[{"id":"a","position":{"x":"left","y":1}}]}"#);
        assert_eq!(data.nodes[0].position, None);
        let data = parse(r#"{"nodes":[{"id":"a","position":{"x":1,"y":2}}]}"#);
        assert_eq!(data.nodes[0].position, Some(CGPosition { x: 1.0, y: 2.0 }));
    }

    #[test]
    fn null_project_and_null_arrays_are_empty() {
        assert_eq!(parse("{}"), CGData::default());
        assert_eq!(parse(r#"{"nodes":null,"edges":null}"#), CGData::default());
    }

    #[test]
    fn metadata_nested_beyond_serde_json_depth_limit_is_rejected_whole() {
        // Known limit: serde_json caps nesting at 128 levels, JSON.parse does not. Such a
        // document makes the builder return an error object instead of a graph.
        let depth = 200;
        let nested = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        let text = format!(r#"{{"nodes":[{{"id":"a","metadata":{{"x":{nested}}}}}]}}"#);
        assert!(serde_json::from_str::<CGData>(&text).is_err());
    }
}
