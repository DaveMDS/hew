/**
 * RectangleTool — sketch mode (sketches on any plane, Phase 2 wave A):
 * hovering a committed sketch that is NOT on the ground plane, at top
 * level, adopts that sketch's plane and targets it directly
 * (`SketchTarget.existing`) and commits as ONE draft on that sketch (`draft_begin_sketch`).
 * See the sketch-planes design §1/§4 and `drawPlane.ts`/`sketchGesture.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RectangleTool } from './RectangleTool'
import { draftMock } from './draftMock'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { formatLength } from '../settings/units'

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

/** A tilted sketch: the y=0 plane, normal -Y (a vertical "wall" sketch).
 *  `facePlaneBasis([0,-1,0])` resolves to u=[0,0,1], v=[-1,0,0] — worked out
 *  once here so the expected commit corners below are exact, not approximate. */
const TILTED_SKETCH = 55n
const TILTED_PLANE = new Float64Array([0, 0, 0, 0, -1, 0])
const GROUND_PLANE_ARR = new Float64Array([0, 0, 0, 0, 0, 1])

type SegmentCall = { a: [number, number, number]; b: [number, number, number] }

function makeWasmScene(opts: {
  sketchPick?: bigint
  planes?: Map<bigint, Float64Array | undefined>
} = {}) {
  const planes = opts.planes ?? new Map<bigint, Float64Array | undefined>([[TILTED_SKETCH, TILTED_PLANE]])
  let nextRegionsCreated: bigint[] = []
  const dm = draftMock({ regionsCreated: () => nextRegionsCreated })
  const segmentCalls: SegmentCall[] = []
  const baseAdd = dm.members.draft_add_segment.getMockImplementation()!
  dm.members.draft_add_segment.mockImplementation((d, ax, ay, az, bx, by, bz) => {
    segmentCalls.push({ a: [ax, ay, az], b: [bx, by, bz] })
    return baseAdd(d, ax, ay, az, bx, by, bz)
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
    /** The committed segments, as endpoint pairs (live array). */
    segmentCalls,
    /** Sets the regions_created() result for every segment call FROM NOW ON
     *  (RectangleTool reports the LAST segment's regions_created, so setting
     *  this before the commit and never resetting it is enough). */
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
  const tool = new RectangleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('RectangleTool — sketch mode (drawing on a hovered non-ground sketch)', () => {
  it('hovering a rotated sketch anchors in sketch mode with its plane', () => {
    const { scene } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 2 }), RAY)

    expect(tool.capturingInput()).toBe(true)
    expect(scene.pick_sketch).toHaveBeenCalled()
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

    tool.onPointerDown(makeSnap({ x: 0, y: 1, z: 0 }), grazing) // anchor
    tool.onPointerDown(makeSnap({ x: 3, y: 2, z: 0 }), grazing) // opposite corner — commits

    // Ground draft on the z = 0 plane, never a draft on the tilted sketch.
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_sketch).not.toHaveBeenCalled()
  })

  it('the second click commits four segments into the hovered sketch with on-plane world coordinates, and a closing commit fires onCommit', () => {
    const { scene, dm, segmentCalls, setNextRegionsCreated } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onCommit } = makeTool(scene)

    setNextRegionsCreated([123n]) // the loop always closes — report it on every segment
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 2 }), RAY) // anchor
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 5 }), RAY) // opposite corner — commits

    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    // One draft, opened on the hovered sketch.
    expect(dm.log.begins).toHaveLength(1)
    expect(dm.log.begins[0].kind).toBe('sketch')
    expect(dm.log.begins[0].args[0]).toBe(TILTED_SKETCH)
    expect(segmentCalls).toHaveLength(4)
    // Exact corners on the y=0 plane (u=[0,0,1], v=[-1,0,0] for normal
    // [0,-1,0] — see the module-level comment; `faceRectangleCorners`
    // reverses winding when du/dv have opposite signs, which they do here):
    // (0,0,2) -> (3,0,2) -> (3,0,5) -> (0,0,5) -> back to (0,0,2). Every y is
    // exactly 0 (on-plane) and z varies between 2 and 5 — NOT the
    // ground-mode z=0 fast path.
    expect(segmentCalls).toEqual([
      { a: [0, 0, 2], b: [3, 0, 2] },
      { a: [3, 0, 2], b: [3, 0, 5] },
      { a: [3, 0, 5], b: [0, 0, 5] },
      { a: [0, 0, 5], b: [0, 0, 2] },
    ])
    // The draft's report names the sketch the edges landed in.
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [123n] })
  })

  it('a stale hovered sketch mid-gesture toasts and does NOT open a draft or commit any segment', () => {
    const { scene, planes } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onToast, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 2 }), RAY) // anchors sketch mode
    planes.delete(TILTED_SKETCH) // the sketch vanished mid-gesture

    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 5 }), RAY) // attempted commit

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    expect(scene.draft_begin_sketch).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).not.toHaveBeenCalled()
  })

  it('ground drawing (no sketch under the cursor): each commit is its own draft on the same ground plane', () => {
    const { scene, dm, segmentCalls } = makeWasmScene({ sketchPick: undefined })
    const { tool: rect1 } = makeTool(scene)

    rect1.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    rect1.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)

    const { tool: rect2 } = makeTool(scene) // fresh instance
    rect2.onPointerDown(makeSnap({ x: 5, y: 5 }), RAY)
    rect2.onPointerDown(makeSnap({ x: 6, y: 6 }), RAY)

    // No shared cache: two drafts, both opened on the ground plane.
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(2)
    for (const b of dm.log.begins) {
      expect(b.kind).toBe('plane')
      expect(b.args.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    }
    // The ground fast path: every committed z is exactly 0.
    expect(segmentCalls.every((s) => s.a[2] === 0 && s.b[2] === 0)).toBe(true)
  })
})

