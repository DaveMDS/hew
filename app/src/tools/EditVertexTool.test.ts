import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { EditVertexTool } from './EditVertexTool'
import type { Snap } from './types'
import { setLengthUnit, getLengthUnit } from '../settings/units'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { ctxOfPlane } from './planeUnits'
import { draftMock, type DraftLog } from './draftMock'
import { planeUnitsMock, type MockListing, type MockUnit } from './planeUnitsMock'

// A ray straight down the -Z axis from above the origin (tuple-shaped, as the
// real Viewport supplies — the tool indexes ray.origin[0..2]).
const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent
}

/** A fake `SketchVertexPickJs` returning the seeded handles/position. */
function makePick(sketch: bigint, vertex: bigint, pos: [number, number, number]) {
  return {
    sketch: () => sketch,
    vertex: () => vertex,
    x: () => pos[0],
    y: () => pos[1],
    z: () => pos[2],
    free: vi.fn(),
  }
}

/** The context of the plane a `sketch_plane` answer describes. */
const ctxOfSketchPlane = (sp: number[]) => ctxOfPlane([sp[0], sp[1], sp[2]], [sp[3], sp[4], sp[5]]) as string
/** The context of the face at z = 1 (+Z) the face-drawing tests pick. */
const CTX_FACE = ctxOfPlane([0, 0, 1], [0, 0, 1]) as string

/** One unit of 2-point edges from a flat `sketch_lines` buffer. */
function unitOfLines(lines: Float64Array): MockUnit {
  const edges = []
  for (let i = 0; i + 5 < lines.length; i += 6) {
    edges.push({
      key: 21 + i / 6,
      a: [lines[i], lines[i + 1], lines[i + 2]] as [number, number, number],
      b: [lines[i + 3], lines[i + 4], lines[i + 5]] as [number, number, number],
    })
  }
  return { key: 1, edges }
}

/**
 * Minimal WasmScene stub — only the members EditVertexTool calls. `pick`
 * controls what `pick_sketch_vertex` returns; `lines` is the drawing the
 * picked vertex's plane lists (as one unit); `endThrows` makes the draft's
 * end reject (as the kernel does for a DegenerateSegment drag or a solid's
 * own edge); `facePick` + `listings` stand in for a face with drawing on it.
 */
function makeWasmScene(opts: {
  pick?: ReturnType<typeof makePick>
  lines?: Float64Array
  endThrows?: string
  /** `sketch_plane` result for the picked vertex's sketch —
   *  `[px,py,pz,nx,ny,nz]` (default: ground, normal +Z). `undefined`
   *  simulates a stale handle. */
  sketchPlane?: [number, number, number, number, number, number] | undefined
  facePick?: { object: () => bigint; face: () => bigint; depth: () => number; instance: () => bigint | undefined; free: () => void }
  listings?: Record<string, MockListing>
} = {}): WasmScene & { draftLog: DraftLog } {
  const sketchPlane = 'sketchPlane' in opts ? opts.sketchPlane : [0, 0, 0, 0, 0, 1]
  const dm = draftMock({ failEnd: () => (opts.endThrows !== undefined ? new Error(opts.endThrows) : null) })
  const listings: Record<string, MockListing> = opts.listings ?? (
    sketchPlane !== undefined ? { [ctxOfSketchPlane(sketchPlane)]: { units: [unitOfLines(opts.lines ?? new Float64Array([]))] } } : {}
  )
  return {
    draftLog: dm.log,
    history_generation: vi.fn(() => 1n),
    pick_sketch_vertex: vi.fn(() => opts.pick),
    pick_face: vi.fn(() => opts.facePick),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    sketch_plane: vi.fn(() => (sketchPlane !== undefined ? new Float64Array(sketchPlane) : undefined)),
    ...planeUnitsMock(listings),
    ...dm.members,
  } as unknown as WasmScene & { draftLog: DraftLog }
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new EditVertexTool(scene, preview, onCommit, onToast, onMeasurement)
  return { tool, preview, onCommit, onToast, onMeasurement }
}

describe('EditVertexTool — pick & grab', () => {
  it('grabbing a sketch vertex enters the drag stage and shows a ghost', () => {
    // One incident edge from the picked vertex (1,1,0) to (0,1,0).
    const lines = new Float64Array([1, 1, 0, 0, 1, 0])
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]), lines })
    const { tool, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY)
    expect(scene.pick_sketch_vertex).toHaveBeenCalled()
    // Ghost rebuilt from the incident edge.
    expect(preview.children.length).toBeGreaterThan(0)
  })

  it('a pick miss stays idle with no ghost', () => {
    const scene = makeWasmScene({ pick: undefined })
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 5, y: 5, z: 0 }), RAY)
    expect(preview.children).toHaveLength(0)
  })

  it('a stale sketch handle (sketch_plane undefined) is treated as a pick miss', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]), sketchPlane: undefined })
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY)
    expect(scene.sketch_plane).toHaveBeenCalledWith(7n)
    expect(preview.children).toHaveLength(0)
  })
})

