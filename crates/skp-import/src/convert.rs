//! `openskp::Model` -> `kernel::ImportScene`.
//!
//! Mapping:
//! - a node's [`openskp::Node::is_group`] tells apart SketchUp's two
//!   placement classes, which Hew maps very differently:
//!   - `Some(false)` (a `CComponentInstance`) OR `None` (the legacy
//!     byte-scan path, which cannot tell them apart — treated as a
//!     component for backward compatibility): each **definition geometry
//!     run** becomes a [`DefRecipe`] (one variant per inherited material,
//!     since SketchUp's default-material faces render with the placing
//!     instance's paint — Hew expresses that as the def mesh's
//!     `base_material`), and the placement becomes an [`ImportNode::Instance`]
//!     — a definition's in-definition child placements are NESTED member
//!     instances of its `DefRecipe` (poses rebased to the definition's
//!     local frame), so a SketchUp assembly's sharing survives: N
//!     placements stay N instances of one definition;
//!   - `Some(true)` (a `CGroup`): SketchUp groups are independent
//!     containers, not shared definitions — Hew has no equivalent of "one
//!     group definition, many placements" (that IS what a component is).
//!     Each placement converts (and re-heals) independently: the node's own
//!     run meshes bake the node's pose into their positions (world pose at
//!     the world level; rebased into the enclosing definition's local frame
//!     when nested inside one, since a Hew `ImportNode::Mesh` carries no
//!     pose of its own) and children convert recursively (components become
//!     Instances, nested groups become Groups the same way), producing an
//!     [`ImportNode::Group`]. A group with exactly one resulting mesh and no
//!     children collapses to a bare [`ImportNode::Mesh`] instead — SketchUp
//!     needs wrapper groups to isolate geometry; Hew's solids-first model
//!     doesn't — unless the group itself is hidden (a bare mesh has nowhere
//!     to carry that).
//! - pure containers without geometry runs become [`ImportNode::Group`]s
//!   with **absolute world poses** exactly like `dae-import`;
//! - the **root run** (loose model geometry) becomes a world
//!   [`ImportNode::Mesh`];
//! - layers map to tags — the FULL layer list (empty and hidden layers
//!   included) is declared as [`ImportTag`]s so the document keeps it, with
//!   hidden layers becoming hidden-by-default tags;
//! - hidden-layer CONTENT imports (tagged with its hidden tag, hidden by
//!   default in the UI, never dropped — a layer is visibility state, not
//!   existence); hidden *instances* (per-entity hide) still drop, matching
//!   SketchUp's own exports, and faces always import — hidden faces are
//!   display state, and dropping them would open solids;
//! - guides map to [`ImportGuide`]s: a guide among the model's own
//!   entities as it is, a guide inside a definition once per placement of
//!   that definition, carried through the placement's world pose (that is
//!   where SketchUp draws it).
//!
//! Both containers OpenSKP reads (the 2026 ZIP container every current
//! SketchUp saves, and the 2017 `CArchive` stream) come out as the same
//! `Model`, so nothing here is container-specific. Everything OpenSKP hands
//! us is already metres; poses come from the composed row-major world
//! matrices, whose first 12 entries are exactly `Transform::from_affine`'s
//! layout.
//!
//! Importer keys: scene hidden sets and active section cuts name entities
//! by SketchUp **persistent id**, the one identity both containers carry.
//! The composed [`openskp::Node`] tree does not carry pids itself, but it is
//! built in the exact order of the reader's instance lists — top-level
//! nodes from `Model::instances` outside every geometry run, children from
//! the placing run's `GeometryRun::placed` — so the converter walks those
//! lists in step with the tree to recover each node's pid. A pid of 0 (the
//! 2017 legacy byte-scan path, which cannot resolve them) yields no key.

use std::collections::{BTreeMap, BTreeSet};

use kernel::{
    CameraProjection, CameraState, DefRecipe, ImportGuide, ImportNode, ImportScene,
    ImportSceneRecipe, ImportTag, MeshRecipe, Plane, Point3, SectionPlaneState, Transform, UvFrame,
    Vec3,
};
use mesh_heal::heal_mesh;
use mesh_heal::uv::fit_uv_frame;

use crate::material::MatTable;

pub(crate) struct Output {
    pub scene: ImportScene,
    pub textures_missing: Vec<String>,
    pub warnings: Vec<String>,
}

