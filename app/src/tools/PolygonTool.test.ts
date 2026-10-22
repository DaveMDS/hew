import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { PolygonTool, DEFAULT_POLYGON_SIDES, MIN_POLYGON_SIDES, MAX_POLYGON_SIDES } from './PolygonTool'
import { draftMock } from './draftMock'
import { toolHasArmedGesture, type Snap, type Tool } from './types'
import { setLengthUnit, getLengthUnit } from '../settings/units'
import type { Scene as WasmScene } from '../wasm/loader'
import { setPickRenderMode } from './pickPolicy'
import type { Ray } from '../viewport/math'

// A ray straight down the -Z axis from above the origin (tuple-shaped, as the
// real Viewport supplies — the tool indexes ray.origin[0..2]).
const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent
}

/** A fake `FacePickJs` returning the seeded handles. */
function makePick(object: bigint, face: bigint, instance?: bigint) {
  return {
    object: () => object,
    face: () => face,
    instance: () => instance,
    depth: () => 1,
    free: vi.fn(),
  }
}

/** Minimal WasmScene stub — only the members PolygonTool calls. */
function makeWasmScene(opts: {
  pick?: ReturnType<typeof makePick>
  facePlane?: [number, number, number, number, number, number]
  faceNormal?: [number, number, number]
  addSegmentThrows?: boolean
  splitFaceThrows?: boolean
} = {}): WasmScene {
  const fail = opts.addSegmentThrows
    ? new Error('PathNotSimple: edges cross')
    : opts.splitFaceThrows
      ? new Error('LoopSelfIntersects: edges cross')
      : null
  return {
    history_generation: vi.fn(() => 1n),
    // Every sketch lies on the ground plane (origin point, +Z).
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    // A polygon's commit is bracketed as ONE polygon chain
    // (draft_begin_polygon_with ... draft_end_curve), carrying the drawn
    // centre and circumradius, in plane AND face mode.
    ...draftMock({ failSegmentAt: () => fail }).members,
    pick_face: vi.fn(() => opts.pick),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
    // Every picked object is plain/ungrouped by default (top-level eligibility).
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array(opts.faceNormal ?? [0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array(opts.facePlane ?? [0, 0, 0, 0, 0, 1])),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0])), // translated +5 in x
  } as unknown as WasmScene
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onMeasurement = vi.fn()
  const onSideCountChange = vi.fn()
  const tool = new PolygonTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement, onSideCountChange)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement, onSideCountChange }
}

