//! Hew -> `.skp` -> Hew: a document written by `skp-export` and read back
//! by `skp-import` is the same document, on both containers.
//!
//! Sources: every `skp-import` fixture (2017 and its 2026 twin) imported
//! into a fresh document, and `fixtures/native.hew`, drawn in Hew. The
//! comparison is a canonical digest of what the user sees and edits — the
//! node tree with names, tags, hidden state, poses and attributes, each
//! Object's faces (positions to a micron, each face's effective material,
//! textured corners' UVs), its soft edges, circle claims and curved faces,
//! definitions, sketches with their curves, the tag registry, guides, the
//! section plane, the camera, the scenes with their display toggles, and
//! the document's own attributes. What the digest normalizes away, and why:
//!
//! - ring start corners and face/sibling order (no meaning in either file);
//! - unused palette materials: the importer brings in referenced materials
//!   only, so the palettes compare by the materials faces resolve to.

mod common;

use std::path::Path;

use common::{digest, near};
use kernel::Document;
use skp_export::{Target, WriteEnv, export};

fn fixtures() -> Vec<(String, Vec<u8>)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skp-import/tests/fixtures");
    let mut out = Vec::new();
    for dir in [root.clone(), root.join("2026")] {
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "skp"))
            .collect();
        names.sort();
        for p in names {
            let label = p.strip_prefix(&root).unwrap().display().to_string();
            out.push((label, std::fs::read(&p).unwrap()));
        }
    }
    out
}

fn import(bytes: &[u8]) -> Document {
    let out = skp_import::import(bytes).expect("imports");
    let mut doc = Document::new();
    doc.ingest(out.scene, out.textures_missing)
        .expect("ingests");
    doc
}

fn round_trip(label: &str, source: &Document, target: Target) -> Result<(), String> {
    let written =
        export(source, target, WriteEnv::system()).map_err(|e| format!("{label}: {e}"))?;
    let model =
        openskp::Model::parse(&written.bytes).map_err(|e| format!("{label}: reread: {e:?}"))?;
    let desync: Vec<_> = model.diagnostics.iter().filter(|d| d.is_desync()).collect();
    if !desync.is_empty() {
        return Err(format!(
            "{label}: written file reads with desyncs: {desync:?}"
        ));
    }
    if target == Target::Skp2017 {
        openskp::verify(&written.bytes).map_err(|e| format!("{label}: 2017 grammar: {e:?}"))?;
    }
    let back = import(&written.bytes);
    let a = digest(source);
    let mut b = digest(&back);
    // A file always holds a view; a document without one takes the
    // writer's default, which is not a difference.
    if a.camera.is_none() {
        b.camera = None;
    }
    if a != b && !near(&format!("{a:?}"), &format!("{b:?}")) {
        let mut msg = format!("{label} ({target:?}) differs after the round trip:\n");
        macro_rules! cmp {
            ($f:ident) => {
                if a.$f != b.$f {
                    msg += &format!(
                        "  {}:\n    source: {:#?}\n    back:   {:#?}\n",
                        stringify!($f),
                        a.$f,
                        b.$f
                    );
                }
            };
        }
        cmp!(roots);
        cmp!(tags);
        cmp!(guides);
        cmp!(section);
        cmp!(camera);
        cmp!(scenes);
        cmp!(sketches);
        cmp!(attrs);
        cmp!(annotations);
        return Err(msg);
    }
    Ok(())
}

#[test]
fn every_fixture_survives_hew_to_skp_to_hew() {
    let mut failures = Vec::new();
    let mut n = 0;
    for (label, bytes) in fixtures() {
        // Fixtures the importer refuses (pre-2017 versions) are not sources.
        let Ok(out) = skp_import::import(&bytes) else {
            continue;
        };
        let mut source = Document::new();
        source
            .ingest(out.scene, out.textures_missing)
            .expect("ingests");
        for target in [Target::Skp2026, Target::Skp2017] {
            n += 1;
            if let Err(e) = round_trip(&label, &source, target) {
                failures.push(e);
            }
        }
    }
    let native = Document::load(
        &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native.hew"))
            .unwrap(),
    )
    .unwrap();
    for target in [Target::Skp2026, Target::Skp2017] {
        n += 1;
        if let Err(e) = round_trip("native.hew", &native, target) {
            failures.push(e);
        }
    }
    assert!(n >= 80, "too few round trips ran: {n}");
    if !failures.is_empty() {
        if let Ok(dir) = std::env::var("SKP_EXPORT_DIFF_DIR") {
            for (i, f) in failures.iter().enumerate() {
                std::fs::write(format!("{dir}/diff-{i}.txt"), f).unwrap();
            }
        }
        let shown: String = failures
            .iter()
            .take(6)
            .map(|f| {
                let mut s = f.clone();
                s.truncate(6000);
                s
            })
            .collect::<Vec<_>>()
            .join("\n");
        panic!("{} of {n} round trips differ:\n{shown}", failures.len());
    }
}