pub(crate) fn convert(model: &openskp::Model) -> Output {
    let mats = MatTable::build(model);

    // Declared archive-map indexes that belong to component/group definitions;
    // geometry runs carrying one of these are definition runs, everything else
    // is loose world geometry.
    let def_indexes: BTreeSet<usize> = model
        .definition_links
        .iter()
        .map(|&(dr, _)| dr as usize)
        .collect();

    // Every persistent id some scene hides: such a group must stay a Group
    // node (a bare Mesh carries no key for the scene's hidden set to name).
    let scene_hidden: BTreeSet<u32> = model
        .scenes
        .iter()
        .flat_map(|s| s.hidden_entities.iter().copied())
        .collect();

    let mut cv = Converter {
        model,
        mats,
        scene_hidden,
        def_variants: BTreeMap::new(),
        degraded_variants: BTreeMap::new(),
        defs: Vec::new(),
        warnings: Vec::new(),
    };

    let mut roots: Vec<ImportNode> = Vec::new();

    // ── Loose world geometry ───────────────────────────────────────────────
    for (ri, run) in model.geometry.iter().enumerate() {
        let is_def = matches!(run.def_index, Some(di) if def_indexes.contains(&di));
        if is_def {
            continue;
        }
        for recipe in cv.mesh_recipes(ri, "Model".to_string(), 0, &Transform::IDENTITY) {
            roots.push(ImportNode::Mesh(recipe));
        }
    }

    // ── The composed instance tree ─────────────────────────────────────────
    // `scene()` maps the top-level instances in filter order; zip against the
    // same filter to recover each root placement's own name (nested placements
    // have no names — they fall back to their def's name) and its persistent
    // id (the importer key; see the module docs).
    let top_level: Vec<(Option<String>, u32)> = model
        .instances
        .iter()
        .filter(|i| {
            !model
                .geometry
                .iter()
                .any(|r| r.start <= i.offset && i.offset < r.end)
        })
        .map(|i| (i.name.clone().filter(|n| !n.is_empty()), i.pid))
        .collect();
    let tree = model.scene();
    debug_assert_eq!(tree.len(), top_level.len());
    for (node, (own_name, pid)) in tree.iter().zip(top_level) {
        if let Some(n) = cv.convert_node(node, own_name, pid) {
            roots.push(n);
        }
    }

    // ── Guides ─────────────────────────────────────────────────────────────
    let guides = world_guides(model, &tree);

    // ── Parse anomalies -> user-visible warnings ───────────────────────────
    // Clean files parse with zero desync diagnostics on either container (an
    // OpenSKP regression guarantee); anything else means content may be
    // missing and is said out loud, never papered over (rule 4 spirit; fixes
    // go upstream). Converter-emitted warnings (non-manifold splits) come
    // first — they are per-object and actionable. Reader notes AGGREGATE
    // past a handful: a badly damaged file can desync tens of thousands of
    // times, and 32k warning strings help nobody (a damaged production model
    // produced 32k).
    const DESYNC_DETAIL_CAP: usize = 8;
    let mut warnings = std::mem::take(&mut cv.warnings);
    let desyncs: Vec<&openskp::Diagnostic> =
        model.diagnostics.iter().filter(|d| d.is_desync()).collect();
    warnings.extend(desyncs.iter().take(DESYNC_DETAIL_CAP).map(|d| match d {
        // A 2026 record the reader skipped: damaged, or a tag it does not
        // know (what a newer release's addition looks like).
        openskp::Diagnostic::Skipped { class, at, bytes } => format!(
            "reader skipped a record it could not decode ({class}, {bytes} \
             bytes at 0x{at:x}); content from it may be missing"
        ),
        other => format!("parser recovered from a malformed section: {other:?}"),
    }));
    if desyncs.len() > DESYNC_DETAIL_CAP {
        warnings.push(format!(
            "parser recovered from {} more malformed sections (content from \
             them may be missing)",
            desyncs.len() - DESYNC_DETAIL_CAP
        ));
    }

    // ── The declared tag list: every named non-default layer ──────────────
    // Hidden layers become hidden-by-default tags; empty layers survive too
    // (the document keeps the full source layer list).
    let tags: Vec<ImportTag> = model
        .layers
        .iter()
        .enumerate()
        // The list-first layer is the default (Layer0) — it maps to
        // "untagged", exactly as `layer_tags` treats slot 0.
        .filter(|(i, l)| *i > 0 && !l.name.is_empty())
        .map(|(_, l)| ImportTag {
            path: vec![l.name.clone()],
            hidden: !l.visible,
        })
        .collect();

    // ── Saved view + scenes ────────────────────────────────────────────────
    // The document camera and every page: name, camera, and the hidden
    // entity / hidden layer sets as node keys (persistent ids) and tag
    // paths. Ids that name faces or edges carry no node and drop out in
    // `ingest`; the default layer (list-first) has no tag to hide.
    let camera = model.camera.as_ref().map(camera_state);
    let tag_names: BTreeSet<&str> = tags.iter().map(|t| t.path[0].as_str()).collect();
    // Section planes live in their owning entity list's local frame; a
    // scene's active-section id resolves through the run holding it and
    // that run's FIRST placement's world pose (the model root for loose
    // planes). A plane inside a multiply placed definition is ambiguous in
    // SketchUp too; the first placement is the documented choice.
    let section_world = section_planes_world(model, &tree);
    let saves_section = |s: &openskp::Scene| -> bool {
        s.saved.has(openskp::SceneProperties::ACTIVE_SECTION_PLANES)
    };
    let scene_section = |s: &openskp::Scene| -> Option<SectionPlaneState> {
        s.active_section_planes
            .iter()
            .find_map(|pid| section_world.get(pid).copied())
    };
    let scenes: Vec<ImportSceneRecipe> = model
        .scenes
        .iter()
        .map(|s| ImportSceneRecipe {
            name: s.name.clone(),
            description: s.description.clone(),
            camera: s.camera.as_ref().map(camera_state),
            hidden_keys: Some(s.hidden_entities.iter().map(|&k| k as u64).collect()),
            hidden_tags: Some(
                s.hidden_layers
                    .iter()
                    .filter(|&&i| i != 0)
                    .filter_map(|&i| model.layers.get(i))
                    .filter(|l| tag_names.contains(l.name.as_str()))
                    .map(|l| vec![l.name.clone()])
                    .collect(),
            ),
            // A scene captures its cut only when it saved the section-planes
            // property; a scene that did not leaves the cut alone (`None`),
            // and one that did with nothing active captures "no cut".
            section: saves_section(s).then(|| scene_section(s)),
        })
        .collect();
    // The scene active at save time is the one whose camera the saved view
    // repeats exactly; its section cut is what SketchUp showed, so the
    // document adopts it (the hidden state already lives in the entities'
    // and layers' own flags) — provided the scene saved the section-planes
    // property at all; a scene that did not leaves the model's own cut in
    // force. With no such scene the model's own state decides: the root
    // entity list's active plane cuts (both containers record which plane
    // that is), and failing that — a file with planes but none active, or
    // the legacy byte-scan path, which resolves no ids — the first plane
    // placed at the root arrives placed but not cutting, ready to switch
    // on. Hew has one section plane, so planes inside definitions (which
    // cut only their own contents) are not adopted.
    let saved_scene = model.camera.as_ref().and_then(|saved| {
        model
            .scenes
            .iter()
            .find(|s| s.camera.as_ref().is_some_and(|c| c == saved))
    });
    let root_run = model.geometry.iter().find(|r| r.def_index.is_none());
    let section = match saved_scene {
        Some(s) if saves_section(s) => scene_section(s),
        _ => root_run.and_then(|root| {
            root.active_section
                .and_then(|pid| section_world.get(&pid).copied())
                .or_else(|| {
                    root.sections.iter().find_map(|sp| {
                        section_world.get(&sp.pid).map(|s| SectionPlaneState {
                            active: false,
                            ..*s
                        })
                    })
                })
        }),
    };

    let Converter { mats, defs, .. } = cv;
    Output {
        scene: ImportScene {
            materials: mats.materials,
            defs,
            roots,
            guides,
            tags,
            camera,
            scenes,
            section,
        },
        textures_missing: mats.textures_missing,
        warnings,
    }
}

