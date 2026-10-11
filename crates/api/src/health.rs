//! Model health as JSON (`kernel::health`; the import-health design §7):
//! one serializer for the app's Model Health panel (wasm handles), the
//! `hew.doc.health` command (public ids), and every import report's counts,
//! so they can never disagree about what an object is.

use std::collections::BTreeMap;

use kernel::health::{Finding, HealthCounts, RimRole, Verdict};
use kernel::{Document, EntityRef, InstanceId, ObjectId};
use serde_json::{Value, json};

/// A verdict's wire name.
pub fn verdict_kind(v: Verdict) -> &'static str {
    match v {
        Verdict::Solid => "solid",
        Verdict::FlatSheet { .. } => "flat_sheet",
        Verdict::BentSheet => "bent_sheet",
        Verdict::Cappable => "cappable",
        Verdict::Holes { .. } => "holes",
        Verdict::Mixed => "mixed",
        Verdict::NonManifold => "non_manifold",
    }
}

/// How much a verdict asks of a person, for summarizing several objects
/// (an instance's members) as the most serious one: solid, then the two
/// surfaces, then the open kinds by how hard they are to close.
pub fn verdict_rank(v: Verdict) -> u8 {
    match v {
        Verdict::Solid => 0,
        Verdict::FlatSheet { .. } => 1,
        Verdict::BentSheet => 2,
        Verdict::Cappable => 3,
        Verdict::Holes { .. } => 4,
        Verdict::Mixed => 5,
        Verdict::NonManifold => 6,
    }
}

/// A verdict's wire name and its numbers.
pub fn verdict_json(v: Verdict) -> Value {
    match v {
        Verdict::FlatSheet { holes } => json!({ "kind": "flat_sheet", "holes": holes }),
        Verdict::Holes { planar, warped } => {
            json!({ "kind": "holes", "planar": planar, "warped": warped })
        }
        other => json!({ "kind": verdict_kind(other) }),
    }
}

/// An import's objects by kind ([`HealthCounts`]) as every host's import
/// report carries them: solids, the two kinds of surface, the open kinds
/// that need attention, and the importer's seam families.
pub fn counts_json(c: &HealthCounts) -> Value {
    json!({
        "objects": c.objects,
        "solids": c.solids,
        "flat_sheets": c.flat_sheets,
        "bent_sheets": c.bent_sheets,
        "cappable": c.cappable,
        "holes": c.holes,
        "mixed": c.mixed,
        "non_manifold": c.non_manifold,
        "seam_families": c.seam_families,
    })
}

/// The open objects of `scope` (every live object when `None`) with their
/// verdicts, rims and seam families. `id` names an object, instance or
/// component on the wire — the app passes FFI handles, the API public ids.
/// A definition member is one row however often it is placed; its
/// `instances` are the outermost instances that put it in the model.
pub fn report_json(
    doc: &Document,
    scope: Option<&[ObjectId]>,
    id: &dyn Fn(EntityRef) -> String,
) -> Value {
    let report = doc.health_report(scope);
    let mut placed: BTreeMap<ObjectId, Vec<InstanceId>> = BTreeMap::new();
    for (o, _, iid) in doc.expanded_placements() {
        placed.entry(o).or_default().push(iid);
    }
    let rows: Vec<Value> = report
        .rows
        .iter()
        .map(|row| {
            let d = &row.diagnosis;
            let mut instances: Vec<InstanceId> = placed.get(&row.object).cloned().unwrap_or_default();
            instances.dedup();
            let branching = d
                .findings
                .iter()
                .filter(|f| matches!(f, Finding::BranchingBoundaryVertex { .. }))
                .count();
            let islands = d
                .findings
                .iter()
                .find_map(|f| match f {
                    Finding::DisconnectedIslands { count } => Some(*count),
                    _ => None,
                })
                .unwrap_or(1);
            json!({
                "object": id(EntityRef::Object(row.object)),
                "name": doc.object_name(row.object),
                "definition": row.definition.map(|c| id(EntityRef::Component(c))),
                "definition_name": row.definition.and_then(|c| doc.component_name(c)),
                "placements": row.placements,
                "instances": instances.into_iter().map(|i| id(EntityRef::Instance(i))).collect::<Vec<_>>(),
                "accepted": row.accepted_surface,
                "family": row.seam_family,
                "verdict": verdict_json(d.verdict),
                "rims": d.rims.iter().enumerate().map(|(i, r)| json!({
                    "role": match r.role { RimRole::Outer => "outer", RimRole::Hole => "hole" },
                    "planar": r.plane.is_some(),
                    "cappable": doc
                        .object(row.object)
                        .is_some_and(|o| kernel::repair::rim_is_cappable(o, d, i)),
                    "closed": r.closed,
                    "sheet_edge": r.sheet_edge,
                    "shared": row.shared_rims.contains(&i),
                    "perimeter": r.perimeter,
                    "extent": r.extent,
                    "edges": r.half_edges.len(),
                })).collect::<Vec<_>>(),
                "branching_vertices": branching,
                "islands": islands,
                "faces": doc.object(row.object).map_or(0, |o| o.faces().len()),
            })
        })
        .collect();
    let families: Vec<Value> = report
        .families
        .iter()
        .map(|f| {
            json!({
                "members": f.members.iter().map(|&o| id(EntityRef::Object(o))).collect::<Vec<_>>(),
                "shared_rims": f.shared_rims,
            })
        })
        .collect();
    json!({
        "rows": rows,
        "families": families,
        "counts": counts_json(&report.counts()),
    })
}
