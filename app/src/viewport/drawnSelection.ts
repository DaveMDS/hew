/**
 * The drawn-shape half of Select All / Invert Selection: one island ref per
 * drawn shape lying on a solid's faces (or an object's owned sketches), at
 * the same granularity the ground's free drawing selects at.
 */
import { nodeKey, type NodeRef } from '../panels/treeModel'
import {
  draftRef,
  drawingCtxsOfObject,
  isDraftRef,
  readPlaneUnits,
  resolveDraft,
  type PlaneUnitsScene,
} from '../tools/planeUnits'

type DrawingScene = PlaneUnitsScene & { object_drawing_planes?(object: bigint): ArrayLike<number> }

/** The island refs of drawing on `objects`' faces, appended to `out` unless
 *  already in `seen`. `instance` and `pose` place definition members through
 *  their instance. */
export function objectDrawingIslands(
  scene: DrawingScene,
  objects: readonly bigint[],
  instance: bigint | null,
  pose: ArrayLike<number> | null,
  seen: Set<string>,
  out: NodeRef[],
): void {
  const mine = new Set(objects)
  for (const o of objects) {
    for (const ctx of drawingCtxsOfObject(scene, o, instance, pose)) {
      const pu = readPlaneUnits(scene, ctx)
      if (pu === null) continue
      for (const unit of pu.units) {
        if (!unit.edges.some((e) => e.store.kind !== 'free' && mine.has(e.store.object))) continue
        const ref = draftRef('draft-island', ctx, unit.key)
        const k = nodeKey(ref)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(ref)
      }
    }
  }
}

/** `refs` with each ref's canonical identity (kind, context, key) kept once,
 *  in first-seen order. A shape drawn half on a face and half over the void
 *  is one island in one plane context but is listed by both the free-sketch
 *  and the object-drawing enumerations. */
export function dedupeRefs(refs: readonly NodeRef[]): NodeRef[] {
  const seen = new Set<string>()
  const out: NodeRef[] = []
  for (const r of refs) {
    const k = nodeKey(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/** The complement of `selection` within `candidates`. A selected line or
 *  curve counts as its whole island being selected (there is no per-edge
 *  complement), so inverting one segment of an L leaves the L out. */
export function invertWithin(
  scene: PlaneUnitsScene,
  candidates: readonly NodeRef[],
  selection: readonly NodeRef[],
): NodeRef[] {
  const selected = new Set(selection.map(nodeKey))
  for (const ref of selection) {
    if (!isDraftRef(ref) || (ref.kind !== 'draft-edge' && ref.kind !== 'draft-curve')) continue
    const unit = resolveDraft(scene, ref)?.unit
    if (unit !== undefined && unit !== null) selected.add(nodeKey(draftRef('draft-island', ref.ctx, unit.key)))
  }
  return dedupeRefs(candidates).filter((c) => !selected.has(nodeKey(c)))
}