struct Converter<'a> {
    model: &'a openskp::Model,
    mats: MatTable,
    /// Persistent ids named by any scene's hidden-entity list.
    scene_hidden: BTreeSet<u32>,
    /// (geometry-run index, inherited material slot) -> def index in `defs`
    /// (`None` = the run has no importable faces at that variant).
    def_variants: BTreeMap<(usize, u16), Option<usize>>,
    /// Variants whose nested children were DROPPED because the first
    /// placement's world matrix was singular (uninvertible — the def-local
    /// rebase is impossible from that placement). A later placement with an
    /// invertible matrix upgrades the cached recipe in place, so one
    /// zero-scaled placement can't permanently strip a shared definition.
    degraded_variants: BTreeMap<(usize, u16), usize>,
    defs: Vec<DefRecipe>,
    /// User-visible conversion warnings (non-manifold splits — rule 4:
    /// decomposition happens loudly, never silently).
    warnings: Vec<String>,
}

impl Converter<'_> {
    /// A node's children paired with their persistent ids: the composed
    /// tree lists a node's children in exactly the order of its run's
    /// `placed` list (see the module docs), and a node without a run has
    /// no children.
    fn children_with_pids<'n>(
        &self,
        node: &'n openskp::Node,
    ) -> impl Iterator<Item = (&'n openskp::Node, u32)> + use<'_, 'n> {
        let pids = node
            .run
            .map(|ri| self.model.geometry[ri].placed.as_slice())
            .unwrap_or(&[]);
        debug_assert!(node.children.is_empty() || node.children.len() == pids.len());
        node.children.iter().zip(pids.iter().map(|p| p.pid))
    }

    /// Every child of `node` converted (pruned children drop out).
    fn convert_children(&mut self, node: &openskp::Node) -> Vec<ImportNode> {
        let pairs: Vec<(&openskp::Node, u32)> = self.children_with_pids(node).collect();
        pairs
            .into_iter()
            .filter_map(|(c, pid)| self.convert_node(c, None, pid))
            .collect()
    }

    /// One composed scene node -> an import node, `None` when pruned
    /// (hidden instance, hidden layer, or nothing importable below).
    /// `pid` is the placing object's persistent id (0 = unknown).
    fn convert_node(
        &mut self,
        node: &openskp::Node,
        own_name: Option<String>,
        pid: u32,
    ) -> Option<ImportNode> {
        // NOTHING visibility-related is dropped: a hidden INSTANCE
        // (per-entity hide) imports as a user-hidden node (persisted view
        // state, manifest v6), and hidden-LAYER content imports carrying
        // its layer tag whose hidden-by-default flag keeps it invisible
        // until the user shows the tag. Hidden is visibility state, not
        // existence.
        let hidden = node.hidden;

        let pose = pose_of(&node.world);
        let tags = self.layer_tags(node.layer);

        match node.run {
            // A SketchUp GROUP placement (`is_group == Some(true)`): groups
            // are independent containers, not shared definitions — each
            // placement converts on its own (deep copy, no shared def).
            Some(ri) if matches!(node.is_group, Some(true)) => {
                self.group_node(ri, node, own_name, tags, hidden, pid)
            }
            // A placement of a definition — with or without in-definition
            // child placements. The whole subtree is ONE nested definition
            // (children become member instances with def-local poses), so
            // N placements of a SketchUp assembly stay N instances of one
            // shared definition — the nested-component parity fix.
            // `is_group == Some(false)` (component) or `None` (legacy
            // byte-scan path, which cannot tell components and groups
            // apart — kept on this path for backward compatibility).
            Some(ri) => {
                let def = self.assembly_variant(ri, node.material, node)?;
                Some(ImportNode::Instance {
                    def,
                    pose,
                    name: own_name,
                    tags,
                    hidden,
                    key: key_of(pid),
                })
            }
            // A pure container with no geometry run of its own: a world
            // group wrapping its converted children (world poses).
            None => {
                let children = self.convert_children(node);
                if children.is_empty() {
                    return None;
                }
                let name = own_name
                    .or_else(|| node.definition.clone())
                    .unwrap_or_default();
                Some(ImportNode::Group {
                    name,
                    children,
                    tags,
                    hidden,
                    key: key_of(pid),
                })
            }
        }
    }

    /// A SketchUp GROUP node with a geometry run: converts to a Hew `Group`
    /// (own meshes + recursively converted children) or, in the common
    /// "wrapper around one solid" case, a bare `Mesh` — never a shared
    /// `DefRecipe`, since SketchUp groups are logically unique (unlike
    /// components, a group is not "one definition, many placements").
    ///
    /// The node's own run bakes `pose_of(&node.world)` into its mesh
    /// positions (group geometry is def-local in the source; a Hew
    /// `ImportNode::Mesh` carries no pose). When this group turns up nested
    /// inside a component definition, `assembly_variant`'s `rebase_to_local`
    /// composes the definition's inverse pose on top afterward, landing the
    /// already-world-baked positions in def-local coordinates — the same
    /// two-step composition `rebase_to_local` already does for `Instance`
    /// poses.
    fn group_node(
        &mut self,
        run_idx: usize,
        node: &openskp::Node,
        own_name: Option<String>,
        tags: Vec<Vec<String>>,
        hidden: bool,
        pid: u32,
    ) -> Option<ImportNode> {
        let name = own_name
            .or_else(|| node.definition.clone())
            .unwrap_or_default();
        let bake = pose_of(&node.world);
        let mut own_meshes = self.mesh_recipes(run_idx, name.clone(), node.material, &bake);
        let children = self.convert_children(node);

        // The "simple solid" special case: SketchUp needs a wrapper group to
        // isolate geometry; Hew's solids-first model doesn't. Skipped when
        // the group itself is hidden — `MeshRecipe` carries no hidden flag
        // of its own, so collapsing would silently drop the group's
        // visibility state (rule 4 spirit: never lose it quietly) — and
        // when a scene hides it, since a bare mesh carries no key either.
        let scene_hidden = pid != 0 && self.scene_hidden.contains(&pid);
        if children.is_empty() && own_meshes.len() == 1 && !hidden && !scene_hidden {
            let mut mesh = own_meshes.pop().expect("len checked above");
            mesh.tags = tags;
            return Some(ImportNode::Mesh(mesh));
        }

        let mut all_children: Vec<ImportNode> =
            own_meshes.into_iter().map(ImportNode::Mesh).collect();
        all_children.extend(children);
        if all_children.is_empty() {
            return None;
        }
        Some(ImportNode::Group {
            name,
            children: all_children,
            tags,
            hidden,
            key: key_of(pid),
        })
    }

    /// Def index for `(run, inherited material)`, building the `DefRecipe`
    /// on first use — its own (possibly split non-manifold) meshes PLUS its
    /// in-definition child placements as nested member instances, rebased
    /// from the composed tree's absolute poses into the definition's local
    /// frame. Every placement of the definition shares the one recipe.
    ///
    /// A `None` placeholder is cached before recursing so a (malformed,
    /// impossible-in-SketchUp) self-referential subtree drops the cyclic
    /// child instead of recursing forever; `ingest` would refuse the cycle
    /// typed anyway.
    fn assembly_variant(
        &mut self,
        run_idx: usize,
        eff_slot: u16,
        node: &openskp::Node,
    ) -> Option<usize> {
        if let Some(&cached) = self.def_variants.get(&(run_idx, eff_slot)) {
            // A degraded recipe (children dropped — singular first
            // placement) upgrades from the first placement that CAN rebase.
            if let Some(&di) = self.degraded_variants.get(&(run_idx, eff_slot))
                && !node.children.is_empty()
                && let Ok(inv) = pose_of(&node.world).inverse()
            {
                let children: Vec<ImportNode> = self
                    .convert_children(node)
                    .into_iter()
                    .map(|mut n| {
                        rebase_to_local(&mut n, &inv);
                        n
                    })
                    .collect();
                if !children.is_empty() {
                    self.defs[di].children.extend(children);
                    self.degraded_variants.remove(&(run_idx, eff_slot));
                }
            }
            return cached;
        }
        self.def_variants.insert((run_idx, eff_slot), None);
        let name = self.def_name(run_idx);
        let meshes = self.mesh_recipes(
            run_idx,
            name.clone().unwrap_or_default(),
            eff_slot,
            &Transform::IDENTITY,
        );
        let mut children: Vec<ImportNode> = meshes.into_iter().map(ImportNode::Mesh).collect();
        let mut degraded = false;
        // Child placements rebase to the definition's local frame:
        // local = world_def⁻¹ ∘ world_child. A singular world pose cannot
        // be rebased — its children are dropped loudly, never guessed at.
        match pose_of(&node.world).inverse() {
            Ok(inv) => {
                for mut n in self.convert_children(node) {
                    rebase_to_local(&mut n, &inv);
                    children.push(n);
                }
            }
            Err(_) => {
                if !node.children.is_empty() {
                    degraded = true;
                    self.warnings.push(format!(
                        "'{}' has a singular placement matrix; its {} nested \
                         placement(s) were dropped (restored if another \
                         placement can express them)",
                        name.as_deref().unwrap_or("unnamed component"),
                        node.children.len(),
                    ));
                }
            }
        }
        let built = if children.is_empty() {
            None
        } else {
            self.defs.push(DefRecipe { name, children });
            Some(self.defs.len() - 1)
        };
        self.def_variants.insert((run_idx, eff_slot), built);
        if degraded && let Some(di) = built {
            self.degraded_variants.insert((run_idx, eff_slot), di);
        }
        built
    }

    /// The definition name behind a geometry run, when linked.
    fn def_name(&self, run_idx: usize) -> Option<String> {
        let di = self.model.geometry[run_idx].def_index?;
        self.model
            .definition_links
            .iter()
            .find(|&&(dr, _)| dr as usize == di)
            .map(|&(_, k)| self.model.definitions[k].name.clone())
            .filter(|n| !n.is_empty())
    }

    /// One geometry run's mesh -> a healed `MeshRecipe`. `None` when no face
    /// survives (empty run, or everything hidden).
    ///
    /// `eff_slot` is the placing instance's inherited material (0 = none): it
    /// becomes `base_material`, which default-material faces resolve to.
    ///
    /// `bake` is baked into the resulting positions (and, transitively, the
    /// fitted UV frames): `Transform::IDENTITY` for definition-owned and
    /// loose-world runs (already in the right coordinate space), or a
    /// SketchUp GROUP's own world pose (`group_node`) — matching how
    /// `dae-import` bakes world-mesh transforms.
    ///
    /// Usually one recipe. A NON-MANIFOLD run (which `from_polygons` would
    /// reject whole) is decomposed by [`mesh_heal::split::split_non_manifold`]
    /// into several open-shell recipes — loudly (a warning names the mesh
    /// and the piece count), never silently (rule 4).
    fn mesh_recipes(
        &mut self,
        run_idx: usize,
        name: String,
        eff_slot: u16,
        bake: &Transform,
    ) -> Vec<MeshRecipe> {
        let mesh = &self.model.geometry[run_idx].mesh;

        let positions: Vec<Point3> = mesh
            .vertices
            .iter()
            .map(|v| Point3::new(v[0], v[1], v[2]))
            .collect();

        let mut faces: Vec<Vec<usize>> = Vec::new();
        let mut face_mats: Vec<u32> = Vec::new();
        let mut corner_uvs: Vec<Vec<[f64; 2]>> = Vec::new();
        let mut holes: Vec<Vec<Vec<usize>>> = Vec::new();

        for f in &mesh.faces {
            // Faces always import — hidden faces and hidden-layer faces
            // included. Dropping them would open closed solids (a hidden face
            // on a box is display state, not geometry), and SketchUp's own
            // exports keep them (the  `.dae` ground truth: layers.dae
            // ships its hidden-layer box; hidden-entities.dae is watertight).
            // Visibility pruning applies at the INSTANCE level only, matching
            // theq export rule.
            // Front side wins; a back-only paint still beats no material.
            let own_slot = f.front_material.or(f.back_material).unwrap_or(0);
            let uv_side = if f.front_material.is_some() || f.back_material.is_none() {
                openskp::Side::Front
            } else {
                openskp::Side::Back
            };
            face_mats.push(if own_slot != 0 {
                self.mats.dense(own_slot)
            } else {
                kernel::NO_MATERIAL
            });

            // Corner UVs whenever the face's effective material is textured:
            // an explicit placement uses its CFaceTextureCoords, a painted
            // side without one uses SketchUp's identity placement — both via
            // `uv_xform`.
            let tex_slot = if own_slot != 0 { own_slot } else { eff_slot };
            let uvs: Vec<[f64; 2]> = if self.mats.is_textured(tex_slot) {
                let size = self.mats.applied_size_in(tex_slot).unwrap_or((1.0, 1.0));
                match f.uv_xform(uv_side, size) {
                    Some(x) => f
                        .outer
                        .iter()
                        .map(|&vi| x.apply(mesh.vertices[vi as usize]))
                        .collect(),
                    None => Vec::new(),
                }
            } else {
                Vec::new()
            };

            faces.push(f.outer.iter().map(|&vi| vi as usize).collect());
            holes.push(
                f.holes
                    .iter()
                    .map(|ring| ring.iter().map(|&vi| vi as usize).collect())
                    .collect(),
            );
            corner_uvs.push(uvs);
        }

        if faces.is_empty() {
            return Vec::new();
        }

        // Native tolerances: `.skp` coordinates are exact f64, like COLLADA
        // text (the glTF f32 relaxation does not apply).
        let (positions, faces, healed_mats, healed_uvs, healed_holes) =
            heal_mesh(&positions, &faces, &face_mats, &corner_uvs, &holes, bake);
        if faces.is_empty() {
            return Vec::new();
        }

        let tags = self.mesh_layer_tags(run_idx);
        let base_material = if eff_slot != 0 {
            self.mats.dense(eff_slot)
        } else {
            kernel::NO_MATERIAL
        };

        // Non-manifold runs split into buildable open shells (rule 4: the
        // decomposition is reported, the geometry is never repaired).
        if let Some(pieces) = mesh_heal::split::split_non_manifold(
            &positions,
            &faces,
            &healed_mats,
            &healed_uvs,
            &healed_holes,
        ) {
            self.warnings.push(format!(
                "'{}' is non-manifold; imported as {} open shell{} \
                 (split at non-manifold edges, geometry unchanged)",
                if name.is_empty() {
                    "unnamed mesh"
                } else {
                    &name
                },
                pieces.len(),
                if pieces.len() == 1 { "" } else { "s" },
            ));
            return pieces
                .into_iter()
                .map(|piece| {
                    recipe_from_arrays(
                        name.clone(),
                        piece.positions,
                        piece.faces,
                        piece.face_materials,
                        piece.face_corner_uvs,
                        piece.face_holes,
                        base_material,
                        tags.clone(),
                    )
                })
                .collect();
        }

        vec![recipe_from_arrays(
            name,
            positions,
            faces,
            healed_mats,
            healed_uvs,
            healed_holes,
            base_material,
            tags,
        )]
    }

    /// Tag paths for an entity on `slot`: the layer name as a single-segment
    /// path, for named non-default layers only.
    fn layer_tags(&self, slot: u16) -> Vec<Vec<String>> {
        if slot == 0 {
            return Vec::new();
        }
        self.model
            .layer_of(slot)
            .filter(|l| !l.name.is_empty())
            .map(|l| vec![vec![l.name.clone()]])
            .unwrap_or_default()
    }

    /// Object-level tags for a run's mesh: Hew tags are per-object, `.skp`
    /// layers are per-face — when every face agrees on ONE non-default
    /// layer, carry it; mixed-layer meshes carry none.
    fn mesh_layer_tags(&self, run_idx: usize) -> Vec<Vec<String>> {
        let mesh = &self.model.geometry[run_idx].mesh;
        let slots: BTreeSet<u16> = mesh.faces.iter().map(|f| f.layer).collect();
        match (slots.len(), slots.first()) {
            (1, Some(&slot)) => self.layer_tags(slot),
            _ => Vec::new(),
        }
    }
}

