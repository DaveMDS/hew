//! What real SketchUp makes of the files Hew writes, opt-in: point
//! `HEW_SKP_RESAVES` at a directory the `skp_acceptance` example wrote and
//! SketchUp re-saved (`<name>.skp`, `<name>.expect.hew`, and SketchUp's
//! `<name>-resaved.skp` — the sketchup-make-2017 skill's batch for 2017
//! files, the web app's download for 2026 ones). For each re-save, the
//! document Hew reads back from it must be the document Hew wrote —
//! Hew -> .skp -> SketchUp -> .skp -> Hew, with nothing lost or changed —
//! and the file Hew wrote must read back the same way too.
//!
//! ```text
//! HEW_SKP_RESAVES=target/skp-acceptance cargo test --release -p skp-export --test sketchup_resaves -- --nocapture
//! ```
//!
//! What SketchUp itself changes on a save is normalized away, each with
//! its reason: see `normalize`.

mod common;

use std::path::Path;

use common::{DocD, digest, near};
use kernel::Document;

fn read(bytes: &[u8]) -> Result<Document, String> {
    let out = skp_import::import(bytes).map_err(|e| e.to_string())?;
    let mut doc = Document::new();
    doc.ingest(out.scene, out.textures_missing)
        .map_err(|e| format!("{e:?}"))?;
    Ok(doc)
}

/// What a SketchUp save changes that is not a difference in the model:
/// the view it was saved with (SketchUp saves its own current camera).
fn normalize(mut d: DocD) -> DocD {
    d.camera = None;
    d
}

fn differs(a: &DocD, b: &DocD) -> Vec<String> {
    let mut out = Vec::new();
    macro_rules! f {
        ($f:ident) => {
            let (p, q) = (format!("{:?}", a.$f), format!("{:?}", b.$f));
            if p != q && !near(&p, &q) {
                let at = p.chars().zip(q.chars()).take_while(|(x, y)| x == y).count();
                let win = |s: &str| {
                    s.chars()
                        .skip(at.saturating_sub(160))
                        .take(360)
                        .collect::<String>()
                };
                out.push(format!(
                    "{} differs at {at}:\n      hew:      …{}…\n      sketchup: …{}…",
                    stringify!($f),
                    win(&p),
                    win(&q)
                ));
            }
        };
    }
    f!(roots);
    f!(tags);
    f!(guides);
    f!(section);
    f!(camera);
    f!(scenes);
    f!(sketches);
    f!(attrs);
    f!(annotations);
    out
}

#[test]
fn sketchup_resaves_read_back_as_the_document_hew_wrote() {
    let Ok(dir) = std::env::var("HEW_SKP_RESAVES") else {
        eprintln!("HEW_SKP_RESAVES not set; skipped");
        return;
    };
    // Relative to the workspace root, where the example writes it.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(dir);
    let dir = dir.as_path();
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let n = e.unwrap().file_name().to_string_lossy().to_string();
            n.strip_suffix("-resaved.skp").map(str::to_string)
        })
        .collect();
    names.sort();
    let (mut ok, mut bad) = (0, Vec::new());
    for name in &names {
        let expect =
            Document::load(&std::fs::read(dir.join(format!("{name}.expect.hew"))).unwrap())
                .unwrap();
        let want = normalize(digest(&expect));
        let mut problems = Vec::new();
        for (label, file) in [
            ("written", format!("{name}.skp")),
            ("resaved", format!("{name}-resaved.skp")),
        ] {
            match read(&std::fs::read(dir.join(&file)).unwrap()) {
                Err(e) => problems.push(format!("  {label}: does not import: {e}")),
                Ok(doc) => {
                    for d in differs(&want, &normalize(digest(&doc))) {
                        problems.push(format!("  {label}: {d}"));
                    }
                }
            }
        }
        if problems.is_empty() {
            ok += 1;
        } else {
            bad.push(format!("{name}:\n{}", problems.join("\n")));
        }
    }
    println!("{ok} of {} re-saves read back as written", names.len());
    for b in &bad {
        println!("{b}");
    }
    assert!(bad.is_empty(), "{} of {} differ", bad.len(), names.len());
}
