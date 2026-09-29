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
}

/// Parse SketchUp `.skp` bytes — the 2026 container or the 2017 format —
/// into a kernel `ImportScene` recipe.
///
/// I/O-free; textures are embedded in the format, so unlike `dae-import` no
/// host-resolved image map is needed. Per-mesh geometry issues are NOT errors
/// here — meshes are emitted as-is and `Document::ingest` skips and reports
/// any it rejects (rule 4: reported, never repaired).
pub fn import(bytes: &[u8]) -> Result<SkpScene, SkpError> {
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
        openskp::Container::Unknown if decoded_release => {
            return Err(SkpError::Parse(format!(
                "SketchUp {version} header without a readable model behind it — \
                 the file is truncated or damaged"
            )));
        }
        openskp::Container::Carchive2017 | openskp::Container::Unknown => {
            return Err(SkpError::UnsupportedVersion { version });
        }
    }

    let model = openskp::Model::parse(bytes).map_err(|e| SkpError::Parse(e.to_string()))?;
    let out = convert::convert(&model);
    // A DAMAGED parse that composes NOTHING importable is a loud failure,
    // not a silent empty success (the failure mode that motivated this: a
    // 57 MB house model desyncing 32k times and importing as an empty
    // document). A CLEAN parse that yields nothing is trusted — genuinely
    // empty models and guide-only files exist, and their uninstanced
    // template-figure faces are correctly not imported.
    let recovery_notes = model.diagnostics.iter().filter(|d| d.is_desync()).count();
    if recovery_notes > 0
        && out.scene.roots.is_empty()
        && out.scene.defs.is_empty()
        && out.scene.guides.is_empty()
    {
        return Err(SkpError::EmptyScene { recovery_notes });
    }
    Ok(SkpScene {
        scene: out.scene,
        textures_missing: out.textures_missing,
        warnings: out.warnings,
    })
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