/// Healed (or split-piece) parallel arrays -> a `MeshRecipe`, fitting the
/// per-face affine UV frames from the corner UVs (same as dae-import).
#[allow(clippy::too_many_arguments)]
fn recipe_from_arrays(
    name: String,
    positions: Vec<Point3>,
    faces: Vec<Vec<usize>>,
    face_materials: Vec<u32>,
    corner_uvs: Vec<Vec<[f64; 2]>>,
    face_holes: Vec<Vec<Vec<usize>>>,
    base_material: u32,
    tags: Vec<Vec<String>>,
) -> MeshRecipe {
    let face_uv_frames: Vec<Option<UvFrame>> = faces
        .iter()
        .zip(corner_uvs.iter())
        .map(|(face, uvs)| {
            if uvs.len() == face.len() && uvs.len() >= 3 {
                let corner_pos: Vec<Point3> = face.iter().map(|&vi| positions[vi]).collect();
                fit_uv_frame(&corner_pos, uvs)
            } else {
                None
            }
        })
        .collect();
    MeshRecipe {
        name,
        positions,
        faces,
        face_materials,
        face_uv_frames,
        face_holes,
        base_material,
        tags,
    }
}

/// A composed row-major 4×4 world matrix (metres) -> kernel `Transform`:
/// its first 12 entries are exactly `from_affine`'s row-major 3×4 layout.
fn pose_of(world: &[f64; 16]) -> Transform {
    let rows: [f64; 12] = world[0..12].try_into().expect("4x4 has 12 affine entries");
    Transform::from_affine(&rows)
}

