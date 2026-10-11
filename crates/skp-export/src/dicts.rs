//! Attribute dictionaries: Hew's own attributes as SketchUp's, and the
//! `hew` dictionary that carries what a `.skp` has no field for, so a file
//! Hew wrote opens in Hew again with nothing lost. SketchUp keeps a
//! dictionary it does not know through its own saves.
//!
//! The `hew` dictionary (all keys optional; readers ignore unknown keys):
//!
//! | owner | key | value |
//! |---|---|---|
//! | model | `version` | 1 |
//! | model | `tag_paths` | `[[layer name, [segment, …]], …]` — each layer's tag path |
//! | model, definition | `loose` | `"sketches"` (loose geometry of the list is drawn sketches) or `"object"` (the definition's geometry is one solid) |
//! | model, definition | `sketch_planes` | `[[origin xyz, normal xyz], …]`, one per sketch drawn into the list |
//! | model | `scene_display` | `[[scene name, grid, axes, guides], …]` |
//! | definition | `unnamed` | true: the definition's geometry is a solid that had no name of its own |
//! | definition | `built` | true: Hew wrote the definition's geometry (a reader takes it as written, unrepaired) |
//! | model | `loose_built` | true: Hew wrote the model's loose geometry (likewise) |
//! | placement | `kind` | `"object"` or `"group"` |
//! | placement | `unnamed` | true: the node had no name (the definition's is SketchUp's own) |
//! | placement | `tags` | `[[segment, …], …]` when the node had more than one tag |
//! | face | `surface` | `[axis point xyz, axis xyz, radius]`, meters: the face is a facet of that cylinder |
//! | edge | `sketch` | index into the list's `sketch_planes`: the sketch the edge was drawn in (written when the list holds more than one sketch) |
//! | text, dimension, radius dimension | `annotation` | the Hew annotation it was written from ([`encode_annotation`]) |
//! | model | `annotations` | Hew annotations with no SketchUp form here (a radius dimension of a circle not drawn) |
//! | curve | `polygon` | `[center xyz, circumradius]`: the welded curve is a regular polygon's sides |

use std::collections::BTreeMap;

use kernel::AttrValue;
use openskp::{Dictionary, Value};

/// The name of Hew's own dictionary.
pub(crate) const HEW: &str = "hew";

/// Hew attribute namespaces as SketchUp dictionaries. A value SketchUp
/// has no type for (a map, an integer past 32 bits) is stored as its JSON
/// text, and its key listed under `hew_json` in the same dictionary so a
/// reader can turn it back.
pub(crate) fn from_attrs(dict: &kernel::AttrDict) -> Vec<Dictionary> {
    dict.iter()
        .map(|(ns, entries)| {
            let mut json_keys = Vec::new();
            let mut out: Vec<(String, Value)> = entries
                .iter()
                .map(|(k, v)| {
                    let value = value_of(v).unwrap_or_else(|| {
                        json_keys.push(Value::Text(k.clone()));
                        Value::Text(json_of(v))
                    });
                    (k.clone(), value)
                })
                .collect();
            if !json_keys.is_empty() {
                out.push(("hew_json".to_string(), Value::Array(json_keys)));
            }
            Dictionary {
                name: ns.clone(),
                entries: out,
                flag: 0,
            }
        })
        .collect()
}

/// A Hew value SketchUp can hold as it is.
fn value_of(v: &AttrValue) -> Option<Value> {
    Some(match v {
        AttrValue::Null => Value::Nil,
        AttrValue::Bool(b) => Value::Bool(*b),
        AttrValue::Int(i) => Value::Int(i32::try_from(*i).ok()?),
        AttrValue::Float(f) => Value::Double(*f),
        AttrValue::Text(s) => Value::Text(s.clone()),
        AttrValue::List(items) => Value::Array(items.iter().map(value_of).collect::<Option<_>>()?),
        AttrValue::Map(_) => return None,
    })
}

