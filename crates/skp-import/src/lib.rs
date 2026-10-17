//! SketchUp `.skp` import: clean-room OpenSKP reader -> Hew Objects/Instances.
//!
//! Provenance: the `openskp` dependency is **OpenSKP**
//! (https://github.com/hew3d/openskp), a clean-room reader for SketchUp
//! files — the 2026 container (`{26.x}`, a ZIP holding a tagged record
//! tree) that every current SketchUp release saves, the free web app
//! included, and the 2017 `CArchive` stream (`{17.x}`) of older files —
//! derived solely from self-authored corpora, their COLLADA ground-truth
//! exports, and public knowledge of MFC `CArchive` serialization and the
//! ZIP format. Its only runtime dependency is a DEFLATE decoder. **No
//! Trimble/SketchUp SDK material exists anywhere in this crate's dependency
//! chain** — that is the admissibility test docs/dev/DEVELOPMENT.md rule 7
//! states, and it must hold for every future dependency added here.
//!
//! Shape mirrors `dae-import`: depends on `kernel` (builds Objects), never the
//! reverse; takes bytes, no filesystem or network. The entry point is
//! [`import`]; it emits a `kernel::ImportScene` recipe which
//! `Document::ingest` materialises. Import-quality gaps are fixed upstream in
//! OpenSKP and the rev pin advanced — never papered over here ( rule).

pub use openskp;

mod convert;
mod extras;
mod material;

/// Typed failures from [`import`].
#[derive(Debug, Clone)]
pub enum SkpError {
    /// The bytes are not a SketchUp file at all.
    NotSkp,
    /// A SketchUp file in a layout the reader has not decoded: a `CArchive`
    /// stream from a release other than 2017 (2013–2016, or 2018–2025,
    /// whose files are unobserved). Carries the file's own version string
    /// (e.g. `"{21.1.0}"`) so the UI can say which SketchUp wrote it and
    /// suggest saving it again from a current SketchUp (the free web app
    /// writes the 2026 container) or **File ▸ Save As ▸ SketchUp Version
    /// 2017**. Any file in the 2026 ZIP container is read, whatever its
    /// version says: that is the layout current releases share.
    UnsupportedVersion {
        /// The header's version string, brace form.
        version: String,
    },
    /// A recognised container that failed to parse.
    Parse(String),
    /// The file parsed but yielded NO importable content (no meshes, no
    /// placements) — with the recovery-note count when the parser had to
    /// resync, since heavy recovery is the usual cause. Failing loudly here
    /// beats a silent empty document pretending the import succeeded.
    EmptyScene {
        /// How many parser recovery notes accompanied the empty result.
        recovery_notes: usize,
    },
    /// The file is cut short or damaged and nothing of its model could be
    /// read: a SketchUp header with no readable model behind it, a 2026
    /// container missing its ZIP end record, or a 2017 stream the
    /// whole-file grammar refused for running out of data that yielded
    /// nothing. A file that is cut
    /// short (a download or copy that did not finish) is the usual cause,
    /// so the copy asks for a fresh copy rather than a re-save.
    Damaged,
}

impl std::fmt::Display for SkpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkpError::NotSkp => write!(f, "not a SketchUp .skp file"),
            SkpError::UnsupportedVersion { version } => write!(
                f,
                "unsupported SketchUp version {version}: open it in SketchUp (the \
                 free web app works) and save it again as a current .skp, or \
                 File \u{25b8} Save As \u{25b8} SketchUp Version 2017, then import that"
            ),
            SkpError::Parse(msg) => write!(f, ".skp parse error: {msg}"),
            SkpError::EmptyScene { recovery_notes: 0 } => {
                write!(f, "the .skp file contains no importable geometry")
            }
            SkpError::EmptyScene { recovery_notes } => write!(
                f,
                "no importable geometry survived parsing ({recovery_notes} \
                 malformed sections skipped) — the file may be damaged; \
                 re-saving it from SketchUp usually rewrites it cleanly"
            ),
            SkpError::Damaged => write!(
                f,
                "this .skp file looks incomplete or damaged. It may not have \
                 finished downloading or copying, so get a fresh copy and open that"
            ),
        }
    }
}

impl std::error::Error for SkpError {}

/// A parsed `.skp`, ready for `Document::ingest`.
pub struct SkpScene {
    /// The import recipe (`ingest` consumes it).
    pub scene: kernel::ImportScene,
    /// Texture names whose embedded image bytes were absent (their materials
    /// fall back to the average color) — pass to `ingest` as
    /// `textures_missing`.
    pub textures_missing: Vec<String>,
    /// Reader recovery notes: non-empty means the reader skipped a damaged
    /// or unknown record (2026) or had to resync inside a malformed section
    /// (2017) and content may be missing. Clean SketchUp files of either
    /// container produce none (an OpenSKP regression guarantee). Surface
    /// these in the import report; fixes belong upstream in OpenSKP.
    pub warnings: Vec<String>,
    /// Where each imported node and definition came from in the file, by
    /// importer key ([`kernel::ImportReport::keys`]) and definition recipe
    /// index ([`kernel::ImportReport::defs`]): what a later save back to
    /// the file needs to put unchanged content back where it was.
    pub provenance: Provenance,
}