/// Rebase a converted subtree's ABSOLUTE poses into a definition's local
/// frame (`inv` = the definition placement's inverse world pose). Instances
/// compose; groups carry no transform, so they recurse. Meshes are usually
/// already def-local (a component's own geometry never reaches this
/// function's `Mesh` arm) — the exception is a SketchUp GROUP's own meshes
/// (`group_node`), baked to WORLD at conversion time; nested inside a
/// definition, `inv` composes on top to finish the job, landing them in
/// def-local coordinates.
fn rebase_to_local(node: &mut ImportNode, inv: &Transform) {
    match node {
        ImportNode::Instance { pose, .. } => *pose = pose.then(inv),
        ImportNode::Group { children, .. } => {
            for c in children {
                rebase_to_local(c, inv);
            }
        }
        ImportNode::Mesh(m) => rebase_mesh(m, inv),
    }
}

/// Apply `inv` to a mesh recipe's positions, refitting each face's UV frame
/// so the position <-> UV relationship it already renders survives bit-for-
/// bit: the new corner UVs are read off the OLD frame at the OLD positions
/// (the frame's actual current prediction, not a re-derivation of SketchUp's
/// raw values), then `fit_uv_frame` refits against the NEW (rebased)
/// corners — the same fit `recipe_from_arrays` used to build the frame in
/// the first place, just re-run in the new coordinate space.
fn rebase_mesh(m: &mut MeshRecipe, inv: &Transform) {
    let new_positions: Vec<Point3> = m.positions.iter().map(|&p| inv.apply_point(p)).collect();
    for (face, frame) in m.faces.iter().zip(m.face_uv_frames.iter_mut()) {
        if let Some(f) = frame {
            let uvs: Vec<[f64; 2]> = face.iter().map(|&vi| f.apply(m.positions[vi])).collect();
            let new_corners: Vec<Point3> = face.iter().map(|&vi| new_positions[vi]).collect();
            *frame = fit_uv_frame(&new_corners, &uvs);
        }
    }
    m.positions = new_positions;
}

