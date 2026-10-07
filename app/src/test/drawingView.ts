/**
 * Test-harness views of the drawing an object carries on its own faces, read
 * through the one engine every consumer uses: `object_drawing_planes` for the
 * planes and `plane_units_json` with the object context for the listing.
 * `imprintView` keeps the long-standing "sub-face / chord" vocabulary the E2E
 * specs assert in; `curveRunsView` reports drawn circles and arcs that other
 * drawing cut into several runs.
 */

import type { V3 } from '../viewport/geoHelpers'
import {
  ctxOfObjectPlane,
  keyToId,
  objectDrawingPlanes,
  parsePlaneUnits,
  regionRingEdges,
  ringAllDrawn,
  unitName,
  type PlaneEdge,
  type PlaneUnit,
  type PlaneUnits,
} from '../tools/planeUnits'
import type { Scene } from '../wasm/loader'

export interface ImprintView {
  kind: 'sub_face' | 'chord'
  id: string
  loop: V3[]
  name: string
  /** Per edge (loop[k] to loop[k+1]) the analytic circle, or `null` for a line. */
  curves: ({ center: V3; radius: number | null } | null)[]
}

export interface CurveRunsView {
  id: string
  name: string
  closed: boolean
  runs: { key: string; edges: number }[]
}

function listObjectPlanes(s: Scene, object: bigint): PlaneUnits[] {
  const out: PlaneUnits[] = []
  for (const plane of objectDrawingPlanes(s, object)) {
    const ctx = ctxOfObjectPlane(plane, object)
    try {
      out.push(parsePlaneUnits(ctx, s.plane_units_json(ctx)))
    } catch {
      // a stale plane lists nothing
    }
  }
  return out
}

