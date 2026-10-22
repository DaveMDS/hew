//! Executable specs for KB-22: `save()` panicked after undo/redo around a
//! deleted component definition.
//!
//! A sketch drawn into a definition through one of its instances
//! ([`Document::begin_sketch_on_plane_in_instance`]) is not undoable on its
//! own, so creating it neither records an undo step nor clears the redo
//! stack. When it is drawn while a `delete_definition` sits undone on the
//! redo stack, the redo hides the definition again, and the new sketch must
//! go dark with it: a sketch owned by a deleted definition is dead, exactly
//! like that definition's member objects. Undoing the delete brings it back.
//!
//! The contract under test, after every op, undo, and redo:
//! - `save()` returns, and `load(save())` reproduces the state hash;
//! - every enumerable sketch (world sketches plus each live definition's
//!   own) names an owner that is itself enumerable;
//! - nothing a definition owned outlives it, and nothing comes back early.
//!
//! The two neighboring paths the fuzzer exercised in the same replay are
//! pinned too: `delete_definition` followed by `place_instance` of another
//! definition, and `make_component` undone after an `apply_def_op`.

use kernel::{
    ComponentId, Document, InstanceId, KernelOp, NodeId, ObjectId, Plane, Point3, SketchId,
    Transform, Vec3,
};

// ----------------------------------------------------------------- helpers

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane")
}

/// The vertical x = 0 plane — the plane the fuzzer's in-instance Follow Me
/// profile is drawn on.
fn side_plane() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
        Point3::new(0.0, 0.0, 1.0),
    ])
    .expect("side plane")
}

/// A unit-footprint box at `(x, y)`, extruded `h` in world space.
fn add_box(doc: &mut Document, x: f64, y: f64, h: f64) -> ObjectId {
    let s = doc.add_sketch(ground());
    let c = [
        Point3::new(x, y, 0.0),
        Point3::new(x + 1.0, y, 0.0),
        Point3::new(x + 1.0, y + 1.0, 0.0),
        Point3::new(x, y + 1.0, 0.0),
    ];
    let sk = doc.sketch_mut(s).expect("sketch is live");
    for i in 0..4 {
        sk.add_segment(c[i], c[(i + 1) % 4]).expect("segment");
    }
    let region = doc.extrudable_regions(s).expect("sketch is live")[0];
    doc.extrude_region(s, region, h).expect("extrude").0
}

/// A box folded into a fresh component definition.
fn boxed_component(doc: &mut Document, x: f64) -> (ComponentId, InstanceId, ObjectId) {
    let obj = add_box(doc, x, 0.0, 1.0);
    let (cid, iid, _) = doc
        .make_component(&[NodeId::Object(obj)])
        .expect("make component");
    (cid, iid, obj)
}

/// Draws a small square straight into `s` (no gesture, so nothing is
/// recorded — the shape the fuzzer's Follow Me profile takes when the
/// sweep itself is refused).
fn draw_profile(doc: &mut Document, s: SketchId) {
    let c = [
        Point3::new(0.0, -0.3, -0.3),
        Point3::new(0.0, 0.3, -0.3),
        Point3::new(0.0, 0.3, 0.3),
        Point3::new(0.0, -0.3, 0.3),
    ];
    let sk = doc.sketch_mut(s).expect("sketch is live");
    for i in 0..4 {
        sk.add_segment(c[i], c[(i + 1) % 4]).expect("segment");
    }
}

/// A definition's LIVE sketches (`def_member_sketches` lists tombstoned ones
/// too, like `def_members` lists hidden members), or `None` for a deleted
/// definition.
fn live_def_sketches(doc: &Document, cid: ComponentId) -> Option<Vec<SketchId>> {
    doc.def_member_sketches(cid)
        .map(|v| v.into_iter().filter(|&s| doc.sketch(s).is_some()).collect())
}

/// Every sketch the document enumerates: world sketches plus each live
/// definition's own.
fn enumerable_sketches(doc: &Document) -> Vec<SketchId> {
    let mut out = doc.sketch_ids();
    for cid in doc.component_ids() {
        out.extend(live_def_sketches(doc, cid).expect("live component"));
    }
    out
}

/// The KB-22 invariant: save and reload succeed with the same state, and
/// every enumerable sketch's owner is enumerable too.
fn check(doc: &Document, what: &str) {
    let comps = doc.component_ids();
    for sid in enumerable_sketches(doc) {
        if let Some(owner) = doc.sketch_owner_component(sid) {
            assert!(
                comps.contains(&owner),
                "{what}: sketch {sid:?} is owned by {owner:?}, which is not enumerable"
            );
        }
    }
    for &cid in &comps {
        for sid in live_def_sketches(doc, cid).expect("live component") {
            assert_eq!(
                doc.sketch_owner_component(sid),
                Some(cid),
                "{what}: {cid:?} lists {sid:?} but does not own it"
            );
        }
    }
    let bytes = doc.save();
    let reloaded = Document::load(&bytes).unwrap_or_else(|e| panic!("{what}: reload: {e}"));
    assert_eq!(
        reloaded.state_hash(),
        doc.state_hash(),
        "{what}: state hash changed across save/load"
    );
    assert_eq!(
        enumerable_sketches(&reloaded).len(),
        enumerable_sketches(doc).len(),
        "{what}: the file holds a different number of sketches"
    );
}