describe('PolygonTool — ground mode', () => {
  it('defaults to 6 sides', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.sideCount).toBe(DEFAULT_POLYGON_SIDES)
  })

  it('two clicks (center, rim) commit exactly N=6 chained plain segments and call onCommit', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim, radius 3

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(6)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [] })
    expect(onToast).not.toHaveBeenCalled()
    // A polygon never claims an analytic circle (design §4/§8).
    expect(scene.draft_begin_curve_with).not.toHaveBeenCalled()
    // The polygon IS one chain, opened as a POLYGON (not a circle) with the
    // drawn centre (0,0,0) and circumradius 3 — the record that makes its
    // centre snappable. Bracket closed exactly once.
    expect(scene.draft_begin_polygon_with).toHaveBeenCalledTimes(1)
    const pw = (scene.draft_begin_polygon_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(pw[1] as Float64Array)).toEqual([0, 0, 0])
    expect(pw[2]).toBe(3)
    expect(scene.draft_end_curve).toHaveBeenCalledTimes(1)
    // The whole N-segment commit is exactly one draft.
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
  })

  it('the last segment closes back to the exact stored vertex 0 coordinates', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 5, y: 0, z: 0 }), RAY)

    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(6)
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    const lastQ = [calls[calls.length - 1][4], calls[calls.length - 1][5], calls[calls.length - 1][6]]
    expect(lastQ).toEqual(firstP)
    // Vertex 0 is exactly the rim point (5, 0, 0).
    expect(firstP).toEqual([5, 0, 0])
  })

  it('every committed vertex lies on the circle of the given radius (within tolerance)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // center (1,1)
    tool.onPointerDown(makeSnap({ x: 5, y: 1, z: 0 }), RAY) // rim — radius 4

    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const p: [number, number, number] = [call[1], call[2], call[3]]
      const r = Math.hypot(p[0] - 1, p[1] - 1)
      expect(r).toBeCloseTo(4)
    }
  })

  it('a degenerate (zero-radius) second click is skipped — no segments, no commit, stays anchored', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // same point — degenerate

    expect(scene.draft_add_segment).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)
  })

  it('each polygon is its own draft on the same ground plane (no shared sketch cache)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 12, y: 10, z: 0 }), RAY)

    const begins = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls
    expect(begins).toHaveLength(2)
    for (const b of begins) expect(b.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    expect(scene.draft_end).toHaveBeenCalledTimes(2)
  })

  it('a refused commit (kernel throws) toasts and does not call onCommit', () => {
    const scene = makeWasmScene({ addSegmentThrows: true })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY)

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    // The refused draft is cancelled, never ended.
    expect(scene.draft_cancel).toHaveBeenCalledTimes(1)
    expect(scene.draft_end).not.toHaveBeenCalled()
  })

  it('there is no cached sketch handle to go stale: a commit opens one fresh plane draft on the ground', () => {
    const scene = makeWasmScene()
    const onCommit = vi.fn()
    const onToast = vi.fn()
    const tool = new PolygonTool(scene, new THREE.Group(), onCommit, onToast, vi.fn(), vi.fn())

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim — commits

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('PolygonTool — typed VCB: side count (Ns)', () => {
  it('8s sets the side count to 8, stays anchored (no commit)', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onSideCountChange } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onKey(makeKeyEvent('8'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(tool.sideCount).toBe(8)
    expect(onSideCountChange).toHaveBeenCalledWith(8)
    expect(onCommit).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)
  })

  it('a subsequent commit uses the newly typed side count', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('8'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim — commits

    expect(scene.draft_add_segment).toHaveBeenCalledTimes(8)
  })

  it('2s is clamped to the minimum side count (3)', () => {
    const scene = makeWasmScene()
    const { tool, onSideCountChange } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('2'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(tool.sideCount).toBe(MIN_POLYGON_SIDES)
    expect(onSideCountChange).toHaveBeenCalledWith(MIN_POLYGON_SIDES)
  })

  it('a huge side count is clamped to the maximum', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    for (const ch of '999999') tool.onKey(makeKeyEvent(ch))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(tool.sideCount).toBe(MAX_POLYGON_SIDES)
  })

  it('setSideCount (Viewport session persistence) clamps and does not fire OnSideCountChange', () => {
    const scene = makeWasmScene()
    const { tool, onSideCountChange } = makeTool(scene)

    tool.setSideCount(10)
    expect(tool.sideCount).toBe(10)
    tool.setSideCount(1)
    expect(tool.sideCount).toBe(MIN_POLYGON_SIDES)
    expect(onSideCountChange).not.toHaveBeenCalled()
  })

  it('the side count persists across multiple gestures on the same tool instance', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('8'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // commits first polygon

    ;(scene.draft_add_segment as ReturnType<typeof vi.fn>).mockClear()

    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 12, y: 10, z: 0 }), RAY) // second polygon, no re-typing

    expect(scene.draft_add_segment).toHaveBeenCalledTimes(8)
  })
})

