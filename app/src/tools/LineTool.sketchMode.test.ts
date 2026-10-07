/**
 * LineTool — sketch mode (sketches on any plane, Phase 2 wave A): hovering a
 * committed sketch that is NOT on the ground plane, at top level, adopts
 * that sketch's plane and targets it directly (`SketchTarget.existing`)
 * instead of the shared per-plane ground cache. See the sketch-planes design
 * §1/§4 and `drawPlane.ts`/`sketchGesture.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import { draftMock } from './draftMock'
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

/** A tilted sketch: the y=0 plane, normal -Y (a vertical "wall" sketch). */
const TILTED_SKETCH = 55n
const TILTED_PLANE = new Float64Array([0, 0, 0, 0, -1, 0])

type SegmentCall = { a: [number, number, number]; b: [number, number, number] }

function makeWasmScene(opts: {
  /** `pick_sketch` result for every ray — a fixed handle (hit) or undefined (miss). */
  sketchPick?: bigint
  /** `sketch_plane` per handle; mutate to simulate a sketch vanishing mid-gesture. */
  planes?: Map<bigint, Float64Array | undefined>
} = {}) {
  const planes = opts.planes ?? new Map<bigint, Float64Array | undefined>([[TILTED_SKETCH, TILTED_PLANE]])
  let nextRegionsCreated: bigint[] = []
  const dm = draftMock({
    regionsCreated: () => {
      const rc = nextRegionsCreated
      nextRegionsCreated = []
      return rc
    },
  })
  // A sketch draft reports the sketch it was opened on (as the real engine does).
  let openedSketch: bigint | null = null
  const draft_begin_sketch = vi.fn((sketch: bigint, label: string) => {
    openedSketch = sketch
    return dm.members.draft_begin_sketch(sketch, label)
  })
  const draft_end = vi.fn((d: bigint) => {
    const report = JSON.parse(dm.members.draft_end(d)) as { sketches: number[] }
    if (openedSketch !== null) report.sketches = [Number(openedSketch)]
    openedSketch = null
    return JSON.stringify(report)
  })
  const segmentCalls = new Proxy([] as SegmentCall[], {
    get(_t, k) {
      const live: SegmentCall[] = dm.log.segments.map((sg) => ({
        a: sg.slice(0, 3) as SegmentCall['a'],
        b: sg.slice(3, 6) as SegmentCall['b'],
      }))
      return Reflect.get(live, k)
    },
  })

  const scene = {
    history_generation: vi.fn(() => 1n),
    ...dm.members,
    draft_begin_sketch,
    draft_end,
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => opts.sketchPick),
    sketch_plane: vi.fn((h: bigint) => planes.get(h)),
    // Mirrors the real `Scene.sketch_lines`: the sketch's segments, and a
    // throw for a sketch that is no longer there.
    sketch_lines: vi.fn((h: bigint) => {
      if (planes.get(h) === undefined) throw new Error('UnknownSketch')
      return SKETCH_LINES
    }),
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
    // Movable drawing axes (tool-parity §4) — world identity, read by the
    // from-point closing inference (`_findFromPointCandidate`) whenever a
    // chain has 2+ committed points, regardless of sketch mode.
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
  }
  return {
    scene: scene as unknown as WasmScene,
    segmentCalls,
    members: scene,
    log: dm.log,
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
  const tool = new LineTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('LineTool — sketch mode (drawing on a hovered non-ground sketch)', () => {
  it('hovering a rotated sketch anchors in sketch mode with its plane', () => {
    const { scene, members } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 5 }), RAY)

    expect(scene.pick_sketch).toHaveBeenCalled()
    // Sketch mode targets the EXISTING handle — no ground plane draft opened,
    // and the draft is begun on the tilted sketch (asserted at commit, since
    // a ground-mode first click looks identical until something is committed).
    expect(members.draft_begin_plane).not.toHaveBeenCalled()
    expect(members.draft_begin_sketch.mock.calls.map((c) => c[0])).toEqual([TILTED_SKETCH])
  })

  it('a GRAZING pick the ray does not land on draws on the ground, not the tilted sketch', () => {
    // The regression behind the Follow Me L-path spec: `pick_sketch`'s cone
    // measures perpendicular distance to the ray, so a standing sketch seen
    // near edge-on "hits" for a click aimed at the ground half a metre away.
    // `rayLandsOnSketch` (drawPlane.ts) rejects it — the ray pierces y = 0
    // at (1, 0, -20), nowhere near SKETCH_LINES.
    const grazing: Ray = { origin: [1, 5, 0], direction: [0, -1, -4] }
    const { scene, segmentCalls, members } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), grazing)
    // A hard (endpoint) pick keeps its exact point; a free click would land on the displayed length.
    tool.onPointerDown(makeSnap({ x: 3, y: 2, z: 0, kind: 'endpoint' }), grazing)

    expect(members.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(members.draft_begin_plane.mock.calls[0].slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    expect(members.draft_begin_sketch).not.toHaveBeenCalled()
    expect(segmentCalls).toHaveLength(1)
    // Ground mode's z=0 fast path, not the tilted plane's basis math.
    expect(segmentCalls[0].a).toEqual([1, 1, 0])
    expect(segmentCalls[0].b).toEqual([3, 2, 0])
  })

  it('segments commit into the hovered sketch with on-plane world coordinates (z not forced to 0)', () => {
    const { scene, segmentCalls, members } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 2 }), RAY)
    // Hard pick: the committed point is exactly the snapped one (a free click would round to the displayed length).
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 5, kind: 'endpoint' }), RAY)

    expect(members.draft_begin_plane).not.toHaveBeenCalled()
    expect(segmentCalls).toHaveLength(1)
    expect(members.draft_begin_sketch.mock.calls[0][0]).toBe(TILTED_SKETCH)
    expect(segmentCalls[0].a).toEqual([1, 0, 2])
    expect(segmentCalls[0].b).toEqual([3, 0, 5])
    // NOT the ground-mode z=0 fast path — the committed z is exactly the
    // snapped z, never zeroed.
    expect(segmentCalls[0].a[2]).not.toBe(0)
    expect(segmentCalls[0].b[2]).not.toBe(0)
    expect(onCommit).toHaveBeenCalledWith(TILTED_SKETCH)
  })

  it('a region-closing commit fires onCommit and ends the chain', () => {
    const { scene, setNextRegionsCreated } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0, z: 0 }), RAY)
    setNextRegionsCreated([77n])
    tool.onPointerDown(makeSnap({ x: 2, y: 0, z: 2 }), RAY)

    expect(onCommit).toHaveBeenCalledTimes(2) // fires every commit, closing or not
    expect(tool.capturingInput()).toBe(false) // the chain ended (region closed)
  })

  it('a stale hovered sketch mid-gesture toasts and does NOT create a ground sketch', () => {
    const { scene, planes, members } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const { tool, onToast, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // anchors sketch mode
    planes.delete(TILTED_SKETCH) // the sketch vanished (e.g. its creating gesture was undone)

    tool.onPointerDown(makeSnap({ x: 2, y: 0, z: 0 }), RAY) // attempted commit

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(members.draft_begin_plane).not.toHaveBeenCalled() // never a silent retarget
    expect(members.draft_begin_sketch).not.toHaveBeenCalled()
    expect(members.draft_add_segment).not.toHaveBeenCalled()
  })

  it('ground drawing (no sketch under the cursor) commits each segment as its own ground plane draft, across tool instances', () => {
    const { scene, segmentCalls, members } = makeWasmScene({ sketchPick: undefined })
    const { tool: line1 } = makeTool(scene)

    line1.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    line1.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)

    // A fresh tool instance (as after a tool switch) commits onto the same
    // ground plane — there is no per-plane sketch cache any more: each
    // commit is one draft begun on the ground plane.
    const { tool: line2 } = makeTool(scene)
    line2.onPointerDown(makeSnap({ x: 5, y: 5 }), RAY)
    line2.onPointerDown(makeSnap({ x: 6, y: 5 }), RAY)

    expect(members.draft_begin_plane).toHaveBeenCalledTimes(2)
    for (const c of members.draft_begin_plane.mock.calls) expect(c.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    expect(segmentCalls).toHaveLength(2)
    // The ground fast path: committed z is exactly 0.
    expect(segmentCalls[0].a[2]).toBe(0)
    expect(segmentCalls[0].b[2]).toBe(0)
  })
})