const q = (p: V3): string => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`

function segDist(p: V3, a: V3, b: V3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0
  return Math.hypot(p[0] - (a[0] + d[0] * t), p[1] - (a[1] + d[1] * t), p[2] - (a[2] + d[2] * t))
}

/** The drawn shapes on an object's faces: one `sub_face` per standalone
 *  closed shape (a region whose whole outer ring is drawing, no edge of which
 *  is shared with another such region), and `chord` runs for everything else
 *  — each run being the connected drawing edges that separate the same pair
 *  of regions, or that close nothing. */
export function imprintView(s: Scene, object: bigint): ImprintView[] {
  const out: ImprintView[] = []
  for (const pu of listObjectPlanes(s, object)) {
    const topo = new Map<string, PlaneEdge>()
    for (const u of pu.units) {
      for (const e of u.edges) if (e.store.kind === 'topology' && e.store.object === object) topo.set(e.key, e)
    }
    const faceRegions = pu.regions.filter((r) => r.over !== null && r.extrude === null)
    const curveAt = (a: V3, b: V3, edges: Iterable<PlaneEdge>): PlaneEdge['curve'] => {
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
      for (const e of edges) if (segDist(mid, e.a, e.b) <= 1e-7) return e.curve
      return null
    }
    const sides = new Map<string, Set<string>>() // edge -> regions bordering it
    for (const r of faceRegions) {
      for (const e of regionRingEdges(pu, r)) {
        if (!topo.has(e.key)) continue
        sides.set(e.key, (sides.get(e.key) ?? new Set()).add(r.key))
      }
    }
    const closed = faceRegions.filter((r) => ringAllDrawn(pu, r.outer))
    const outerCount = new Map<string, number>()
    const outerOf = new Map<string, PlaneEdge[]>()
    for (const r of closed) {
      const ring = regionRingEdges(pu, r, true).filter((e) => topo.has(e.key))
      outerOf.set(r.key, ring)
      for (const e of ring) outerCount.set(e.key, (outerCount.get(e.key) ?? 0) + 1)
    }
    const used = new Set<string>()
    for (const r of closed) {
      const ring = outerOf.get(r.key) ?? []
      if (ring.length === 0 || ring.some((e) => (outerCount.get(e.key) ?? 0) > 1)) continue
      ring.forEach((e) => used.add(e.key))
      const keys = new Set(ring.map((e) => e.key))
      const unit: PlaneUnit = {
        key: r.key,
        edges: ring,
        curves: pu.units.flatMap((u) => u.curves).filter((c) => c.edges.every((k) => keys.has(k))),
      }
      out.push({
        kind: 'sub_face',
        // The face the shape cuts out (what Push/Pull takes), else its key.
        id: (r.over?.face ?? keyToId(r.key)).toString(),
        loop: r.outer,
        name: unitName(unit),
        curves: r.outer.map((a, i) => curveAt(a, r.outer[(i + 1) % r.outer.length], ring)),
      })
    }
    // Everything else: runs of edges with the same pair of neighbours.
    const rest = [...topo.values()].filter((e) => !used.has(e.key))
    const pairKey = (e: PlaneEdge): string => [...(sides.get(e.key) ?? [])].sort().join('|')
    const groups = new Map<string, PlaneEdge[]>()
    for (const e of rest) groups.set(pairKey(e), [...(groups.get(pairKey(e)) ?? []), e])
    for (const edges of groups.values()) {
      const done = new Set<string>()
      for (const first of edges) {
        if (done.has(first.key)) continue
        // Connected component of this group's edges.
        const comp: PlaneEdge[] = []
        const stack = [first]
        done.add(first.key)
        while (stack.length > 0) {
          const e = stack.pop() as PlaneEdge
          comp.push(e)
          for (const o of edges) {
            if (done.has(o.key)) continue
            if ([q(o.a), q(o.b)].some((p) => p === q(e.a) || p === q(e.b))) {
              done.add(o.key)
              stack.push(o)
            }
          }
        }
        out.push(...chordRuns(pu, comp))
      }
    }
  }
  return out
}

/** One component of connected edges as chord runs: a single path, or — where
 *  the component branches — a path per branch. */
function chordRuns(pu: PlaneUnits, comp: PlaneEdge[]): ImprintView[] {
  const deg = new Map<string, number>()
  for (const e of comp) for (const p of [q(e.a), q(e.b)]) deg.set(p, (deg.get(p) ?? 0) + 1)
  const left = new Set(comp.map((e) => e.key))
  const at = (p: string): PlaneEdge[] => comp.filter((e) => left.has(e.key) && (q(e.a) === p || q(e.b) === p))
  const out: ImprintView[] = []
  // Start paths at endpoints/junctions first, then any remaining cycle.
  const order = [...comp].sort((x, y) => Math.min(deg.get(q(x.a)) ?? 0, deg.get(q(x.b)) ?? 0) - Math.min(deg.get(q(y.a)) ?? 0, deg.get(q(y.b)) ?? 0))
  for (const e0 of order) {
    if (!left.has(e0.key)) continue
    // Pick the start vertex: a non-degree-2 end if this edge has one.
    let start = q(e0.a)
    if (deg.get(q(e0.b)) !== 2 && deg.get(q(e0.a)) === 2) start = q(e0.b)
    const pts: V3[] = []
    const curves: PlaneEdge['curve'][] = []
    const edges: PlaneEdge[] = []
    let cur = start
    let e: PlaneEdge | undefined = e0
    while (e !== undefined) {
      left.delete(e.key)
      edges.push(e)
      const forward = q(e.a) === cur
      if (pts.length === 0) pts.push(forward ? e.a : e.b)
      pts.push(forward ? e.b : e.a)
      curves.push(e.curve)
      cur = forward ? q(e.b) : q(e.a)
      e = deg.get(cur) === 2 ? at(cur)[0] : undefined
    }
    const keys = new Set(edges.map((x) => x.key))
    const unit: PlaneUnit = {
      key: e0.key,
      edges,
      curves: pu.units.flatMap((u) => u.curves).filter((c) => c.edges.every((k) => keys.has(k))),
    }
    out.push({ kind: 'chord', id: keyToId(e0.key).toString(), loop: pts, name: unitName(unit), curves })
  }
  return out
}

/** Every drawn circle or arc on an object's faces that other drawing cut
 *  into several runs. */
export function curveRunsView(s: Scene, object: bigint): CurveRunsView[] {
  const out: CurveRunsView[] = []
  for (const pu of listObjectPlanes(s, object)) {
    const byCurve = new Map<string, { key: string; edges: string[] }[]>()
    for (const u of pu.units) {
      for (const r of u.curves) {
        if (r.kind !== 'circle') continue
        byCurve.set(r.curveKey, [...(byCurve.get(r.curveKey) ?? []), { key: r.key, edges: r.edges }])
      }
    }
    for (const [curveKey, runs] of byCurve) {
      if (runs.length < 2) continue // a whole, uncut circle is an ordinary shape
      const deg = new Map<string, number>()
      for (const run of runs) {
        for (const k of run.edges) {
          const e = pu.edgeByKey.get(k)?.edge
          if (e === undefined) continue
          for (const p of [q(e.a), q(e.b)]) deg.set(p, (deg.get(p) ?? 0) + 1)
        }
      }
      const closed = deg.size > 0 && [...deg.values()].every((d) => d === 2)
      out.push({
        id: curveKey,
        name: closed ? 'Circle' : 'Arc',
        closed,
        runs: runs.map((r) => ({ key: r.key, edges: r.edges.length })),
      })
    }
  }
  return out
}