/// The importer key of a placed object: its persistent id, the identity a
/// scene's hidden-entity list names. 0 means the reader could not resolve
/// one (the 2017 legacy byte-scan path), and such a node carries no key.
fn key_of(pid: u32) -> Option<u64> {
    (pid != 0).then_some(u64::from(pid))
}

/// A `.skp` camera as a Hew camera state (both metres).
fn camera_state(c: &openskp::Camera) -> CameraState {
    let m = |v: [f64; 3]| Point3::new(v[0], v[1], v[2]);
    CameraState {
        projection: if c.perspective {
            CameraProjection::Perspective
        } else {
            CameraProjection::Parallel
        },
        fov_deg: c.fov_deg,
        eye: m(c.eye_m),
        target: m(c.target_m),
        up: Vec3::new(c.up[0], c.up[1], c.up[2]),
    }
}

/// The world pose of every geometry run's FIRST placement in the composed
/// tree, by run index (the root run is not placed and is absent).
fn first_placements(tree: &[openskp::Node]) -> BTreeMap<usize, Transform> {
    let mut first_pose: BTreeMap<usize, Transform> = BTreeMap::new();
    fn visit(nodes: &[openskp::Node], out: &mut BTreeMap<usize, Transform>) {
        for n in nodes {
            if let Some(ri) = n.run {
                out.entry(ri).or_insert_with(|| pose_of(&n.world));
            }
            visit(&n.children, out);
        }
    }
    visit(tree, &mut first_pose);
    first_pose
}

