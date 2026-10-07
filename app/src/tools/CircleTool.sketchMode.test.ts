/**
 * CircleTool — sketch mode (sketches on any plane, Phase 2 wave B): hovering
 * a committed sketch that is NOT on the ground plane, at top level, adopts
 * that sketch's plane and targets it directly (`SketchTarget.existing`)
 * as one `draft_begin_sketch` draft. See
 * the sketch-planes design §1/§4 and `drawPlane.ts`/`sketchGesture.ts`.
 * Mirrors LineTool.sketchMode.test.ts / RectangleTool.sketchMode.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { CircleTool } from './CircleTool'
import { draftMock } from './draftMock'
import { segmentsPerTurn } from './arcMath'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

/**
 * A ray that genuinely PIERCES the tilted sketch's plane on the sketch
 * itself — what the pick cone models and what `rayLandsOnSketch` (the
 * sketch-mode adoption gate in `drawPlane.ts`) measures. It pierces y = 0 at
 * (1, 0, 0), a point on `SKETCH_LINES`'s bottom edge. A ray lying IN the
 * plane (the old `[0,0,5] → -Z` fixture) can never pick that plane's sketch
 * in the real app: it has no pierce point at all.
 */
const RAY: Ray = { origin: [1, 5, 0], direction: [0, -1, 0] }

/** The tilted sketch's own geometry: a 4 m square on the y = 0 plane, the
 *  shape `RAY` lands on. `Scene.sketch_lines` reports xyz endpoint pairs. */
const SKETCH_LINES = new Float32Array([
  0, 0, 0, 4, 0, 0,
  4, 0, 0, 4, 0, 4,
  4, 0, 4, 0, 0, 4,
  0, 0, 4, 0, 0, 0,
])

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'plane', ...overrides }
}

/** A tilted sketch: the XZ plane (y=0), normal +Y — a horizontal-but-rotated
 *  "wall" sketch whose in-plane basis spans X and Z (not X/Y like ground),
 *  so any drawn geometry has non-trivial Z coordinates. */
const TILTED_SKETCH = 55n
const TILTED_PLANE = new Float64Array([0, 0, 0, 0, 1, 0])
/** Plane-membership tolerance mirroring drawPlane.ts's GROUND_PLANE_EPS. */
const PLANE_EPS = 1e-9

type SegmentCall = { a: [number, number, number]; b: [number, number, number] }
type CurveWithCall = { cx: number; cy: number; cz: number; radius: number }