describe('PolygonTool — typed VCB: circumradius entry', () => {
  it('typing a radius and pressing Enter commits an exact-circumradius polygon', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    expect(tool.capturingInput()).toBe(true)

    tool.onKey(makeKeyEvent('5'))
    expect(onMeasurement).toHaveBeenCalled()

    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.draft_add_segment).toHaveBeenCalledTimes(6)
    expect(onCommit).toHaveBeenCalledTimes(1)
    // Default direction (+X) since cursor hasn't moved: vertex 0 should be (5, 0, 0).
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(firstP[0]).toBeCloseTo(5)
    expect(firstP[1]).toBeCloseTo(0)
  })

  it('an explicit-unit radius (10mm) commits a circumradius of 0.01 m', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    for (const ch of '10mm') tool.onKey(makeKeyEvent(ch))
    tool.onKey(makeKeyEvent('Enter'))

    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    const r = Math.hypot(firstP[0], firstP[1])
    expect(r).toBeCloseTo(0.01)
  })

  it('typed radius follows the last rubber-band cursor direction', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerMove(makeSnap({ x: 0, y: -1, z: 0 }), RAY) // cursor toward -Y

    tool.onKey(makeKeyEvent('2'))
    tool.onKey(makeKeyEvent('Enter'))

    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(firstP[0]).toBeCloseTo(0)
    expect(firstP[1]).toBeCloseTo(-2)
  })

  it('Enter with an empty buffer does nothing (no commit)', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a typed sub-tolerance radius (0) is a no-op that STAYS in the gesture — center preserved', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onKey(makeKeyEvent('0'))
    tool.onKey(makeKeyEvent('Enter'))

    // Degenerate: no teardown, no commit.
    expect(onCommit).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)

    // The placed center survived — a real second click still commits from it.
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(6)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a typed negative radius commits its magnitude (abs), not a 180°-flipped polygon', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onKey(makeKeyEvent('-'))
    tool.onKey(makeKeyEvent('5'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).toHaveBeenCalledTimes(1)
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    // Radius 5 in the +X default direction — NOT flipped to (-5, 0, 0).
    expect(firstP[0]).toBeCloseTo(5)
    expect(firstP[1]).toBeCloseTo(0)
  })

  it('combines Ns and a typed radius in one gesture (8s, then 10mm)', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('8'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))
    for (const ch of '10mm') tool.onKey(makeKeyEvent(ch))
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(8)
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(Math.hypot(firstP[0], firstP[1])).toBeCloseTo(0.01)
  })
})

describe('PolygonTool — face mode', () => {
  it('two clicks on an entered object face open one face draft carrying the polygon bracket', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint, onToast } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center on face
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] }) // rim click

    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    const callArgs = (scene.draft_begin_face as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe(7n)
    expect(callArgs[1]).toBe(3n)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(6) // default 6 sides
    // Unified drafting: a face polygon now carries the polygon bracket too
    // (it used to be a plain imprint with no chain identity) — never a circle.
    expect(scene.draft_begin_polygon_with).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_curve_with).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a degenerate (zero-radius) second click on a face STAYS anchored — no imprint, center preserved', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center on face
    expect(tool.capturingInput()).toBe(true)
    // Second click projects to the SAME plane point as the center → zero radius.
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)

    // No imprint, and — crucially — the center is not silently dropped.
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(onFaceImprint).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)

    // A real second click from the preserved center still imprints.
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] })
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('a pick on a different object than the active context is ignored', () => {
    const pick = makePick(999n, 3n) // not the active context (7n)
    const scene = makeWasmScene({ pick })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    expect(tool.capturingInput()).toBe(false)
  })

  it('a refused face draft toasts the kernel error and does not call onFaceImprint', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, splitFaceThrows: true })
    const { tool, onFaceImprint, onToast } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] })

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onFaceImprint).not.toHaveBeenCalled()
  })
})

describe('PolygonTool — cancel', () => {
  it('Escape after the first click cancels and clears the preview', () => {
    const scene = makeWasmScene()
    const { tool, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 3, y: 0, z: 0 }), RAY)
    expect(preview.children.length).toBeGreaterThan(0)

    tool.onKey(makeKeyEvent('Escape'))

    expect(tool.capturingInput()).toBe(false)
    expect(preview.children).toHaveLength(0)
  })

  it('Escape before any click is a no-op cancel (idle stays idle)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.capturingInput()).toBe(false)
  })

  it('cancel does not reset the side count', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('8'))
    tool.onKey(makeKeyEvent('s'))
    tool.onKey(makeKeyEvent('Enter'))
    tool.cancel()

    expect(tool.sideCount).toBe(8)
  })
})

describe('PolygonTool — capturingInput scoping', () => {
  it('is false when idle (so tool-switch shortcuts are not swallowed)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.capturingInput()).toBe(false)
  })

  it('becomes true only after a center is anchored', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.capturingInput()).toBe(false)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    expect(tool.capturingInput()).toBe(true)
  })
})