/// Every guide in the model as a world-frame Hew guide. A guide among the
/// model's own entities is already world; a guide inside a definition is
/// stored in that definition's local frame and appears once per placement
/// of the definition, carried through the placement's world pose (a
/// definition that is never placed contributes nothing, as its geometry
/// doesn't either). The legacy byte-scan path reports no owner and its
/// guides pass through as world guides.
fn world_guides(model: &openskp::Model, tree: &[openskp::Node]) -> Vec<ImportGuide> {
    // definition map index -> every world pose placing it
    let mut placements: BTreeMap<usize, Vec<Transform>> = BTreeMap::new();
    fn visit(
        nodes: &[openskp::Node],
        model: &openskp::Model,
        out: &mut BTreeMap<usize, Vec<Transform>>,
    ) {
        for n in nodes {
            if let Some(di) = n.run.and_then(|ri| model.geometry[ri].def_index) {
                out.entry(di).or_default().push(pose_of(&n.world));
            }
            visit(&n.children, model, out);
        }
    }
    visit(tree, model, &mut placements);

    let mut out = Vec::new();
    for g in &model.guides {
        let origin = Point3::new(g.point_m[0], g.point_m[1], g.point_m[2]);
        let direction = Vec3::new(g.direction[0], g.direction[1], g.direction[2]);
        match g.def_index {
            None => out.push(ImportGuide::Line { origin, direction }),
            Some(di) => {
                for pose in placements.get(&di).map(Vec::as_slice).unwrap_or(&[]) {
                    out.push(ImportGuide::Line {
                        origin: pose.apply_point(origin),
                        direction: pose.apply_vector(direction),
                    });
                }
            }
        }
    }
    out
}

