//! Structure-and-session fuzz harness (DEVELOPMENT.md rule 3): random
//! sequences of the tree-shaping ops — make component, group, ungroup,
//! reparent, explode, place, make unique, duplicate, delete, delete
//! definition — interleaved with component and group EDITING SESSIONS
//! (opened, stacked, closed innermost-first) and undo/redo, over a document
//! of plain boxes.
//!
//! `document_fuzz.rs` covers geometry-heavy ops but never opens an editing
//! session, so a session that closed into an inconsistent tree went
//! unnoticed there. This harness exists for that gap; every defect it found
//! (a group close re-homing a node a component had taken, an emptied
//! definition tombstoned under a live nested placement, a placement gate
//! that ignored a group frame) saved a file the loader then refused.
//!
//! Invariants, after every op (applied or refused typed):
//! - the always-on validator (torture mode) and the debug tree assertions
//!   do not fire;
//! - `load(save_for_persistence())` succeeds — the autosave path, which
//!   serializes as if every open session were closed;
//! - with no session open, `load(save())` succeeds too.
//!
//! Failures shrink to a short op list. Run deeper than the default 256
//! cases with `PROPTEST_CASES=20000 cargo test -p kernel --test
//! session_fuzz`.

use kernel::{Document, NodeId, ObjectId, Plane, Point3, Transform, Vec3};
use proptest::prelude::*;

/// Abstract op; selectors resolve against live ids at apply time, so a
/// shrunk sequence stays meaningful.
#[derive(Debug, Clone)]
enum Op {
    MakeComponent { sel: usize },
    MakeComponentPair { a: usize, b: usize },
    Group { a: usize, b: usize },
    Ungroup { sel: usize },
    Reparent { sel: usize, parent: usize },
    Explode { sel: usize },
    Place { comp: usize },
    MakeUnique { sel: usize },
    Duplicate { sel: usize },
    Delete { sel: usize },
    DeleteSelection { sel: usize },
    DeleteDefinition { comp: usize },
    OpenComponentSession { sel: usize },
    OpenGroupSession { sel: usize },
    CloseSession,
    Undo,
    Redo,
}

fn arb_op() -> impl Strategy<Value = Op> {
    let sel = || any::<usize>();
    prop_oneof![
        3 => sel().prop_map(|sel| Op::MakeComponent { sel }),
        1 => (sel(), sel()).prop_map(|(a, b)| Op::MakeComponentPair { a, b }),
        2 => (sel(), sel()).prop_map(|(a, b)| Op::Group { a, b }),
        2 => sel().prop_map(|sel| Op::Ungroup { sel }),
        2 => (sel(), sel()).prop_map(|(sel, parent)| Op::Reparent { sel, parent }),
        1 => sel().prop_map(|sel| Op::Explode { sel }),
        2 => sel().prop_map(|comp| Op::Place { comp }),
        1 => sel().prop_map(|sel| Op::MakeUnique { sel }),
        1 => sel().prop_map(|sel| Op::Duplicate { sel }),
        2 => sel().prop_map(|sel| Op::Delete { sel }),
        1 => sel().prop_map(|sel| Op::DeleteSelection { sel }),
        1 => sel().prop_map(|comp| Op::DeleteDefinition { comp }),
        3 => sel().prop_map(|sel| Op::OpenComponentSession { sel }),
        3 => sel().prop_map(|sel| Op::OpenGroupSession { sel }),
        3 => Just(Op::CloseSession),
        2 => Just(Op::Undo),
        2 => Just(Op::Redo),
    ]
}

fn add_box(doc: &mut Document, x: f64) -> ObjectId {
    let plane = Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined");
    let s = doc.add_sketch(plane);
    let corners = [(x, 0.0), (x + 1.0, 0.0), (x + 1.0, 1.0), (x, 1.0)];
    let sk = doc.sketch_mut(s).expect("sketch is live");
    for i in 0..4 {
        let (a, b) = (corners[i], corners[(i + 1) % 4]);
        sk.add_segment(Point3::new(a.0, a.1, 0.0), Point3::new(b.0, b.1, 0.0))
            .expect("segment");
    }
    let regions = doc.extrudable_regions(s).expect("sketch is live");
    doc.extrude_region(s, regions[0], 1.0).expect("extrude").0
}

/// Every live node, in a stable order, for selectors to index into.
fn live_nodes(doc: &Document) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = doc
        .live_object_ids()
        .into_iter()
        .map(NodeId::Object)
        .collect();
    v.extend(doc.group_ids().into_iter().map(NodeId::Group));
    v.extend(doc.instance_ids().into_iter().map(NodeId::Instance));
    v
}

fn pick<T: Copy>(items: &[T], sel: usize) -> Option<T> {
    (!items.is_empty()).then(|| items[sel % items.len()])
}