/**
 * The live readout names the same two numbers, in the same order, that typing
 * them back would use — and that order is width across the surface first,
 * height up it second, whichever way the rectangle was dragged.
 *
 * `faceRectangleCorners` swaps corners B and D when the drag's two signed
 * in-plane extents have opposite signs (to keep the preview CCW from
 * +normal), so corner spacing would flip the pair for half of all drags;
 * and `facePlaneBasis` puts the vertical axis FIRST on a wall, so the raw
 * basis order would read height × width. `rectangleDimensionAxes` fixes the
 * order, and every path — readout, typed commit, retype — measures along it.
 */
describe('RectangleTool \u2014 the live readout reads width \u00d7 height and agrees with typing it back', () => {
  /** normal [0,-1,0] \u2192 basis u = +Z, v = \u2212X; the dimension axes reorder that
   *  to W along X (across the wall), D along Z (up it). */
  const ANCHOR = { x: 0, y: 0, z: 2 }
  /** 3 across, 2 up. du = +2, dv = \u22123 \u2014 opposite signs, a winding-reversing drag. */
  const CURSOR_EAST = { x: 3, y: 0, z: 4 }
  /** The same 3 across, 2 up, dragged the other way: du = +2, dv = +3. */
  const CURSOR_WEST = { x: -3, y: 0, z: 4 }

  const CORNERS_EAST = new Set(['0,0,2', '3,0,2', '3,0,4', '0,0,4'])
  const CORNERS_WEST = new Set(['0,0,2', '-3,0,2', '-3,0,4', '0,0,4'])

  it.each([
    ['east (winding-reversing)', CURSOR_EAST],
    ['west', CURSOR_WEST],
  ])('reports width first, height second, dragging %s', (_name, cursor) => {
    const { scene } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap(ANCHOR), RAY)
    tool.onPointerMove(makeSnap(cursor), RAY)

    expect(onMeasurement).toHaveBeenLastCalledWith(`${formatLength(3)} \u00d7 ${formatLength(2)}`)
  })

  it.each([
    ['east', CURSOR_EAST, CORNERS_EAST],
    ['west', CURSOR_WEST, CORNERS_WEST],
  ])('typing the pair back draws the rectangle the readout described, dragging %s', (_name, cursor, corners) => {
    const { scene, segmentCalls, setNextRegionsCreated } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)
    setNextRegionsCreated([123n])

    tool.onPointerDown(makeSnap(ANCHOR), RAY)
    tool.onPointerMove(makeSnap(cursor), RAY)
    for (const ch of '3,2') tool.onKey({ key: ch } as KeyboardEvent)
    tool.onKey({ key: 'Enter' } as KeyboardEvent)

    expect(segmentCalls).toHaveLength(4)
    expect(new Set(segmentCalls.map((s) => s.a.join(',')))).toEqual(corners)
  })
})