// Sketches on any plane (Phase 1, the sketch-planes design §3): the
// drag's destination snap must stay on the picked vertex's own sketch plane
// (queried once at pick time), not resolve to ground and get refused by the
// kernel with PointOffPlane.
describe('EditVertexTool — snapConstraint', () => {
  it('idle: returns null (no plane to offer)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.snapConstraint()).toBeNull()
  })

  it('after picking a vertex on a rotated sketch, returns that sketch\'s plane', () => {
    const scene = makeWasmScene({
      pick: makePick(7n, 9n, [1, 1, 0]),
      sketchPlane: [0, 0, 0, 1, 0, 0], // vertical sketch, normal +X
    })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY)

    expect(tool.snapConstraint()).toEqual({
      constraintPlane: { point: [0, 0, 0], normal: [1, 0, 0] },
    })
  })

  it('resets to null after commit/cancel', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]) })
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY)
    expect(tool.snapConstraint()).not.toBeNull()
    tool.cancel()
    expect(tool.snapConstraint()).toBeNull()
  })
})

describe('EditVertexTool — drag on a rotated sketch', () => {
  it('an on-plane destination commits draft_move_vertex through the rotated plane', () => {
    // A vertical sketch (normal +X) — the vertex and its destination both
    // lie at x = 0, so a naive ground ([0,0,1]) constraint would have
    // refused nothing here (z is free either way); the meaningful check is
    // that snapConstraint reports the sketch's OWN plane, not [0,0,1], so a
    // caller doing on-plane snapping stays on x = 0 rather than z = 0.
    const lines = new Float64Array([0, 1, 1, 0, 1, 0])
    const scene = makeWasmScene({
      pick: makePick(7n, 9n, [0, 1, 1]),
      lines,
      sketchPlane: [0, 0, 0, 1, 0, 0],
    })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 1, z: 1 }), RAY) // grab
    expect(tool.snapConstraint()).toEqual({
      constraintPlane: { point: [0, 0, 0], normal: [1, 0, 0] },
    })
    tool.onPointerDown(makeSnap({ x: 0, y: 1.5, z: 1.5, kind: 'endpoint' }), RAY) // place (hard pick: exact point), on-plane (x=0)

    expect(scene.draft_move_vertex).toHaveBeenCalledWith(expect.anything(), 0, 1, 1, 0, 1.5, 1.5)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('EditVertexTool — commit', () => {
  it('the second click commits ONE draft_move_vertex on the plane context at the snapped destination', () => {
    const lines = new Float64Array([1, 1, 0, 0, 1, 0])
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]), lines })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // grab
    tool.onPointerDown(makeSnap({ x: 1.4, y: 0.8, z: 0, kind: 'endpoint' }), RAY) // place (hard pick: exact point)

    expect(scene.draft_move_vertex).toHaveBeenCalledWith(expect.anything(), 1, 1, 0, 1.4, 0.8, 0)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a click that does not move the vertex is a cancel, not a commit', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]) })
    const { tool, onCommit } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // grab
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // same spot
    expect(scene.draft_move_vertex).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a refused drag toasts the kernel error and does NOT fire onCommit', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [0, 0, 0]), endThrows: 'DegenerateSegment: the move would collapse an edge' })
    const { tool, onCommit, onToast, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // grab
    tool.onPointerDown(makeSnap({ x: 3, y: 1, z: 0 }), RAY) // illegal drag

    expect(scene.draft_end).toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    // Reset to idle: ghost cleared.
    expect(preview.children).toHaveLength(0)
  })
})

describe('EditVertexTool — arranging drags', () => {
  it('a drag across other lines is accepted: the commit fires, no toast', () => {
    // The mocked kernel accepts any drag (as the real one does now: a
    // vertex dragged onto other lines arranges instead of refusing).
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [0, 0, 0]) })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // grab
    tool.onPointerDown(makeSnap({ x: 2, y: 0.5, z: 0, kind: 'endpoint' }), RAY) // across the far side

    expect(scene.draft_move_vertex).toHaveBeenCalledWith(expect.anything(), 0, 0, 0, 2, 0.5, 0)
    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('EditVertexTool — cancel', () => {
  it('Escape clears the ghost and returns to idle', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]) })
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('Escape'))
    expect(preview.children).toHaveLength(0)
  })
})