/// Applies one op. A typed refusal is a legal answer and is ignored; what
/// must never happen is a panic or a document that no longer reopens, both
/// checked by the caller.
fn apply(doc: &mut Document, op: &Op) {
    let nodes = live_nodes(doc);
    let instances = doc.instance_ids();
    let groups = doc.group_ids();
    let comps = doc.component_ids();
    match *op {
        Op::MakeComponent { sel } => {
            if let Some(n) = pick(&nodes, sel) {
                let _ = doc.make_component(&[n]);
            }
        }
        Op::MakeComponentPair { a, b } => {
            if let (Some(a), Some(b)) = (pick(&nodes, a), pick(&nodes, b)) {
                let _ = doc.make_component(&[a, b]);
            }
        }
        Op::Group { a, b } => {
            if let (Some(a), Some(b)) = (pick(&nodes, a), pick(&nodes, b)) {
                let _ = doc.group_nodes(&[a, b]);
            }
        }
        Op::Ungroup { sel } => {
            if let Some(g) = pick(&groups, sel) {
                let _ = doc.ungroup(g);
            }
        }
        Op::Reparent { sel, parent } => {
            if let Some(n) = pick(&nodes, sel) {
                // One extra slot past the groups means "to the top level".
                let at = parent % (groups.len() + 1);
                let target = groups.get(at).copied();
                let _ = doc.reparent_nodes(&[n], target);
            }
        }
        Op::Explode { sel } => {
            if let Some(i) = pick(&instances, sel) {
                let _ = doc.explode_instance(i);
            }
        }
        Op::Place { comp } => {
            if let Some(c) = pick(&comps, comp) {
                let _ = doc.place_instance(c, Transform::translation(Vec3::new(1.0, 2.0, 0.0)));
            }
        }
        Op::MakeUnique { sel } => {
            if let Some(i) = pick(&instances, sel) {
                let _ = doc.make_unique(i);
            }
        }
        Op::Duplicate { sel } => {
            if let Some(n) = pick(&nodes, sel) {
                let _ = doc.duplicate_node(n, &Transform::translation(Vec3::new(0.5, 0.5, 0.0)));
            }
        }
        Op::Delete { sel } => {
            if let Some(n) = pick(&nodes, sel) {
                let _ = doc.delete_node(n);
            }
        }
        Op::DeleteSelection { sel } => {
            if let Some(n) = pick(&nodes, sel) {
                let _ = doc.delete_selection(&[n]);
            }
        }
        Op::DeleteDefinition { comp } => {
            if let Some(c) = pick(&comps, comp) {
                let _ = doc.delete_definition(c);
            }
        }
        Op::OpenComponentSession { sel } => {
            if let Some(i) = pick(&instances, sel) {
                let _ = doc.open_explode_session(i);
            }
        }
        Op::OpenGroupSession { sel } => {
            if let Some(g) = pick(&groups, sel) {
                let _ = doc.open_group_session(g);
            }
        }
        Op::CloseSession => {
            let _ = doc.close_innermost_session();
        }
        Op::Undo => {
            let _ = doc.undo();
        }
        Op::Redo => {
            let _ = doc.redo();
        }
    }
}

fn check_reopens(doc: &Document, step: usize, op: &Op) -> Result<(), TestCaseError> {
    if let Err(e) = Document::load(&doc.save_for_persistence()) {
        return Err(TestCaseError::fail(format!(
            "step {step} ({op:?}): the autosave bytes do not reopen: {e}"
        )));
    }
    let closed = doc
        .session_stack()
        .is_empty()
        .then(|| Document::load(&doc.save()));
    if let Some(Err(e)) = closed {
        return Err(TestCaseError::fail(format!(
            "step {step} ({op:?}): the saved bytes do not reopen: {e}"
        )));
    }
    Ok(())
}

fn run_case(boxes: usize, ops: Vec<Op>) -> Result<(), TestCaseError> {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    for i in 0..boxes {
        add_box(&mut doc, 3.0 * i as f64);
    }
    for (step, op) in ops.iter().enumerate() {
        apply(&mut doc, op);
        check_reopens(&doc, step, op)?;
    }
    // Close whatever is still open: the close itself is an op that can
    // corrupt the tree, and the result must reopen too.
    while !doc.session_stack().is_empty() {
        let before = doc.session_stack().len();
        let _ = doc.close_innermost_session();
        if doc.session_stack().len() >= before {
            break;
        }
        check_reopens(&doc, ops.len(), &Op::CloseSession)?;
    }
    Ok(())
}

proptest! {
    /// Random tree-shaping and session sequences never leave a document the
    /// loader refuses, and never trip the validator.
    #[test]
    fn structure_and_session_sequences_stay_reopenable(
        boxes in 3usize..6,
        ops in proptest::collection::vec(arb_op(), 1..40),
    ) {
        run_case(boxes, ops)?;
    }
}
