//! How a document asks to be shown: the backdrop and the axes
//! (docs/dev/HEW_FILE_FORMAT.md §4.15). A SketchUp model carries a style —
//! background and sky colors, whether the ground is drawn, whether the
//! model axes show — and a file opened from one keeps looking the way it
//! did there. A document without a style is shown Hew's own way (the
//! theme's backdrop, the ground grid, the axes).
//!
//! View state like the camera (`camera.rs`): persisted with the document,
//! never part of undo history. The small set here is what Hew can honor
//! today; edge and face styles wait for a styles feature of its own.

/// A document's backdrop and axes settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewStyle {
    /// The color behind everything, sRGB.
    pub background: [u8; 3],
    /// The sky's color above the horizon when a sky is drawn; `None` draws
    /// the background there.
    pub sky: Option<[u8; 3]>,
    /// The ground plane's color below the horizon when a ground is drawn;
    /// `None` leaves the plane out (Hew's grid lines still draw on it).
    pub ground: Option<[u8; 3]>,
    /// Whether the model axes are shown.
    pub axes: bool,
}
