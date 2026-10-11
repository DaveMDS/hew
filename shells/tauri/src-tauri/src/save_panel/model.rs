//! What the webview asks the save panel for and what comes back, and the
//! two rules every platform's panel shares. Free of Tauri and of any one
//! platform's toolkit, so each platform's panel compiles on its own.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One entry of the panel's format list.
#[derive(Debug, Clone, Deserialize)]
pub struct PanelFormat {
    /// What the webview calls it (`"skp2017"`), handed back in the result.
    pub id: String,
    /// What the panel shows (`"SketchUp 2017 (.skp)"`).
    pub label: String,
    /// The file extension, without the dot.
    pub extension: String,
    /// The format's own options, shown while it is the chosen one.
    #[serde(default)]
    pub options: Vec<PanelOption>,
}

/// One option control: a choice list or a checkbox, with its current value.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PanelOption {
    Select {
        id: String,
        label: String,
        choices: Vec<PanelChoice>,
        value: String,
    },
    Check {
        id: String,
        label: String,
        value: bool,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct PanelChoice {
    pub value: String,
    pub label: String,
}

/// What the user confirmed.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PanelResult {
    pub path: String,
    pub format: String,
    pub options: BTreeMap<String, serde_json::Value>,
}

/// What the webview asked for.
#[derive(Debug, Clone)]
pub struct PanelRequest {
    pub title: String,
    pub default_name: String,
    pub formats: Vec<PanelFormat>,
    /// The index of the format chosen when the panel opens.
    pub initial: usize,
}

impl PanelOption {
    pub fn id(&self) -> &str {
        match self {
            PanelOption::Select { id, .. } | PanelOption::Check { id, .. } => id,
        }
    }

    pub fn value(&self) -> serde_json::Value {
        match self {
            PanelOption::Select { value, .. } => serde_json::Value::String(value.clone()),
            PanelOption::Check { value, .. } => serde_json::Value::Bool(*value),
        }
    }
}

/// The result for `format` at `path`, with its options' current values.
pub fn result_for(path: String, format: &PanelFormat) -> PanelResult {
    PanelResult {
        path,
        format: format.id.clone(),
        options: format
            .options
            .iter()
            .map(|o| (o.id().to_string(), o.value()))
            .collect(),
    }
}

/// `name` with the extension of the format left (`from`) swapped for the
/// one chosen (`to`); a name ending in neither keeps what the user typed.
pub fn rename_for(name: &str, from: &str, to: &str) -> String {
    let dotted = format!(".{from}");
    if name.len() > dotted.len() && name.to_lowercase().ends_with(&dotted.to_lowercase()) {
        format!("{}.{to}", &name[..name.len() - dotted.len()])
    } else {
        name.to_string()
    }
}

/// `path` with the chosen format's `extension`: as given when it already
/// ends in it (any case), else with it appended — a name typed with none,
/// or with another format's, still gets the file the format was written
/// as (`Model` → `Model.skp`, `Model.v2` → `Model.v2.skp`).
pub fn with_extension(path: &str, extension: &str) -> String {
    let has = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if has {
        path.to_string()
    } else {
        format!("{path}.{extension}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_format_change_swaps_only_the_extension_it_gave() {
        assert_eq!(rename_for("Model.hew", "hew", "skp"), "Model.skp");
        assert_eq!(rename_for("Model.HEW", "hew", "skp"), "Model.skp");
        assert_eq!(rename_for("Model.skp", "skp", "skp"), "Model.skp");
        // A name the user typed without it, or with another, is theirs.
        assert_eq!(rename_for("Model", "hew", "skp"), "Model");
        assert_eq!(rename_for("Model.v2", "hew", "skp"), "Model.v2");
        assert_eq!(rename_for(".hew", "hew", "skp"), ".hew");
    }

    #[test]
    fn a_saved_path_always_ends_in_its_formats_extension() {
        assert_eq!(with_extension("/d/Model.skp", "skp"), "/d/Model.skp");
        assert_eq!(with_extension("/d/Model.SKP", "skp"), "/d/Model.SKP");
        assert_eq!(with_extension("/d/Model", "skp"), "/d/Model.skp");
        assert_eq!(with_extension("/d/Model.v2", "skp"), "/d/Model.v2.skp");
        assert_eq!(with_extension("/d/x.glb", "stl"), "/d/x.glb.stl");
    }

    #[test]
    fn a_request_reads_the_webviews_formats_and_a_result_carries_every_option() {
        let formats: Vec<PanelFormat> = serde_json::from_value(serde_json::json!([
            { "id": "glb", "label": "glTF binary (.glb)", "extension": "glb" },
            { "id": "stl", "label": "STL (.stl)", "extension": "stl", "options": [
                { "kind": "select", "id": "segments", "label": "Curve resolution",
                  "choices": [{ "value": "0", "label": "As drawn" }, { "value": "96", "label": "Fine" }],
                  "value": "96" },
                { "kind": "check", "id": "solid_only", "label": "Solids only", "value": true }
            ]}
        ]))
        .unwrap();
        assert!(formats[0].options.is_empty());
        let r = result_for("/tmp/a.stl".into(), &formats[1]);
        assert_eq!(r.format, "stl");
        assert_eq!(r.options["segments"], serde_json::json!("96"));
        assert_eq!(r.options["solid_only"], serde_json::json!(true));
    }
}