/// Where an imported node came from in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Origin {
    /// The model's loose geometry (an Object).
    Loose,
    /// The geometry of a group placement standing alone for the group (an
    /// Object), by the placement's persistent id.
    GroupGeometry { pid: u32 },
    /// A group placement's own geometry beside its children (an Object).
    GroupOwnGeometry { pid: u32 },
    /// A group placement (a Group).
    Group { pid: u32 },
    /// A component placement (an Instance).
    Instance { pid: u32 },
    /// A placed image among the model's own entities (an Instance of the
    /// image's definition): a save back keeps the file's image, moved
    /// where the Instance is.
    Image { pid: u32 },
    /// A component definition's own geometry (an Object inside a
    /// definition): the definition's index in the file's definition list
    /// and the paint its placement passed down.
    DefinitionGeometry { definition: usize, slot: u16 },
}

/// Provenance of an import (see [`SkpScene::provenance`]).
#[derive(Debug, Clone, Default)]
pub struct Provenance {
    /// Importer key -> origins. A key can name a group placement's geometry
    /// and the group both; the node's kind tells which origin is its own.
    pub nodes: Vec<(u64, Origin)>,
    /// Definition recipe index -> (the file definition's name, the paint
    /// its placements passed down): each Hew definition is one material
    /// variant of a file definition. Names identify a component definition
    /// in SketchUp (they are unique), and survive a rewrite of the file
    /// where list positions do not.
    pub defs: Vec<(usize, String, u16)>,
    /// Annotation index (into the scene's annotations) -> the SketchUp
    /// text or dimension it was read from: a save back keeps that record
    /// while the annotation is unchanged.
    pub annotations: Vec<(usize, AnnotationOrigin)>,
    /// Tag path -> the file layer it was read from, by name: a save back
    /// renames the layer in place when the tag is renamed, and knows a
    /// layer no tag stands for any more.
    pub tags: Vec<(Vec<String>, String)>,
    /// Sketch indices (into the scene's sketches) read from the file's
    /// loose edges: a save back keeps those edges as they are while the
    /// sketches are unchanged.
    pub loose_sketches: Vec<usize>,
}

/// The SketchUp record an imported annotation was read from: its list in
/// the file, its index there and its persistent id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnnotationOrigin {
    Text { index: usize, pid: u32 },
    Dimension { index: usize, pid: u32 },
    RadialDimension { index: usize, pid: u32 },
}

/// Parse SketchUp `.skp` bytes — the 2026 container or the 2017 format —
/// into a kernel `ImportScene` recipe.
///
/// I/O-free; textures are embedded in the format, so unlike `dae-import` no
/// host-resolved image map is needed. Per-mesh geometry issues are NOT errors
/// here — meshes are emitted as-is and `Document::ingest` skips and reports
/// any it rejects (rule 4: reported, never repaired).
pub fn import(bytes: &[u8]) -> Result<SkpScene, SkpError> {
    let mut job = import_begin(bytes)?;
    job.step(usize::MAX);
    job.finish()
}

/// Start an import: read the file (the one step that cannot be split)
/// and set up the conversion. See [`ImportJob`].
pub fn import_begin(bytes: &[u8]) -> Result<ImportJob, SkpError> {
    // Container gate: identify ANY SketchUp file from its header, then
    // accept the two decoded layouts. The 2026 ZIP container is read
    // whatever version string it carries — it is the layout every current
    // release writes, and a record from a newer release the reader does not
    // know surfaces as a warning, never as a refusal. A `CArchive` stream is
    // accepted only from 2017, the one release of that layout OpenSKP has
    // decoded; 2013–2016 and 2018–2025 streams are refused with their
    // version so the message can point at the re-save. A header from a
    // decoded release whose body is neither layout is damage, not an
    // unsupported version, and says so.
    let (version, _guid) = openskp::header_info(bytes).ok_or(SkpError::NotSkp)?;
    let decoded_release = matches!(version_major(&version), Some(17 | 26));
    match openskp::detect_container(bytes) {
        openskp::Container::Zip => {}
        openskp::Container::Carchive2017 if version_major(&version) == Some(17) => {}
        openskp::Container::Unknown if decoded_release => return Err(SkpError::Damaged),
        openskp::Container::Carchive2017 | openskp::Container::Unknown => {
            return Err(SkpError::UnsupportedVersion { version });
        }
    }

    let model = openskp::Model::parse(bytes).map_err(|e| {
        // A 2026 container keeps its ZIP directory at the very end, so a
        // file cut short loses it first.
        if matches!(openskp::detect_container(bytes), openskp::Container::Zip)
            && !has_zip_end_record(bytes)
        {
            SkpError::Damaged
        } else {
            SkpError::Parse(e.to_string())
        }
    })?;
    // A DAMAGED parse that composes NOTHING importable is a loud failure,
    // not a silent empty success (the failure mode that motivated this: a
    // 57 MB house model desyncing 32k times and importing as an empty
    // document). A CLEAN parse that yields nothing is trusted — genuinely
    // empty models and guide-only files exist, and their uninstanced
    // template-figure faces are correctly not imported.
    let recovery_notes = model.diagnostics.iter().filter(|d| d.is_desync()).count();
    // The whole-file grammar reads every complete 2017 file it can decode
    // from header to last byte, and refuses a file cut short for running out
    // of data, often after the walk fallback has already found every shape
    // in it. The refusal is informational to the reader, not a desync, but
    // that one means the file is incomplete: refused outright when nothing
    // came of it, said out loud when something did. A refusal for anything
    // else (a structure the grammar does not decode, in a healthy file)
    // leaves the walk's result as it was.
    let incomplete = model.diagnostics.iter().any(|d| {
        matches!(d, openskp::Diagnostic::WholeFileRefused { detail } if ran_out_of_data(detail))
    });
    Ok(ImportJob {
        job: convert::ConvertJob::begin(std::rc::Rc::new(model)),
        recovery_notes,
        incomplete,
    })
}