function makeWasmScene(opts: {
  /** `pick_sketch` result for every ray — a fixed handle (hit) or undefined (miss). */
  sketchPick?: bigint
  /** `sketch_plane` per handle; mutate to simulate a sketch vanishing mid-gesture. */
  planes?: Map<bigint, Float64Array | undefined>
} = {}) {
  const planes = opts.planes ?? new Map<bigint, Float64Array | undefined>([[TILTED_SKETCH, TILTED_PLANE]])
  const segmentCalls: SegmentCall[] = []
  const curveWithCalls: CurveWithCall[] = []
  let nextRegionsCreated: bigint[] = []
  // CircleTool reports the LAST segment's regions_created, so setting this
  // before the commit and never resetting it is enough (mirrors
  // RectangleTool.sketchMode.test.ts).
  const dm = draftMock({ regionsCreated: () => nextRegionsCreated })
  const baseAdd = dm.members.draft_add_segment.getMockImplementation()!
  dm.members.draft_add_segment.mockImplementation((d, ax, ay, az, bx, by, bz) => {
    segmentCalls.push({ a: [ax, ay, az], b: [bx, by, bz] })
    return baseAdd(d, ax, ay, az, bx, by, bz)
  })
  const baseCurve = dm.members.draft_begin_curve_with.getMockImplementation()!
  dm.members.draft_begin_curve_with.mockImplementation((d, center, radius) => {
    curveWithCalls.push({ cx: center[0], cy: center[1], cz: center[2], radius })
    return baseCurve(d, center, radius)
  })

  const scene = {
    history_generation: vi.fn(() => 1n),
    ...dm.members,
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => opts.sketchPick),
    sketch_plane: vi.fn((h: bigint) => planes.get(h)),
    // Mirrors the real `Scene.sketch_lines`: the sketch's segments, and a
    // throw for a sketch that is no longer there.
    sketch_lines: vi.fn((h: bigint) => {
      if (planes.get(h) === undefined) throw new Error('UnknownSketch')
      return SKETCH_LINES
    }),
  }
  return {
    scene: scene as unknown as WasmScene,
    dm,
    segmentCalls,
    curveWithCalls,
    setNextRegionsCreated: (rc: bigint[]) => { nextRegionsCreated = rc },
    planes,
  }
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new CircleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('CircleTool — sketch mode (drawing on a hovered non-ground sketch)', () => {
  it('hovering a rotated sketch anchors in sketch mode with its plane', () => {
    const { scene } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY) // center

    expect(tool.capturingInput()).toBe(true)
    expect(scene.pick_sketch).toHaveBeenCalled()
    // Sketch mode targets the EXISTING handle — no plane draft opened.
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
  })

  it('a GRAZING pick the ray does not land on draws on the ground, not the tilted sketch', () => {
    // The regression behind the Follow Me L-path spec: `pick_sketch`'s cone
    // measures perpendicular distance to the ray, so a standing sketch seen
    // near edge-on "hits" for a click aimed at the ground half a metre away.
    // `rayLandsOnSketch` (drawPlane.ts) rejects it — this ray pierces y = 0
    // at (1, 0, -20), nowhere near SKETCH_LINES. Pinned per tool so a wrapper
    // that stopped delegating to the shared resolver would be caught here and
    // not only in drawPlane.test.ts.
    const grazing: Ray = { origin: [1, 5, 0], direction: [0, -1, -4] }
    const { scene } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), grazing) // center
    tool.onPointerDown(makeSnap({ x: 4, y: 1, z: 0 }), grazing) // rim — commits

    // Ground draft on the z = 0 plane, never a draft on the tilted sketch.
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_sketch).not.toHaveBeenCalled()
  })

  it('a committed circle sends draft_begin_curve_with an on-plane center and every segment endpoint on-plane, with non-trivial tilted-axis (Z) coordinates', () => {
    const { scene, dm, segmentCalls, curveWithCalls } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 4, y: 0, z: 2 }), RAY) // rim, radius 3

    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    // One draft, opened on the hovered sketch.
    expect(dm.log.begins).toHaveLength(1)
    expect(dm.log.begins[0].kind).toBe('sketch')
    expect(dm.log.begins[0].args[0]).toBe(TILTED_SKETCH)
    expect(curveWithCalls).toHaveLength(1)
    // The curve's own center lies on the tilted plane (y ~ 0).
    expect(Math.abs(curveWithCalls[0].cy)).toBeLessThan(PLANE_EPS)
    expect(curveWithCalls[0].radius).toBeCloseTo(3, 9)

    expect(segmentCalls.length).toBe(segmentsPerTurn(3))
    // Every endpoint satisfies |(p - origin)·normal| < 1e-9 — origin is
    // [0,0,0], normal is [0,1,0], so this is exactly "y ~ 0".
    for (const s of segmentCalls) {
      expect(Math.abs(s.a[1])).toBeLessThan(PLANE_EPS)
      expect(Math.abs(s.b[1])).toBeLessThan(PLANE_EPS)
    }
    // Non-trivial coordinates on the tilted axis: this plane's basis spans
    // X and Z (not X/Y like ground), so some Z values must be non-zero —
    // NOT the ground-mode z=0 fast path.
    const zValues = segmentCalls.flatMap((s) => [s.a[2], s.b[2]])
    expect(zValues.some((z) => Math.abs(z) > 1e-6)).toBe(true)

    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [] })
  })

  it('a region-closing final segment fires onCommit with the created region handles', () => {
    const { scene, setNextRegionsCreated } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onCommit } = makeTool(scene)

    setNextRegionsCreated([77n]) // the circle's closing facet reports a new region
    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 4, y: 0, z: 2 }), RAY) // rim — commits

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [77n] })
  })

  it('a stale hovered sketch mid-gesture toasts and does NOT open a draft', () => {
    const { scene, planes } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onToast, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY) // anchors sketch mode (center)
    planes.delete(TILTED_SKETCH) // the sketch vanished (e.g. its creating gesture was undone)

    tool.onPointerDown(makeSnap({ x: 4, y: 0, z: 2 }), RAY) // attempted commit (rim)

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).not.toHaveBeenCalled() // never a silent retarget
    expect(scene.draft_begin_sketch).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).not.toHaveBeenCalled()
  })

  it('ground drawing (no sketch under the cursor): each commit is its own draft on the same ground plane', () => {
    const { scene, dm, segmentCalls } = makeWasmScene({ sketchPick: undefined })
    const { tool: circle1 } = makeTool(scene)

    circle1.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    circle1.onPointerDown(makeSnap({ x: 2, y: 0, z: 0 }), RAY)

    // A fresh tool instance (as after a tool switch): no shared cache, its
    // commit is another draft on the same ground plane.
    const { tool: circle2 } = makeTool(scene)
    circle2.onPointerDown(makeSnap({ x: 5, y: 5, z: 0 }), RAY)
    circle2.onPointerDown(makeSnap({ x: 7, y: 5, z: 0 }), RAY)

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(2)
    for (const b of dm.log.begins) {
      expect(b.kind).toBe('plane')
      expect(b.args.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    }
    // The ground fast path: committed z is exactly 0.
    expect(segmentCalls.every((s) => s.a[2] === 0 && s.b[2] === 0)).toBe(true)
  })
})