describe('PolygonTool — hasArmedGesture (Escape routing, component-edit-parity.md phase A2)', () => {
  // capturingInput() alone misses the idle-locked case: an idle plane lock is
  // not "capturing input" but Escape still has tool-local work to do (clear
  // the lock) before a context-pop is appropriate — see toolHasArmedGesture
  // in tools/types.ts and the RectangleTool/LineTool coverage in
  // idlePlaneLock.test.ts (Polygon isn't in that shared driver suite, so it
  // gets its own copy here).
  it('an idle plane lock arms the tool even though capturingInput() is false', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    const asTool = tool as unknown as Tool

    expect(toolHasArmedGesture(asTool)).toBe(false)
    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(tool.capturingInput()).toBe(false) // idle-locked, not anchored
    expect(toolHasArmedGesture(asTool)).toBe(true)
  })

  it('one Escape clears an idle plane lock and the tool reports unarmed afterward', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    const asTool = tool as unknown as Tool

    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(toolHasArmedGesture(asTool)).toBe(true)

    tool.onKey(makeKeyEvent('Escape')) // idle-locked: Escape clears the lock, nothing else
    expect(toolHasArmedGesture(asTool)).toBe(false)
  })
})

describe('PolygonTool — instance editing context (component-edit-parity.md phase A2)', () => {
  const INSTANCE = 42n
  const COMPONENT = 5n

  it('face mode routes to draft_begin_face_in_instance, never the world variant', () => {
    const pick = makePick(7n, 3n, INSTANCE)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] })

    expect(scene.draft_begin_face_in_instance).toHaveBeenCalledTimes(1)
    const [instance, object, face] = (scene.draft_begin_face_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(instance).toBe(INSTANCE)
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space opens a plane draft in the instance; the polygon center stays in WORLD space', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), { origin: [6, 1, 5], direction: [0, 0, -1] })
    tool.onPointerDown(makeSnap({ x: 9, y: 1, z: 0 }), { origin: [9, 1, 5], direction: [0, 0, -1] })

    expect(scene.draft_begin_plane_in_instance).toHaveBeenCalledTimes(1)
    expect((scene.draft_begin_plane_in_instance as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(INSTANCE)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    // World-space center and radius (the engine maps through the pose).
    const pw = (scene.draft_begin_polygon_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(pw[1] as Float64Array)).toEqual([6, 1, 0])
    expect(pw[2]).toBeCloseTo(3, 6)
  })
})

// Post-click retype (retypeWindow.ts): a radius or `Ns` typed after the rim
// click redraws the polygon just drawn.
describe('PolygonTool — retype radius / side count after the rim click', () => {
  function makeRetypeScene(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const base = makeWasmScene(opts) as unknown as Record<string, unknown>
    let gen = 1n
    const baseEnd = base.draft_end as (...args: unknown[]) => unknown
    const scene = {
      ...base,
      history_generation: vi.fn(() => gen),
      // A draft that ends records one history step.
      draft_end: vi.fn((...args: unknown[]) => { const r = baseEnd(...args); gen += 1n; return r }),
      scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    }
    return scene as unknown as WasmScene
  }
  const key = (tool: PolygonTool, k: string) => tool.onKey(makeKeyEvent(k))
  const typeIn = (tool: PolygonTool, text: string) => { for (const ch of text) key(tool, ch); key(tool, 'Enter') }
  const addCalls = (scene: WasmScene) => (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
  const radiusSince = (scene: WasmScene, from: number, c: [number, number]) =>
    Math.max(...addCalls(scene).slice(from).map((k) => Math.hypot((k[1] as number) - c[0], (k[2] as number) - c[1])))

  it('a typed radius redraws the hexagon at that circumradius, same centre and rim direction', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 1 }), RAY)
    expect(addCalls(scene).length).toBe(6)
    expect(tool.statusHint()).toContain('redraw the polygon')
    const from = addCalls(scene).length
    typeIn(tool, '3')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(addCalls(scene).length).toBe(12)
    expect(radiusSince(scene, from, [1, 1])).toBeCloseTo(3, 6)
    const v0 = addCalls(scene)[from]
    expect(v0[1]).toBeCloseTo(4, 6)
    expect(v0[2]).toBeCloseTo(1, 6)
  })

  it('a typed Ns redraws with N sides at the same radius, and N becomes the session default', () => {
    const scene = makeRetypeScene()
    const { tool, onSideCountChange } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    const from = addCalls(scene).length
    typeIn(tool, '8s')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(addCalls(scene).length - from).toBe(8)
    expect(radiusSince(scene, from, [0, 0])).toBeCloseTo(2, 6)
    expect(tool.sideCount).toBe(8)
    expect(onSideCountChange).toHaveBeenLastCalledWith(8)
    // And a radius afterwards keeps the 8 sides.
    const from2 = addCalls(scene).length
    typeIn(tool, '1')
    expect(addCalls(scene).length - from2).toBe(8)
    expect(radiusSince(scene, from2, [0, 0])).toBeCloseTo(1, 6)
  })

  it('letters keep their shortcuts with an empty buffer; a digit opens the entry and then `s` is taken', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)
    expect(tool.capturesKey('s')).toBe(false)
    expect(tool.capturesKey('m')).toBe(false)
    expect(tool.capturesKey('7')).toBe(true)
    key(tool, '7')
    expect(tool.capturesKey('s')).toBe(true)
    expect(tool.capturesKey('Enter')).toBe(true)
    key(tool, 'Escape')
    expect(tool.capturesKey('7')).toBe(false)
  })
})