/// Unwinds the whole log and replays it twice, checking after every step.
fn unwind_and_replay(doc: &mut Document) {
    for round in 0..2 {
        let mut n = 0;
        while doc.can_undo() {
            doc.undo().expect("undo");
            check(doc, &format!("round {round} undo {n}"));
            n += 1;
        }
        let mut n = 0;
        while doc.can_redo() {
            doc.redo().expect("redo");
            check(doc, &format!("round {round} redo {n}"));
            n += 1;
        }
    }
}

// ------------------------------------------------------------------ specs

/// The minimized KB-22 repro: delete a definition, undo, draw into it
/// through its restored instance without recording anything, then redo the
/// delete. The new sketch goes with the definition, and comes back with it.
#[test]
fn a_sketch_drawn_into_a_restored_definition_goes_and_returns_with_it() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, iid, _) = boxed_component(&mut doc, 0.0);
    doc.delete_definition(cid).expect("delete definition");
    check(&doc, "deleted");
    doc.undo().expect("undo delete");
    check(&doc, "restored");

    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(iid, side_plane())
        .expect("draw in the restored instance");
    draw_profile(&mut doc, sid);
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    assert!(doc.can_redo(), "an unrecorded sketch leaves redo alone");
    check(&doc, "drawn");

    doc.redo().expect("redo delete");
    assert!(!doc.component_ids().contains(&cid));
    assert!(!enumerable_sketches(&doc).contains(&sid));
    check(&doc, "deleted again");

    doc.undo().expect("undo delete again");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    check(&doc, "restored again");

    unwind_and_replay(&mut doc);
}

/// The same race through `make_component` itself: undo the fold, redo it,
/// and the definition comes back with exactly what it owned.
#[test]
fn an_unrecorded_def_sketch_follows_its_definition_through_make_component_undo() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, iid, _) = boxed_component(&mut doc, 0.0);
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(iid, side_plane())
        .expect("draw in the instance");
    draw_profile(&mut doc, sid);
    doc.delete_definition(cid).expect("delete definition");
    check(&doc, "deleted");
    doc.undo().expect("undo delete");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    doc.undo().expect("undo make component");
    assert!(!enumerable_sketches(&doc).contains(&sid));
    check(&doc, "dissolved");
    doc.redo().expect("redo make component");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    check(&doc, "refolded");
    doc.redo().expect("redo delete");
    assert!(!enumerable_sketches(&doc).contains(&sid));
    check(&doc, "deleted again");
    unwind_and_replay(&mut doc);
}

/// A recorded def sketch whose drawing gesture is undone stays gone when the
/// fold under it is undone and redone: redoing `make_component` must not
/// bring back a sketch whose own creation is still on the redo stack.
#[test]
fn redoing_make_component_does_not_revive_an_undone_def_sketch() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, iid, _) = boxed_component(&mut doc, 0.0);
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(iid, side_plane())
        .expect("draw in the instance");
    doc.begin_sketch_gesture(sid).expect("open gesture");
    draw_profile(&mut doc, sid);
    doc.end_sketch_gesture(sid).expect("close gesture");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    check(&doc, "drawn");

    doc.undo().expect("undo drawing");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![]));
    doc.undo().expect("undo make component");
    check(&doc, "dissolved");
    doc.redo().expect("redo make component");
    assert_eq!(
        live_def_sketches(&doc, cid),
        Some(vec![]),
        "the drawing's own creation is still undone"
    );
    check(&doc, "refolded");
    doc.redo().expect("redo drawing");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![sid]));
    check(&doc, "redrawn");
    unwind_and_replay(&mut doc);
}

/// The same, with the def sketch removed by `delete_sketch` rather than by
/// undoing its creation.
#[test]
fn redoing_make_component_does_not_revive_a_deleted_def_sketch() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, iid, _) = boxed_component(&mut doc, 0.0);
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(iid, side_plane())
        .expect("draw in the instance");
    doc.begin_sketch_gesture(sid).expect("open gesture");
    draw_profile(&mut doc, sid);
    doc.end_sketch_gesture(sid).expect("close gesture");
    doc.delete_sketch(sid).expect("delete the drawing");
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![]));
    check(&doc, "erased");
    unwind_and_replay(&mut doc);
    assert_eq!(live_def_sketches(&doc, cid), Some(vec![]));
}