/// Every section plane in the model, keyed by persistent id, as a world
/// frame Hew section state (metres): the run's local plane carried through
/// the world pose of the run's first placement (identity for the root
/// run). Planes whose placement pose is singular are left out.
fn section_planes_world(
    model: &openskp::Model,
    tree: &[openskp::Node],
) -> BTreeMap<u32, SectionPlaneState> {
    let first_pose = first_placements(tree);

    let mut out = BTreeMap::new();
    for (ri, run) in model.geometry.iter().enumerate() {
        let is_root = run.def_index.is_none();
        let pose = if is_root {
            Some(Transform::IDENTITY)
        } else {
            first_pose.get(&ri).copied()
        };
        let Some(pose) = pose else {
            continue;
        };
        for sp in &run.sections {
            let [a, b, c, d] = sp.plane;
            let n_local = Vec3::new(a, b, c);
            // A point on the plane: -D · n (inches -> metres).
            let p_local = Point3::new(
                -d * a / openskp::INCH,
                -d * b / openskp::INCH,
                -d * c / openskp::INCH,
            );
            // The normal goes through the plane transform (inverse
            // transpose), not the vector one: a non-uniformly scaled
            // placement would otherwise tilt it off the transformed plane.
            let Ok(local_plane) = Plane::from_point_normal(p_local, n_local) else {
                continue;
            };
            let Ok(world_plane) = pose.apply_plane(&local_plane) else {
                continue;
            };
            out.insert(
                sp.pid,
                SectionPlaneState {
                    origin: pose.apply_point(p_local),
                    normal: world_plane.normal(),
                    active: true,
                },
            );
        }
    }
    out
}