describe('EditVertexTool — a clicked drag distance is exactly the displayed distance', () => {
  const prev = getLengthUnit()
  const dest = { x: 1 + 0.0093987, y: 1 + 0.0037873 } // dragged 10.134 mm, shows "10.1 mm"

  function drag(kind: string) {
    const scene = makeWasmScene({ pick: makePick(7n, 9n, [1, 1, 0]) })
    const { tool, onMeasurement } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // grab
    const s = makeSnap({ ...dest, z: 0, kind })
    tool.onPointerMove(s, RAY)
    tool.onPointerDown(s, RAY)
    return { args: (scene.draft_move_vertex as ReturnType<typeof vi.fn>).mock.calls[0] as number[], onMeasurement }
  }

  it('a free click lands the vertex at the shown distance along the drag', () => {
    setLengthUnit('mm')
    try {
      const r = drag('ground')
      expect(r.onMeasurement).toHaveBeenCalledWith('10.1 mm')
      expect(Math.hypot(r.args[4] - 1, r.args[5] - 1)).toBeCloseTo(10.1 * 0.001, 14)
    } finally {
      setLengthUnit(prev)
    }
  })

  it('a hard-snapped click keeps the exact snapped point', () => {
    setLengthUnit('mm')
    try {
      const r = drag('endpoint')
      expect([r.args[4], r.args[5]]).toEqual([dest.x, dest.y])
    } finally {
      setLengthUnit(prev)
    }
  })
})


// The plane is the drafting context: a vertex of the drawing on a SOLID's
// face picks and moves exactly like a ground vertex, as one draft on the
// face's context. A solid's own corners are not drawing vertices.
describe('EditVertexTool — drawing on a solid\'s face', () => {
  const facePick = { object: () => 3n, face: () => 4n, depth: () => 5, instance: () => undefined, free: () => {} }
  // A rectangle drawn on the box top (z = 1), (0.5,0.5)-(1.5,1.5).
  const rect: [number, number, number][] = [[0.5, 0.5, 1], [1.5, 0.5, 1], [1.5, 1.5, 1], [0.5, 1.5, 1]]
  const faceLines = new Float64Array(rect.flatMap((a, i) => [...a, ...rect[(i + 1) % 4]]))
  const listings = { [CTX_FACE]: { units: [unitOfLines(faceLines)] } }
  const down = (x: number, y: number): Ray => ({ origin: [x, y, 6], direction: [0, 0, -1] })

  it('picks a face drawing\'s vertex and moves it with one draft on the face context', () => {
    const scene = makeWasmScene({ facePick, listings })
    const { tool, onCommit, onToast, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1.5, y: 1.5, z: 1, kind: 'endpoint' }), down(1.5, 1.5))
    expect(preview.children.length).toBeGreaterThan(0) // ghost of the two incident edges
    expect(tool.snapConstraint()).toEqual({ constraintPlane: { point: [0, 0, 1], normal: [0, 0, 1] } })
    tool.onPointerDown(makeSnap({ x: 1.8, y: 1.9, z: 1, kind: 'endpoint' }), down(1.8, 1.9))

    const log = scene.draftLog
    expect(log.begins).toHaveLength(1)
    expect(log.begins[0].kind).toBe('ctx')
    expect(log.begins[0].args[0]).toBe(CTX_FACE)
    expect(log.moves).toEqual([[[1.5, 1.5, 1], [1.8, 1.9, 1]]])
    expect(log.ended).toBe(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a solid\'s own corner is not a drawing vertex: the pick misses and nothing opens', () => {
    const scene = makeWasmScene({ facePick, listings })
    const { tool, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'endpoint' }), down(0, 0)) // the box's corner

    expect(preview.children).toHaveLength(0)
    expect(tool.snapConstraint()).toBeNull()
    expect(scene.draft_begin_ctx).not.toHaveBeenCalled()
  })

  it('a drag that would move a solid\'s own edge refuses at draft end: toast, draft cancelled, no commit', () => {
    const scene = makeWasmScene({
      facePick,
      listings,
      endThrows: "DraftBoundaryEdgeTouched: a solid's own edge can't be moved by drawing",
    })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0.5, y: 0.5, z: 1, kind: 'endpoint' }), down(0.5, 0.5))
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'endpoint' }), down(0, 0))

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][1]).toBe('DraftBoundaryEdgeTouched')
    expect(onCommit).not.toHaveBeenCalled()
    expect(scene.draftLog.cancelled).toBe(1)
    expect(tool.snapConstraint()).toBeNull() // back at idle
  })

  it('a face seen through a placed component instance is not editable', () => {
    const scene = makeWasmScene({ facePick: { ...facePick, instance: () => 42n }, listings })
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1.5, y: 1.5, z: 1, kind: 'endpoint' }), down(1.5, 1.5))
    expect(preview.children).toHaveLength(0)
  })
})