#[test]
fn an_empty_document_writes_to_both_containers() {
    let doc = Document::new();
    for target in [Target::Skp2026, Target::Skp2017] {
        round_trip("empty", &doc, target).unwrap();
    }
}

#[test]
fn a_face_is_written_with_its_back_paint() {
    // back-material.skp: one face painted differently on each side; it is
    // written back with both paints. A face without back paint on an open
    // shell is written painted on both sides (Hew draws its material on
    // both; SketchUp would draw an unpainted side in its back-face color),
    // and a closed solid's face, whose inside is never seen, on its front
    // only.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skp-import/tests/fixtures");
    let names = |m: &openskp::Model| -> Vec<(Option<String>, Option<String>)> {
        let name = |s: Option<u16>| {
            s.and_then(|s| m.material_of(s)).map(|x| match x {
                openskp::Material::Solid { name, .. }
                | openskp::Material::Textured { name, .. } => name.clone(),
            })
        };
        let mut v: Vec<_> = m
            .geometry
            .iter()
            .flat_map(|r| r.mesh.faces.iter())
            .filter(|f| f.front_material.is_some())
            .map(|f| (name(f.front_material), name(f.back_material)))
            .collect();
        v.sort();
        v
    };
    let bytes = std::fs::read(root.join("back-material.skp")).unwrap();
    let source = openskp::Model::parse(&bytes).unwrap();
    let painted: Vec<_> = names(&source)
        .into_iter()
        .filter(|(f, b)| b.is_some() && b != f)
        .collect();
    assert_eq!(painted.len(), 1, "{:?}", names(&source));
    let doc = import(&bytes);
    for target in [Target::Skp2026, Target::Skp2017] {
        let written = export(&doc, target, WriteEnv::system()).unwrap();
        let back = names(&openskp::Model::parse(&written.bytes).unwrap());
        assert!(back.contains(&painted[0]), "{target:?}: {back:?}");
    }
    let doc = import(&std::fs::read(root.join("box-two-materials.skp")).unwrap());
    for target in [Target::Skp2026, Target::Skp2017] {
        let written = export(&doc, target, WriteEnv::system()).unwrap();
        let m = openskp::Model::parse(&written.bytes).unwrap();
        let faces: Vec<_> = m
            .geometry
            .iter()
            .flat_map(|r| r.mesh.faces.iter())
            .collect();
        assert!(faces.iter().any(|f| f.front_material.is_some()));
        for f in faces.iter().filter(|f| f.front_material.is_some()) {
            assert_eq!(f.back_material, None, "{target:?}");
        }
    }
}

#[test]
fn a_stretched_components_circles_survive() {
    // A component of two solids with circles (native.hew's drilled block,
    // and its group holding a cylinder) placed with a non-uniform scale.
    // The definition's members are written as groups inside it and read
    // back in the definition's own frame, so their circle claims stay:
    // the stretch is the placement's, not theirs.
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native.hew");
    let mut doc = Document::load(&std::fs::read(p).unwrap()).unwrap();
    let tops = doc.top_level_nodes();
    let block = tops
        .iter()
        .copied()
        .find(|n| matches!(n, kernel::NodeId::Object(_)))
        .unwrap();
    let group = tops
        .iter()
        .copied()
        .find(|n| matches!(n, kernel::NodeId::Group(_)))
        .unwrap();
    let (_, instance, _) = doc.make_component(&[block, group]).unwrap();
    let stretch = kernel::Transform::from_affine(&[
        1.2, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 0.7, 0.0,
    ]);
    doc.transform_instance(instance, &stretch).unwrap();
    for target in [Target::Skp2026, Target::Skp2017] {
        round_trip("stretched component", &doc, target).unwrap();
    }
}

#[test]
fn a_production_models_whole_export_reads_back_as_written() {
    // theater: SketchUp meshes that are not manifold open split into
    // pieces, some closed. Written whole and read back, each piece is the
    // faces Hew wrote, turned as Hew had them. (The file sits beside the
    // OpenSKP dev clone; skipped elsewhere.)
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../openskp/corpus/third-party/theater-2017.skp");
    let Ok(bytes) = std::fs::read(&p) else {
        eprintln!("skipped: no ../openskp checkout");
        return;
    };
    let doc = import(&bytes);
    for target in [Target::Skp2026, Target::Skp2017] {
        round_trip("theater", &doc, target).unwrap();
    }
}