// Boundary-click fix: a click on an object's edge/vertex misses `pick_face`
// outright (strict polygon test at the boundary) — `_facePickAt` falls back
// to the ranked boundary pick (`FacePickCache.faceThrough`) instead of
// silently sending the whole gesture to the ground plane.
describe('PolygonTool — boundary clicks (FacePickCache.faceThrough)', () => {
  function makeBoundaryScene(pick: ReturnType<typeof makePick>) {
    const scene = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) =>
        dx === 0 && dy === 0 && dz === -1 ? undefined : pick,
    )
    return scene
  }

  it('a click on a midpoint snap (pick_face misses the exact ray) still anchors FACE mode, not the ground', () => {
    const scene = makeBoundaryScene(makePick(7n, 3n))
    const { tool, onCommit, onFaceImprint } = makeTool(scene)

    const boundarySnap = makeSnap({ x: 0, y: 0, z: 0, kind: 'midpoint', object: 7n, element: 5n, elementKind: 'edge' })
    tool.onPointerDown(boundarySnap, RAY) // first click, exactly on the boundary
    expect(tool.capturingInput()).toBe(true) // anchored — not silently dropped

    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] }) // rim

    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// Snapped face cursor fix: face mode used to project the ray onto the face
// plane unconditionally for the rubber band AND the commit, ignoring
// whatever the snap chip claimed. `_faceCursor` now honours an on-plane snap
// exactly.
describe('PolygonTool — snapped face cursor (honours the chip, not ray∩plane)', () => {
  it('the rim commit lands on the snap, not the sub-millimeter-off ray∩plane point', () => {
    const pick = makePick(7n, 3n)
    // Face at z=1, normal +Z.
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), RAY) // centre
    tool.onPointerDown(
      makeSnap({ x: 3, y: 0, z: 1, kind: 'endpoint' }),
      { origin: [3.005, 0, 5], direction: [0, 0, -1] },
    )

    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    // The loop's corners are the six segments' start points.
    const segs = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect(segs).toHaveLength(6)
    const loopPts = new Float64Array(segs.flatMap((c) => [c[1] as number, c[2] as number, c[3] as number]))
    // vertex 0 of the loop sits exactly at radius 3 from centre (0,0,1) —
    // the snap — not ~3.005 (the ray∩plane miss).
    const dist = Math.hypot(loopPts[0] - 0, loopPts[1] - 0, loopPts[2] - 1)
    expect(dist).toBeCloseTo(3, 6)
    expect(loopPts[0]).toBeCloseTo(3, 6)
    expect(loopPts[1]).toBeCloseTo(0, 6)
  })
})