/// The `make_unique` counterpart: a drawing made in the private copy and
/// then undone stays gone when the copy itself is undone and redone.
#[test]
fn redoing_make_unique_does_not_revive_an_undone_def_sketch() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, _, _) = boxed_component(&mut doc, 0.0);
    let pose = Transform::translation(Vec3::new(3.0, 0.0, 0.0));
    let (second, _) = doc.place_instance(cid, pose).expect("second instance");
    let (copy, _) = doc.make_unique(second).expect("make unique");
    // The world x = 3 plane: the copy's local x = 0, where the profile sits.
    let plane = Plane::from_polygon(&[
        Point3::new(3.0, 0.0, 0.0),
        Point3::new(3.0, 1.0, 0.0),
        Point3::new(3.0, 0.0, 1.0),
    ])
    .expect("plane");
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(second, plane)
        .expect("draw in the private copy");
    doc.begin_sketch_gesture(sid).expect("open gesture");
    draw_profile(&mut doc, sid);
    doc.end_sketch_gesture(sid).expect("close gesture");
    assert_eq!(live_def_sketches(&doc, copy), Some(vec![sid]));

    doc.undo().expect("undo drawing");
    assert_eq!(live_def_sketches(&doc, copy), Some(vec![]));
    doc.undo().expect("undo make unique");
    check(&doc, "copy dissolved");
    doc.redo().expect("redo make unique");
    assert_eq!(
        live_def_sketches(&doc, copy),
        Some(vec![]),
        "the drawing's own creation is still undone"
    );
    check(&doc, "copy restored");
    doc.redo().expect("redo drawing");
    assert_eq!(live_def_sketches(&doc, copy), Some(vec![sid]));
    unwind_and_replay(&mut doc);
}

/// Neighbor path 1: delete one definition, then place an instance of
/// another. Both survive every undo/redo, and the deleted one stays out of
/// the file while it is deleted.
#[test]
fn delete_definition_then_place_instance_of_another_round_trips() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (a, a_inst, _) = boxed_component(&mut doc, 0.0);
    let (b, _, _) = boxed_component(&mut doc, 3.0);
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(a_inst, side_plane())
        .expect("draw in A");
    draw_profile(&mut doc, sid);
    doc.delete_definition(a).expect("delete A");
    check(&doc, "A deleted");
    let pose = Transform::translation(Vec3::new(0.0, 4.0, 0.0));
    let (placed, _) = doc.place_instance(b, pose).expect("place B");
    assert_eq!(doc.instance_def(placed), Some(b));
    assert_eq!(doc.component_ids(), vec![b]);
    check(&doc, "B placed");
    // Placing a DELETED definition refuses typed, never resurrects it.
    assert!(doc.place_instance(a, pose).is_err());

    doc.undo().expect("undo place");
    doc.undo().expect("undo delete");
    assert_eq!(live_def_sketches(&doc, a), Some(vec![sid]));
    check(&doc, "A restored");
    doc.redo().expect("redo delete");
    doc.redo().expect("redo place");
    assert_eq!(doc.component_ids(), vec![b]);
    assert!(!enumerable_sketches(&doc).contains(&sid));
    check(&doc, "replayed");
    unwind_and_replay(&mut doc);
}

/// Neighbor path 2: an edit inside a definition (`apply_def_op`) undone,
/// then the `make_component` under it undone and both redone. The member's
/// geometry returns exactly, and the file reopens at every step.
#[test]
fn make_component_undone_after_a_def_op_round_trips() {
    let mut doc = Document::new();
    doc.set_torture_mode(true);
    let (cid, _, obj) = boxed_component(&mut doc, 0.0);
    let print = |doc: &Document| {
        let o = doc.object(obj).expect("member is live");
        let mut zs: Vec<i64> = o
            .vertices()
            .values()
            .map(|v| (v.position.z * 1e7).round() as i64)
            .collect();
        zs.sort_unstable();
        zs
    };
    let before = print(&doc);
    let top = {
        let o = doc.object(obj).expect("member is live");
        o.faces()
            .iter()
            .find(|(_, f)| f.plane.normal().approx_eq(Vec3::new(0.0, 0.0, 1.0), 1e-9))
            .map(|(id, _)| id)
            .expect("box has a top face")
    };
    doc.apply_def_op(
        cid,
        obj,
        KernelOp::PushPull {
            face: top,
            distance: 0.5,
        },
    )
    .expect("push the member's top");
    let pushed = print(&doc);
    assert_ne!(pushed, before);
    check(&doc, "pushed");

    doc.undo().expect("undo def op");
    assert_eq!(print(&doc), before);
    doc.undo().expect("undo make component");
    assert!(doc.component_ids().is_empty());
    check(&doc, "dissolved");
    doc.redo().expect("redo make component");
    assert_eq!(print(&doc), before);
    check(&doc, "refolded");
    doc.redo().expect("redo def op");
    assert_eq!(print(&doc), pushed);
    check(&doc, "pushed again");
    unwind_and_replay(&mut doc);
    assert_eq!(print(&doc), pushed);
}
