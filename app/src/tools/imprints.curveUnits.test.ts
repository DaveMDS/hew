/**
 * Curve runs of a plane's drawing: a drawn circle or arc that other shapes
 * cut into several runs is still one drawn curve. Pins the `'draft-curve'`
 * ref (one ref for a circle whatever runs and units its facets are cut into)
 * and the edge-to-curve widening a click uses.
 */
import { describe, it, expect } from 'vitest'
import { isDraftKind } from '../panels/treeModel'
import { draftRef, draftRefAlive, edgeKeysOf, isDraftRef, refOfPick, resolveDraft, widenCurveRef } from './planeUnits'
import type { NodeRef } from '../panels/treeModel'

/** The same circle as a plane-unit listing: facet edges 21/22 (one unit) and
 *  31/32 (another), all sharing one circle (curve key CURVE), cut by other
 *  drawing into two RUNS (RUN1 = 21/22, RUN2 = 31/32); plus an unrelated line
 *  (41). The double's pick answers the edge at a ray's midpoint with its run. */
const CTX = '{"plane":[0,0,0,0,0,1]}'
const CURVE = '00000000000000c1'
const RUN1 = '00000000000000d1'
const RUN2 = '00000000000000d2'
const hex = (n: number) => n.toString(16).padStart(16, '0')
const circle = { center: [1, 0, 0], radius: 1 }
const planeEdges = [
  { key: hex(21), a: [0, 0, 0], b: [1, 1, 0], store: { kind: 'topology', object: 9 }, curve: circle },
  { key: hex(22), a: [1, 1, 0], b: [2, 0, 0], store: { kind: 'topology', object: 9 }, curve: circle },
  { key: hex(31), a: [2, 0, 0], b: [1, -1, 0], store: { kind: 'topology', object: 9 }, curve: circle },
  { key: hex(32), a: [1, -1, 0], b: [0, 0, 0], store: { kind: 'topology', object: 9 }, curve: circle },
  { key: hex(41), a: [5, 0, 0], b: [6, 0, 0], store: { kind: 'topology', object: 9 }, curve: null },
]
const unitOf = (e: { key: string }) => (e.key === hex(21) || e.key === hex(22) ? hex(701) : e.key === hex(41) ? hex(703) : hex(702))
const runOf = (e: { key: string }) => (e.key === hex(21) || e.key === hex(22) ? RUN1 : RUN2)
const planeListing = (edges: typeof planeEdges) => {
  const byUnit = new Map<string, typeof planeEdges>()
  for (const e of edges) byUnit.set(unitOf(e), [...(byUnit.get(unitOf(e)) ?? []), e])
  return JSON.stringify({
    units: [...byUnit].map(([key, es]) => {
      const arcs = es.filter((e) => e.curve !== null)
      return {
        key,
        edges: es,
        curves: arcs.length === 0
          ? []
          : [{ key: runOf(arcs[0]), curve_key: CURVE, kind: 'circle', center: circle.center, radius: circle.radius, edges: arcs.map((e) => e.key) }],
      }
    }),
    regions: [],
  })
}
const planeScene = (edges: typeof planeEdges = planeEdges) => ({
  plane_units_json: () => planeListing(edges),
  pick_plane_unit: (_ctx: string, ray: Float64Array) => {
    // The ray is cast down at an edge midpoint: answer that edge.
    const e = edges.find((x) => Math.abs((x.a[0] + x.b[0]) / 2 - ray[0]) < 1e-9 && Math.abs((x.a[1] + x.b[1]) / 2 - ray[1]) < 1e-9)
    return e === undefined
      ? 'null'
      : JSON.stringify({ edge: e.key, unit: unitOf(e), curve: e.curve === null ? null : CURVE, run: e.curve === null ? null : runOf(e) })
  },
})

describe('the draft-curve ref', () => {
  it('mints a draft-curve ref keyed by the kernel curve key, recognised as a draft ref', () => {
    const ref = draftRef('draft-curve', CTX, CURVE)
    expect(ref).toEqual({ kind: 'draft-curve', id: BigInt('0x' + CURVE), ctx: CTX, key: CURVE })
    expect(isDraftRef(ref)).toBe(true)
    expect(isDraftKind('draft-curve')).toBe(true)
  })

  it('a run ref resolves to just that run\'s facets', () => {
    expect(resolveDraft(planeScene(), draftRef('draft-curve', CTX, RUN1))?.edges.map((e) => e.key)).toEqual([hex(21), hex(22)])
    expect(resolveDraft(planeScene(), draftRef('draft-curve', CTX, RUN2))?.edges.map((e) => e.key)).toEqual([hex(31), hex(32)])
  })

  it('resolveDraft resolves it to EVERY facet of the circle, across the units it was cut into, and returns null once gone', () => {
    const ref = draftRef('draft-curve', CTX, CURVE)
    const r = resolveDraft(planeScene(), ref)
    expect(r?.edges.map((e) => e.key)).toEqual([hex(21), hex(22), hex(31), hex(32)])
    expect(draftRefAlive(planeScene(), ref)).toBe(true)
    // An unrelated line is not the curve; a curve key nothing carries is stale.
    expect(resolveDraft(planeScene(), draftRef('draft-curve', CTX, '00000000000000ff'))).toBeNull()
    // The circle deleted: only the line is left.
    const gone = planeScene(planeEdges.filter((e) => e.curve === null))
    expect(resolveDraft(gone, ref)).toBeNull()
    expect(draftRefAlive(gone, ref)).toBe(false)
  })
})

describe('refOfPick — a click selects the run; a double-click widens to the circle', () => {
  it('selects the RUN a facet edge belongs to, and leaves any plain line alone', () => {
    const sc = planeScene()
    expect(refOfPick(sc, CTX, { edge: hex(31), unit: hex(702), curve: CURVE, run: RUN2 })).toEqual(draftRef('draft-curve', CTX, RUN2))
    expect(refOfPick(sc, CTX, { edge: hex(41), unit: hex(703), curve: null, run: null })).toEqual(draftRef('draft-edge', CTX, hex(41)))
  })

  it('widening the run ref gives the circle\'s curve key, covering every run', () => {
    const sc = planeScene()
    const run = refOfPick(sc, CTX, { edge: hex(31), unit: hex(702), curve: CURVE, run: RUN2 }) as NodeRef
    const whole = widenCurveRef(sc, run)
    expect(whole).toEqual(draftRef('draft-curve', CTX, CURVE))
    expect(edgeKeysOf(sc, whole)).toEqual([hex(21), hex(22), hex(31), hex(32)])
  })
})
