//! Import recipe IR and `Document::ingest`.
//!
//! `dae-import` (and future importers) parse external formats and emit an
//! `ImportScene` — a *recipe* of positions + face-index lists + dense material
//! indices — then call `Document::ingest` to materialise it into the document.
//!
//! Keeping construction in the kernel means:
//! - `FaceMaterial = Option<MaterialId>` is resolved after palette insertion.
//! - `from_polygons_with_materials` rejection/watertight tallying is automatic.
//! - The `DocAction::Imported` undo step wraps the whole import atomically.
//!
//! The recipe types carry no `serde` derives — they are in-memory only and do
//! **not** touch the file format (DEVELOPMENT.md rule).

use crate::camera::CameraState;
use crate::ids::{ComponentId, GroupId, InstanceId, MaterialId, ObjectId};
use crate::material::{Material, UvFrame};
use crate::math::Point3;
use crate::scenes::SectionPlaneState;
use crate::transform::Transform;

// ── Recipe IR ────────────────────────────────────────────────────────────────

/// One mesh recipe: deduplicated/welded positions + CCW polygon index lists,
/// plus per-face and base material as DENSE indices into `ImportScene::materials`
/// (`NO_MATERIAL` sentinel = none — reuse `crate::serialize::NO_MATERIAL`).
pub struct MeshRecipe {
    /// Source node/geometry id, used in diagnostics and `ImportReport`.
    pub name: String,
    /// Unique vertex positions (already in Hew world space: meters, Z-up).
    pub positions: Vec<Point3>,
    /// CCW-wound polygon index lists (from outside), indices into `positions`.
    pub faces: Vec<Vec<usize>>,
    /// Per-face dense material index, parallel to `faces`.
    /// `crate::serialize::NO_MATERIAL` means no material assigned.
    pub face_materials: Vec<u32>,
    /// Per-face affine UV frame, parallel to `faces` ( extension). `None`
    /// entries mean no frame was fitted for that face ( `world_size` fallback
    /// in the tessellator). Set by `dae-import` when TEXCOORD inputs are present.
    pub face_uv_frames: Vec<Option<UvFrame>>,
    /// Per-face inner-loop index lists (holes), parallel to `faces`. For face `i`,
    /// `face_holes[i]` is a list of hole loops (each a `Vec<usize>` of position
    /// indices). An empty entry means face `i` has no holes, which is the common
    /// case and preserves byte-identical behaviour with the no-holes path. Set by
    /// `dae-import` when COLLADA `<ph>`/`<h>` elements are present.
    pub face_holes: Vec<Vec<Vec<usize>>>,
    /// Dense material index for the object's base material, or `NO_MATERIAL`.
    pub base_material: u32,
    /// Tag paths decoded from `__HEWMETA__` (or `__HEWTAG__`) in the source
    /// node name. Root-first segment lists, e.g. `[["Structure","Roof"]]`.
    /// Set by `dae-import` (WS2); default empty until that workstream lands.
    pub tags: Vec<Vec<String>>,
}

/// A shared definition recipe: a subtree in definition-local coords.
pub struct DefRecipe {
    /// Source name for the definition (e.g. a SketchUp component name), used as
    /// the display name for its instances. `None` falls back to a positional
    /// label in the UI.
    pub name: Option<String>,
    /// The definition's member subtree. Meshes and groups build
    /// definition-owned content; an [`ImportNode::Instance`] member nests
    /// another definition (its `def` index must not reach this definition
    /// back through the recipe graph — `ingest` refuses cyclic scenes with a
    /// typed error, never repairs them).
    pub children: Vec<ImportNode>,
}

impl DefRecipe {
    /// A flat, meshes-only definition — the shape every pre-nesting importer
    /// emits.
    pub fn from_meshes(name: Option<String>, meshes: Vec<MeshRecipe>) -> Self {
        DefRecipe {
            name,
            children: meshes.into_iter().map(ImportNode::Mesh).collect(),
        }
    }