/// JSON text of a value (finite numbers only: Hew refuses the others).
fn json_of(v: &AttrValue) -> String {
    match v {
        AttrValue::Null => "null".into(),
        AttrValue::Bool(b) => b.to_string(),
        AttrValue::Int(i) => i.to_string(),
        AttrValue::Float(f) => {
            let s = f.to_string();
            if s.contains(['.', 'e', 'E']) {
                s
            } else {
                format!("{s}.0")
            }
        }
        AttrValue::Text(s) => json_string(s),
        AttrValue::List(items) => {
            format!(
                "[{}]",
                items.iter().map(json_of).collect::<Vec<_>>().join(",")
            )
        }
        AttrValue::Map(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, v)| format!("{}:{}", json_string(k), json_of(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Entries of the `hew` dictionary under construction for one owner.
#[derive(Default)]
pub(crate) struct HewDict(pub BTreeMap<&'static str, Value>);

impl HewDict {
    pub(crate) fn set(&mut self, key: &'static str, value: Value) {
        self.0.insert(key, value);
    }

    /// The entries as one value (a `hew` key that nests a whole record).
    pub(crate) fn into_value(self) -> Value {
        self.0.into_values().next().unwrap_or(Value::Nil)
    }

    pub(crate) fn into_dictionary(self) -> Option<Dictionary> {
        (!self.0.is_empty()).then(|| Dictionary {
            name: HEW.to_string(),
            entries: self
                .0
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            flag: 0,
        })
    }
}

/// A tag path as a `hew` value.
pub(crate) fn path_value(path: &[String]) -> Value {
    Value::Array(path.iter().map(|s| Value::Text(s.clone())).collect())
}

/// A Hew annotation as a `hew` value, read back by `skp-import`:
/// `["linear", a, b, offset, plane origin, plane normal, override]`,
/// `["text", anchor, offset, text]`, or `["radial", anchor, leader
/// direction, center, radius, plane origin, plane normal, "radius" |
/// "diameter", override]` — points and vectors as three doubles each,
/// meters; an absent override as nil.
pub(crate) fn encode_annotation(a: &kernel::Annotation) -> Value {
    let p = |p: kernel::Point3| [p.x, p.y, p.z].map(Value::Double);
    let v = |v: kernel::Vec3| [v.x, v.y, v.z].map(Value::Double);
    let text = |t: &Option<String>| t.clone().map_or(Value::Nil, Value::Text);
    let mut out = Vec::new();
    match a {
        kernel::Annotation::LinearDimension {
            a,
            b,
            offset,
            plane,
            text_override,
        } => {
            out.push(Value::Text("linear".into()));
            out.extend(p(a.point));
            out.extend(p(b.point));
            out.extend(v(*offset));
            out.extend(p(plane.point()));
            out.extend(v(plane.normal()));
            out.push(text(text_override));
        }
        kernel::Annotation::LeaderText {
            anchor,
            offset,
            text: t,
        } => {
            out.push(Value::Text("text".into()));
            out.extend(p(anchor.point));
            out.extend(v(*offset));
            out.push(Value::Text(t.clone()));
        }
        kernel::Annotation::RadialDimension {
            anchor,
            kind,
            curve,
            leader_dir,
            text_override,
        } => {
            out.push(Value::Text("radial".into()));
            out.extend(p(anchor.point));
            out.extend(v(*leader_dir));
            out.extend(p(curve.center));
            out.push(Value::Double(curve.radius));
            out.extend(p(curve.plane.point()));
            out.extend(v(curve.plane.normal()));
            out.push(Value::Text(
                match kind {
                    kernel::RadialKind::Radius => "radius",
                    kernel::RadialKind::Diameter => "diameter",
                }
                .into(),
            ));
            out.push(text(text_override));
        }
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_map_is_stored_as_json_and_listed() {
        let mut ns = BTreeMap::new();
        let mut m = BTreeMap::new();
        m.insert(
            "a\"b".to_string(),
            AttrValue::List(vec![AttrValue::Int(1), AttrValue::Float(2.0)]),
        );
        ns.insert("k".to_string(), AttrValue::Map(m));
        ns.insert("n".to_string(), AttrValue::Int(5));
        let mut dict = kernel::AttrDict::new();
        dict.insert("plugin".to_string(), ns);
        let d = &from_attrs(&dict)[0];
        assert_eq!(d.name, "plugin");
        assert!(
            d.entries
                .contains(&("k".into(), Value::Text(r#"{"a\"b":[1,2.0]}"#.into())))
        );
        assert!(d.entries.contains(&("n".into(), Value::Int(5))));
        assert!(d.entries.contains(&(
            "hew_json".into(),
            Value::Array(vec![Value::Text("k".into())])
        )));
    }
}