// Shift-pinned drawing plane (GitHub issue 14 / planePin.ts): pressing Shift
// while hovering a face pins that face's plane for the next gesture, even
// once the cursor leaves the face entirely.
describe('PolygonTool — Shift-pinned drawing plane (GitHub issue 14)', () => {
  it('pins the hovered face plane; a later click over empty space anchors plane mode on it', () => {
    const pick = makePick(7n, 3n)
    // Face at z=1, normal +Z — a genuinely non-ground plane. `pick_face`
    // hits only under the original hover ray, so the later clicks are
    // genuinely over empty space, not merely ignored by the mode dispatch.
    const scene = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
        ox === 0 && oy === 0 && oz === 5 && dx === 0 && dy === 0 && dz === -1 ? pick : undefined,
    )
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    const emptyRay: Ray = { origin: [10, 10, 5], direction: [0, 0, -1] }
    expect(tool.snapConstraint(emptyRay)?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })

    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 1 }), emptyRay)
    tool.onPointerDown(makeSnap({ x: 13, y: 10, z: 1 }), { origin: [13, 10, 5], direction: [0, 0, -1] })

    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    // One plane draft on the pinned z = 1 plane (not the ground).
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    const begin = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(begin[2]).toBeCloseTo(1, 9)
    expect(begin.slice(3, 6)).toEqual([0, 0, 1])
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a second Shift press releases the pin; autorepeat (Shift held) does not toggle twice', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(true)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(false)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).not.toContain('Pinned')
  })

  it('Escape while idle clears the pin', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.statusHint()).not.toContain('Pinned')
    expect(tool.hasArmedGesture()).toBe(false)
  })
})


describe('PolygonTool — a clicked radius is exactly the displayed radius', () => {
  const prev = getLengthUnit()
  const rim = 0.0123456 // shows "R 12.3 mm"
  const run = (kind: string, typed: string | null) => {
    const scene = makeWasmScene()
    const t = makeTool(scene)
    t.tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    const s = makeSnap({ x: rim, y: 0, z: 0, kind })
    t.tool.onPointerMove(s, RAY)
    if (typed === null) t.tool.onPointerDown(s, RAY)
    else {
      for (const ch of typed) t.tool.onKey(makeKeyEvent(ch))
      t.tool.onKey(makeKeyEvent('Enter'))
    }
    return { calls: (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls, measure: t.onMeasurement }
  }

  it('a free click commits the same chain as typing the shown radius', () => {
    setLengthUnit('mm')
    try {
      const clicked = run('ground', null)
      const typed = run('ground', '12.3')
      expect(clicked.measure).toHaveBeenCalledWith('R 12.3 mm')
      expect(clicked.calls.length).toBeGreaterThan(0)
      expect(clicked.calls).toEqual(typed.calls)
      expect(clicked.calls[0][1]).toBe(12.3 * 0.001)
    } finally {
      setLengthUnit(prev)
    }
  })

  it('a hard-snapped (endpoint) click keeps the snapped rim exactly', () => {
    setLengthUnit('mm')
    try {
      const clicked = run('endpoint', null)
      expect(clicked.calls[0][1]).toBe(rim)
    } finally {
      setLengthUnit(prev)
    }
  })
})

// #51a audit: like Circle, the plane is fixed by the center click and the
// cursor only sets the start angle, so a Blue hover over a ground center
// still draws the typed circumradius on the ground (+X default).
describe('PolygonTool — typed radius with the cursor on the Blue axis (#51a)', () => {
  it('draws the typed circumradius on the ground plane instead of doing nothing', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 2, z: 3, kind: 'on-axis', direction: [0, 0, 1] }), RAY)
    tool.onKey(makeKeyEvent('2'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(6)
    expect([calls[0][1], calls[0][2], calls[0][3]]).toEqual([3, 2, 0])
    for (const c of calls) expect(c[3]).toBe(0)
  })
})