    /// Every mesh recipe in this definition's own subtree, depth-first —
    /// groups descended, nested `Instance` members NOT followed (their
    /// meshes belong to the referenced definition). Diagnostics and tests
    /// inspect definitions through this.
    pub fn mesh_recipes(&self) -> impl Iterator<Item = &MeshRecipe> {
        fn walk<'a>(nodes: &'a [ImportNode], out: &mut Vec<&'a MeshRecipe>) {
            for n in nodes {
                match n {
                    ImportNode::Mesh(m) => out.push(m),
                    ImportNode::Group { children, .. } => walk(children, out),
                    ImportNode::Instance { .. } => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.children, &mut out);
        out.into_iter()
    }
}

/// A node in the imported scene tree.
pub enum ImportNode {
    /// A mesh that becomes a world-space `Object`.
    Mesh(MeshRecipe),
    /// A non-destructive container (becomes a `Group`).
    Group {
        /// Display name for the group.
        name: String,
        /// Child nodes of this group.
        children: Vec<ImportNode>,
        /// Tag paths for this group node (from `__HEWMETA__` decode, WS2).
        tags: Vec<Vec<String>>,
        /// USER-hidden in the source (a `.skp` hidden group): imported,
        /// registered hidden-by-default (manifest v6), never dropped.
        hidden: bool,
        /// The importer's own identity for this node (a `.skp` archive
        /// slot), so an [`ImportSceneRecipe`]'s hidden-node list can name
        /// it before the node exists. `None` when no scene refers to it.
        key: Option<u64>,
    },
    /// An instance of a shared definition (index into `ImportScene::defs`).
    Instance {
        /// Dense index into `ImportScene::defs`.
        def: usize,
        /// Pose (definition-local → world) for this placement.
        pose: Transform,
        /// The placement's OWN display name (`.skp` carries instance
        /// names natively — "Front Wall" on one placement of "Wall"). `None`
        /// falls back to the definition's name, as before.
        name: Option<String>,
        /// Tag paths for this instance node (from `__HEWMETA__` decode, WS2).
        tags: Vec<Vec<String>>,
        /// USER-hidden in the source (a `.skp` hidden component instance).
        hidden: bool,
        /// The importer's own identity for this node (see
        /// [`ImportNode::Group::key`]).
        key: Option<u64>,
    },
}

/// A saved view (a `.skp` scene) carried by an import: created by `ingest`
/// after the geometry, so its hidden sets can name the nodes and tags the
/// same import creates. Each `Option` is a captured property (`None` = the
/// scene does not capture it); a captured hidden set is a FULL set, as
/// `Scene` stores it.
pub struct ImportSceneRecipe {
    /// Display name; made unique against the document's existing scenes.
    pub name: String,
    pub description: String,
    pub camera: Option<CameraState>,
    /// Keys (see [`ImportNode::Group::key`]) of the nodes hidden in this
    /// scene. Keys that no imported node carries (source entities Hew has
    /// no node for, such as individual faces) are ignored.
    pub hidden_keys: Option<Vec<u64>>,
    /// Tag paths hidden in this scene (`.skp` layers), each declared in
    /// [`ImportScene::tags`].
    pub hidden_tags: Option<Vec<Vec<String>>>,
    /// The section plane active in this scene (world frame), when the
    /// scene captures one; `Some(None)` captures "no section cut".
    pub section: Option<Option<SectionPlaneState>>,
}

/// A construction guide carried by an import (`.skp` guides).
/// Ingested inside the same `DocAction::Imported` step as the geometry, so
/// one undo removes the whole import, guides included.
pub enum ImportGuide {
    /// An infinite construction line: a point on it + a direction.
    Line {
        /// A point the line passes through (meters, world space).
        origin: Point3,
        /// Line direction; normalized by `ingest` (degenerate → skipped, reported).
        direction: crate::math::Vec3,
    },
    /// A construction point.
    Point {
        /// Position (meters, world space).
        position: Point3,
    },
}

/// A tag the source document DECLARES (a `.skp` layer), independent of
/// whether any imported node carries it. Registered in the document's tag
/// metadata by `ingest` so the full source layer list survives import —
/// including empty layers — with its visibility. Content tagged with a
/// `hidden` tag imports normally and is hidden by default in the UI.
pub struct ImportTag {
    /// Root-first tag path (a `.skp` layer maps to a single segment).
    pub path: Vec<String>,
    /// Hidden in the source document → hidden by default in Hew.
    pub hidden: bool,
}

/// The complete import recipe: produced by `dae-import`, consumed by
/// `Document::ingest`.
pub struct ImportScene {
    /// Materials to add to the palette; face dense indices refer here.
    pub materials: Vec<Material>,
    /// Component definitions (shared geometry library entries).
    pub defs: Vec<DefRecipe>,
    /// Top-level world tree nodes to splice in.
    pub roots: Vec<ImportNode>,
    /// Construction guides to add. Undone with the import.
    pub guides: Vec<ImportGuide>,
    /// The source document's declared tag list (`.skp` layers) with their
    /// visibility. Registered by `ingest`; unregistered on undo.
    pub tags: Vec<ImportTag>,
    /// The source document's saved view. Adopted as the working camera
    /// only when the import lands in an EMPTY document (a fresh open of a
    /// `.skp`); an import into existing work keeps the user's view.
    pub camera: Option<CameraState>,
    /// The source document's saved views (`.skp` scenes), created after
    /// the geometry in source order. Like palette materials, scenes are
    /// not removed by undoing the import.
    pub scenes: Vec<ImportSceneRecipe>,
    /// The section cut active in the source's saved view, adopted under
    /// the same empty-document rule as [`ImportScene::camera`].
    pub section: Option<SectionPlaneState>,
}

// ── Report ───────────────────────────────────────────────────────────────────

/// A mesh that `from_polygons_with_materials` rejected.
pub struct SkippedMesh {
    /// Mesh name (from the recipe).
    pub name: String,
    /// `TopologyError::to_string()` explaining the rejection.
    pub reason: String,
}

/// Summary returned by `Document::ingest`.
pub struct ImportReport {
    /// Total `Object`s created (world objects + definition members).
    pub objects_created: usize,
    /// How many of the created objects are watertight.
    pub watertight: usize,
    /// How many of the created objects have open (non-watertight) shells.
    pub leaky: usize,
    /// Meshes that `from_polygons_with_materials` rejected — reported but not
    /// repaired (DEVELOPMENT.md rule 4).
    pub skipped: Vec<SkippedMesh>,
    /// Image URIs that the importer could not resolve from the `ImageMap`
    /// (populated by `dae-import`, passed through `ingest` unchanged).
    pub textures_missing: Vec<String>,
}

// ── DocAction::Imported + ingest ──────────────────────────────────────────────
// (These are defined on Document in document.rs; the types live here so callers
//  can depend on them without pulling in all of document.rs.)

/// The stable handles created by one `Document::ingest` call, stored in
/// `DocAction::Imported` for undo/redo.
pub struct ImportedHandles {
    /// Top-level created node ids (for ordering/cleanup).
    pub roots: Vec<crate::document::NodeId>,
    /// ALL created `ObjectId`s — world objects and definition members.
    pub objects: Vec<ObjectId>,
    /// Created `ComponentId`s (shared definitions).
    pub components: Vec<ComponentId>,
    /// Created `InstanceId`s.
    pub instances: Vec<InstanceId>,
    /// Created `GroupId`s.
    pub groups: Vec<GroupId>,
    /// Material ids added to the palette (used to undo material palette entries
    /// if we ever need it; currently kept for completeness).
    pub materials: Vec<MaterialId>,
}
