---
question: "Can it import SketchUp files?"
order: 4
---

Yes. Hew imports SketchUp's native `.skp` format directly through a clean-room reader: the current 2026 format that every SketchUp in use today saves (the free web app included), and the 2017 format that the last free desktop version wrote and that many older models are still in. It also reads COLLADA `.dae` files, which every version of SketchUp can export. Imported geometry is healed and classified into watertight Objects where possible, and non-manifold geometry is flagged rather than silently repaired, so you always know what you're starting from.

Files saved by the releases in between (2018 through 2025) aren't decoded yet; opening one in any current SketchUp and saving it again produces a file Hew reads.