/// The first of [`SkpScene::warnings`] when the file is incomplete or damaged
/// but something of it was read: the 2017 whole-file grammar refused it for
/// running out of data and the walk fallback served it (see [`import_begin`]). Exported so a caller
/// can tell this note from the rest and show it on its own.
pub const INCOMPLETE_NOTE: &str = "this .skp file looks incomplete or damaged, so parts \
     of the model may be missing. If it was downloaded or copied, a fresh copy may \
     open whole";

/// True when a whole-file refusal's `detail` says the stream ran out: a
/// read past the last byte, a declared count larger than the bytes left, or
/// a string longer than them. These are OpenSKP 0.5's three wordings (its
/// `ar17` reader); the cut-short specs in `tests/import_specs.rs` fail if a
/// later release rewords them.
fn ran_out_of_data(detail: &str) -> bool {
    detail.contains("stream ends at")
        || detail.contains("bytes that remain")
        || detail.contains("runs past the stream")
}

/// True when `bytes` end with a ZIP end-of-central-directory record: its
/// signature 22 bytes plus the record's own comment length before the end.
/// (The signature alone also turns up inside compressed entries.)
fn has_zip_end_record(bytes: &[u8]) -> bool {
    const SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const FIXED: usize = 22;
    let lowest = bytes.len().saturating_sub(FIXED + 0xffff);
    (lowest..=bytes.len().saturating_sub(FIXED)).rev().any(|p| {
        bytes.len() >= FIXED
            && bytes[p..p + 4] == SIG
            && p + FIXED + usize::from(u16::from_le_bytes([bytes[p + 20], bytes[p + 21]]))
                == bytes.len()
    })
}

/// An import under way: the file is read ([`import_begin`]); its shapes
/// are then built a few at a time ([`ImportJob::step`]), so an open can
/// say how far it has come, and [`ImportJob::finish`] hands the recipe
/// over.
pub struct ImportJob {
    job: convert::ConvertJob,
    recovery_notes: usize,
    /// The 2017 whole-file grammar refused the file for running out of
    /// data (see [`import_begin`]).
    incomplete: bool,
}

impl ImportJob {
    /// Items built so far, out of all of them: the file's runs of loose
    /// geometry and its top-level placements.
    pub fn progress(&self) -> (usize, usize) {
        self.job.progress()
    }

    /// Shapes (definition recipes) built so far.
    pub fn shapes(&self) -> usize {
        self.job.shapes()
    }

    /// Build up to `items` more; true once everything is built.
    pub fn step(&mut self, items: usize) -> bool {
        self.job.step(items)
    }

    /// Build whatever is left and hand the recipe over.
    pub fn finish(self) -> Result<SkpScene, SkpError> {
        let mut out = self.job.finish();
        let empty = out.scene.roots.is_empty()
            && out.scene.defs.is_empty()
            && out.scene.guides.is_empty()
            && out.scene.extra.sketches.is_empty();
        if empty && self.incomplete {
            return Err(SkpError::Damaged);
        }
        if empty && self.recovery_notes > 0 {
            return Err(SkpError::EmptyScene {
                recovery_notes: self.recovery_notes,
            });
        }
        if self.incomplete {
            out.warnings.insert(0, INCOMPLETE_NOTE.to_string());
        }
        Ok(SkpScene {
            scene: out.scene,
            textures_missing: out.textures_missing,
            warnings: out.warnings,
            provenance: out.provenance,
        })
    }
}

/// Major version from the header's brace form: `"{17.3.116}"` -> 17.
fn version_major(version: &str) -> Option<u32> {
    version
        .trim_start_matches('{')
        .split(['.', '}'])
        .next()?
        .parse()
        .ok()
}

/// Topology counts of each geometry run in a `.skp` byte stream.
///
/// The thinnest end-to-end use of the clean-room reader ( probe); kept
/// as a cheap pre-import inspection alongside the full import pipeline.
pub fn probe_topology(bytes: &[u8]) -> Vec<openskp::Topology> {
    openskp::geometry_runs(bytes)
        .into_iter()
        .map(|run| run.topology)
        .collect()
}