describe('PolygonTool — X-ray: a hidden snap off the face drops onto it, disclosed (cursorOnFrozenPlane)', () => {
  const down = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })
  // Runs under the mode it is named for.
  beforeEach(() => setPickRenderMode('xray'))
  afterEach(() => setPickRenderMode('shaded'))

  it('opts in to see-through points, lands on the point dropped onto the face (not the ray hit), says "projected", and clears it when idle', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 3n), facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face' }), down(0, 0))
    expect(tool.snapConstraint(down(0, 0))?.seeThroughPoints).toBe(true)
    // Shaded's own case is unchanged: an on-face snap is taken exactly.
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5, z: 1, kind: 'endpoint' }), down(1, 0.5))
    expect(tool.snapProjected()).toBe(false)
    // A hidden midpoint 0.4 below the face, the cursor ray elsewhere.
    const hidden = makeSnap({ x: 1, y: 0.5, z: 0.6, kind: 'midpoint' })
    tool.onPointerMove(hidden, down(1.2, 0.5))
    expect(tool.snapProjected()).toBe(true)
    tool.onPointerDown(hidden, down(1.2, 0.5))
    const segs = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.slice(1, 7) as number[])
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      expect(s[2]).toBeCloseTo(1, 12)
      expect(s[5]).toBeCloseTo(1, 12)
    }
    // The rim passes through the dropped point (radius √1.25 from the
    // center), not the ray's hit (radius 1.3).
    const r = Math.max(...segs.map((s) => Math.hypot(s[0], s[1])))
    expect(r).toBeCloseTo(Math.sqrt(1.25), 9)

    // Back to idle: no stale "projected" on the next ordinary hover.
    expect(tool.snapProjected()).toBe(false)
    tool.onPointerMove(makeSnap({ x: 0.3, y: 0.3, z: 1, kind: 'on-face' }), down(0.3, 0.3))
    expect(tool.snapProjected()).toBe(false)
  })
})

describe('PolygonTool — X-ray: a hidden point that is no part of the face, clicked first, drops onto the face (firstPointOnFace)', () => {
  const down = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })
  // Runs under the mode it is named for.
  beforeEach(() => setPickRenderMode('xray'))
  afterEach(() => setPickRenderMode('shaded'))

  it('the idle hover says "projected", the first click anchors ON the face plane, and the gesture stays on it', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 3n), facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)
    // A crossing 0.4 below the top face: no vertex or edge of the face, so
    // no face is adopted through it.
    const crossing = makeSnap({ x: 1, y: 0.5, z: 0.6, kind: 'intersection' })
    tool.onPointerMove(crossing, down(1.2, 0.5))
    expect(tool.snapProjected(), 'the hover says what the click will do').toBe(true)
    tool.onPointerDown(crossing, down(1.2, 0.5))
    expect(tool.snapProjected(), 'the click dropped it').toBe(true)
    tool.onPointerDown(makeSnap({ x: 1.6, y: 0.9, z: 1, kind: 'on-face' }), down(1.6, 0.9))
    const segs = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.slice(1, 7) as number[])
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      expect(s[2]).toBeCloseTo(1, 12)
      expect(s[5]).toBeCloseTo(1, 12)
    }
    // Centered on the dropped point: every vertex is equally far from it.
    const radii = segs.map((s) => Math.hypot(s[0] - 1, s[1] - 0.5))
    // (The rim point is the displayed value, rounded to the readout.)
    for (const r of radii) expect(Math.abs(r - Math.hypot(0.6, 0.4))).toBeLessThan(1e-3)
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-9)

    // An ordinary on-face hover is not "projected".
    tool.onPointerMove(makeSnap({ x: 0.3, y: 0.3, z: 1, kind: 'on-face' }), down(0.3, 0.3))
    expect(tool.snapProjected()).toBe(false)
  })

  it('the idle hover over a face opts in to hidden points only in X-ray', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 3n), facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)
    try {
      for (const [mode, expected] of [['shaded', false], ['wireframe', false], ['xray', true]] as const) {
        setPickRenderMode(mode)
        expect(tool.snapConstraint(down(0.5, 0.5))?.seeThroughPoints ?? false, mode).toBe(expected)
      }
    } finally {
      setPickRenderMode('shaded')
    }
  })
})
