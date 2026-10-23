import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { CircleTool, circleKeptAsDrawingMessage } from './CircleTool'
import { draftMock } from './draftMock'
import { segmentsPerTurn } from './arcMath'
import type { Snap } from './types'
import { setLengthUnit, getLengthUnit, setPrecision, DEFAULT_PRECISION } from '../settings/units'
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

/**
 * Minimal WasmScene stub — only the members CircleTool calls.
 */
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
  const tool = new CircleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('CircleTool — ground mode', () => {
  it('two clicks (center, rim) commit N chained segments and call onCommit', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim, radius 3

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    // Adaptive facet count (true-curves §6): radius 3 caps at 96 per turn.
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(3))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [] })
    expect(onToast).not.toHaveBeenCalled()
    // The whole N-segment commit is bracketed in exactly one draft, with the
    // analytic circle (world center + radius) wrapped around the facets.
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_curve_with).toHaveBeenCalledTimes(1)
    expect(scene.draft_end_curve).toHaveBeenCalledTimes(1)
  })

  it('the last segment closes back to the exact stored vertex 0 coordinates', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 5, y: 0, z: 0 }), RAY)

    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(segmentsPerTurn(5))
    // First call's "p" (args 1-3) is vertex 0; last call's "q" (args 4-6) must match exactly.
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    const lastQ = [calls[calls.length - 1][4], calls[calls.length - 1][5], calls[calls.length - 1][6]]
    expect(lastQ).toEqual(firstP)
    // Vertex 0 is exactly the rim point (5, 0, 0).
    expect(firstP).toEqual([5, 0, 0])
  })

  it('a degenerate (zero-radius) second click is skipped — no segments, no commit', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // same point — degenerate

    expect(scene.draft_add_segment).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    // Still anchored (first click stands) — capturingInput stays true.
    expect(tool.capturingInput()).toBe(true)
  })

  it('each circle is its own draft on the same ground plane (no shared sketch cache)', () => {
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
    const tool = new CircleTool(scene, new THREE.Group(), onCommit, onToast, vi.fn(), vi.fn())

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim — commits

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: expect.any(BigInt), regionsCreated: [] })
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('CircleTool — typed VCB radius entry', () => {
  it('typing a radius and pressing Enter commits an exact-radius circle', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    expect(tool.capturingInput()).toBe(true)

    tool.onKey(makeKeyEvent('5'))
    expect(onMeasurement).toHaveBeenCalled()

    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.draft_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(5))
    expect(onCommit).toHaveBeenCalledTimes(1)
    // Default direction (+X) since cursor hasn't moved: vertex 0 should be (5, 0, 0).
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(firstP[0]).toBeCloseTo(5)
    expect(firstP[1]).toBeCloseTo(0)
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
})

describe('CircleTool — face mode', () => {
  it('two clicks on an entered object face open one face draft carrying the circle bracket', () => {
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
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(3))
    // center (0,0,0) and radius 3 travel with the draft's curve bracket.
    expect(scene.draft_begin_curve_with).toHaveBeenCalledTimes(1)
    const curveArgs = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(curveArgs[1] as Float64Array)).toEqual([0, 0, 0])
    expect(curveArgs[2]).toBeCloseTo(3)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onToast).not.toHaveBeenCalled()
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

describe('CircleTool — cancel', () => {
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
})

describe('CircleTool — capturingInput scoping', () => {
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

describe('CircleTool — instance editing context (component-edit-parity.md phase A2)', () => {
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
    const callArgs = (scene.draft_begin_face_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe(INSTANCE)
    expect(callArgs[1]).toBe(7n)
    expect(callArgs[2]).toBe(3n)
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space opens a plane draft in the instance; the curve center stays in WORLD space', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    // Center at world (6,1,0), rim 3 away — identity-plane (ground), so no
    // idle lock needed to reach plane mode inside the instance context.
    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), { origin: [6, 1, 5], direction: [0, 0, -1] })
    tool.onPointerDown(makeSnap({ x: 9, y: 1, z: 0 }), { origin: [9, 1, 5], direction: [0, 0, -1] })

    expect(scene.draft_begin_plane_in_instance).toHaveBeenCalledTimes(1)
    expect((scene.draft_begin_plane_in_instance as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(INSTANCE)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    // The curve's analytic center and radius are WORLD values — the engine
    // maps them through the instance pose itself (no toLocal any more).
    expect(scene.draft_begin_curve_with).toHaveBeenCalledTimes(1)
    const curveArgs = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(curveArgs[1] as Float64Array)).toEqual([6, 1, 0])
    expect(curveArgs[2]).toBeCloseTo(3, 6)
  })
})

// Post-click radius retype (retypeWindow.ts): type a radius after the rim
// click and the circle just drawn redraws at that radius.
describe('CircleTool — retype the radius after the rim click', () => {
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
      __bump: () => { gen += 1n },
    }
    return scene as unknown as WasmScene & { __bump(): void }
  }
  const key = (tool: CircleTool, k: string) => tool.onKey(makeKeyEvent(k))
  const typeLen = (tool: CircleTool, text: string) => { for (const ch of text) key(tool, ch); key(tool, 'Enter') }
  const addCalls = (scene: WasmScene) => (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
  /** Max distance of the segment endpoints committed since call index `from`
   *  to `center` — the radius actually drawn by that commit. */
  function drawnRadius(scene: WasmScene, from: number, center: [number, number]): number {
    const calls = addCalls(scene).slice(from)
    return Math.max(...calls.map((c) => Math.hypot((c[1] as number) - center[0], (c[2] as number) - center[1])))
  }

  it('two clicks then a typed radius: one undo, then the circle redrawn at that radius around the same centre, keeping its direction', () => {
    const scene = makeRetypeScene()
    const { tool, onCommit } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 1 }), RAY) // rim toward +x, radius 1
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(tool.statusHint()).toContain('resize the circle')
    expect(tool.capturesKey('3')).toBe(true)
    expect(tool.capturesKey('c')).toBe(false) // empty buffer: shortcuts still work
    let from = addCalls(scene).length
    typeLen(tool, '3')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(drawnRadius(scene, from, [1, 1])).toBeCloseTo(3, 6)
    // The rim vertex (vertex 0 of the chain) still sits on the +x side of the centre.
    const first = addCalls(scene)[from]
    expect(first[1]).toBeCloseTo(4, 6)
    expect(first[2]).toBeCloseTo(1, 6)
    // Still open: a second radius goes through too.
    from = addCalls(scene).length
    typeLen(tool, '0.5')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(drawnRadius(scene, from, [1, 1])).toBeCloseTo(0.5, 6)
  })

  it('a typed (Enter) rim commit arms the window as well', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    typeLen(tool, '2')
    const from = addCalls(scene).length
    typeLen(tool, '1')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(drawnRadius(scene, from, [0, 0])).toBeCloseTo(1, 6)
  })

  it('Escape drops an open buffer and closes the window; a new click closes it too', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)
    key(tool, '3')
    expect(tool.hasArmedGesture()).toBe(true)
    key(tool, 'Escape')
    expect(onMeasurement).toHaveBeenLastCalledWith('')
    expect(tool.capturesKey('3')).toBe(false)
    tool.onPointerDown(makeSnap({ x: 5, y: 5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 6, y: 5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 9, y: 9 }), RAY) // first click of a third circle
    expect(tool.capturingInput()).toBe(true)
    typeLen(tool, '2')
    expect(scene.scene_undo).not.toHaveBeenCalled() // a fresh commit, not a retype
  })

  it('an intervening action makes the retype stale: a toast, nothing undone', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)
    scene.__bump()
    typeLen(tool, '3')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('circle'))
  })

  it('a face circle retypes through a fresh face draft with the new radius', () => {
    const scene = makeRetypeScene({ pick: makePick(7n, 3n), faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // centre
    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 0 }), { origin: [1, 0, 5], direction: [0, 0, -1] }) // rim, radius 1
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    typeLen(tool, '2.5')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(2)
    const call = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(call[2]).toBeCloseTo(2.5, 6) // radius argument
    expect(onFaceImprint).toHaveBeenCalledTimes(2)
  })
})

// Boundary-click fix: a click on an object's edge/vertex misses `pick_face`
// outright (strict polygon test at the boundary) — `_facePickAt` falls back
// to the ranked boundary pick (`FacePickCache.faceThrough`) instead of
// silently sending the whole gesture to the ground plane.
describe('CircleTool — boundary clicks (FacePickCache.faceThrough)', () => {
  /** `pick_face` misses on the exact base-ray direction (the boundary click)
   *  but hits `pick` on any other (nudged) direction — mirrors a real
   *  boundary miss where the ring probes around the ray find the face. */
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

    // The commit went through a FACE draft, never a plane draft.
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
describe('CircleTool — snapped face cursor (honours the chip, not ray∩plane)', () => {
  it('the rim commit lands on the snap, not the sub-millimeter-off ray∩plane point', () => {
    // Face at z=1, normal +Z.
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), RAY) // centre
    // The rim click's snap sits exactly 3m out; the ray it travelled along
    // would land 5mm further out on the SAME plane — a deliberately
    // different point the fix must NOT use.
    tool.onPointerDown(
      makeSnap({ x: 3, y: 0, z: 1, kind: 'endpoint' }),
      { origin: [3.005, 0, 5], direction: [0, 0, -1] },
    )

    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    const call = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[0]
    // Radius argument: exactly 3 (the snap), not ~3.005 (the ray∩plane miss).
    expect(call[2]).toBeCloseTo(3, 6)
    const seg = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls[0]
    // vertex 0 of the loop (first segment's start) is the rim point itself.
    expect(seg[1]).toBeCloseTo(3, 6)
    expect(seg[2]).toBeCloseTo(0, 6)
  })
})

// Shift-pinned drawing plane (GitHub issue 14 / planePin.ts): pressing Shift
// while hovering a face pins that face's plane for the next gesture, even
// once the cursor leaves the face entirely.
describe('CircleTool — Shift-pinned drawing plane (GitHub issue 14)', () => {
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

    // Idle hover over the face.
    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    // The pin constrains the snap even over empty space, far from the face.
    const emptyRay: Ray = { origin: [10, 10, 5], direction: [0, 0, -1] }
    expect(tool.snapConstraint(emptyRay)?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })

    // A first click over empty space anchors PLANE mode on the pinned plane
    // — never the face-split path.
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

    // Autorepeat: further `true` calls without a `false` in between are inert.
    tool.setShiftHeld(true)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(false) // physical key-up
    tool.setShiftHeld(true) // second physical press: releases the pin
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


describe('CircleTool — a clicked radius is exactly the displayed radius', () => {
  // These pin the Exact digits (9.399 mm); the default mm rounding is coarser.
  beforeAll(() => setPrecision('exact', 'mm'))
  afterAll(() => setPrecision(DEFAULT_PRECISION.mm, 'mm'))
  const prev = getLengthUnit()
  const rim = 0.0123456 // shows "R 12.346 mm" at Exact
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
      const typed = run('ground', '12.346')
      expect(clicked.measure).toHaveBeenCalledWith('R 12.346 mm')
      expect(clicked.calls.length).toBeGreaterThan(0)
      expect(clicked.calls).toEqual(typed.calls)
      expect(clicked.calls[0][1]).toBe(12.346 * 0.001)
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

// #51a audit: the circle's plane is fixed by the center click, and the
// cursor only picks the start angle, so a Blue hover straight over a ground
// center (which flattens onto the center) still draws the typed radius on
// the ground, from the +X default. Pinned so it can't regress to silence.
describe('CircleTool — typed radius with the cursor on the Blue axis (#51a)', () => {
  it('draws the typed radius on the ground plane instead of doing nothing', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 2, z: 3, kind: 'on-axis', direction: [0, 0, 1] }), RAY)
    tool.onKey(makeKeyEvent('2'))
    tool.onKey(makeKeyEvent('Enter'))

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect([calls[0][1], calls[0][2], calls[0][3]]).toEqual([3, 2, 0])
    for (const c of calls) {
      expect(c[3]).toBe(0)
      expect(Math.hypot((c[1] as number) - 1, (c[2] as number) - 2)).toBeCloseTo(2, 9)
    }
  })
})

// #43: a circle on a face that touches or crosses the face's own edge is not
// the tool's to refuse. The tool hands the whole circle to ONE face draft and
// the kernel arranges it (a lens and the rest when it crosses, kept drawing
// when it only touches at one point), so the old `LoopNotStrictlyInside`
// toast is unreachable from a circle on a face.
describe('CircleTool — a circle touching or crossing the face edge (#43)', () => {
  // A 10 x 10 face on z = 0 from (0, 0) to (10, 10), normal +Z.
  function drawOnFace(center: [number, number], rim: Snap, keptAsDrawing = false) {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    if (keptAsDrawing) {
      // The kernel's answer for an island the face cannot hold (a sliver):
      // the report lists it as kept drawing.
      const end = scene.draft_end as unknown as (d: bigint) => string
      const kept = vi.fn((d: bigint) => {
        const raw = JSON.parse(end(d)) as Record<string, unknown>
        raw.objects = []
        raw.sketches = [11]
        raw.kept_as_sketch = [[[5, 0, 0], [5.4, 0.04, 0]]]
        return JSON.stringify(raw)
      })
      ;(scene as unknown as { draft_end: typeof kept }).draft_end = kept
    }
    const made = makeTool(scene)
    made.tool.setEditContext({ kind: 'object', id: 7n })
    made.tool.onPointerDown(makeSnap({ x: center[0], y: center[1], z: 0 }), {
      origin: [center[0], center[1], 5],
      direction: [0, 0, -1],
    })
    made.tool.onPointerDown(rim, { origin: [rim.x, rim.y, 5], direction: [0, 0, -1] })
    return { scene, ...made }
  }

  it('a rim snapped onto the face edge (tangent) commits one face draft, no toast', () => {
    // Center 3 above the bottom edge, rim at the foot of the perpendicular:
    // the circle is tangent to the edge at its rim vertex.
    const { scene, onFaceImprint, onToast } = drawOnFace(
      [5, 3],
      makeSnap({ x: 5, y: 0, z: 0, kind: 'on-edge', object: 7n, elementKind: 'edge' }),
    )
    // The face held it here (a mock report with no kept drawing): no toast.
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(3))
    // Vertex 0 is the snapped edge point, exactly.
    const first = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls[0]
    expect([first[1], first[2], first[3]]).toEqual([5, 0, 0])
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a rim past the face edge (crossing it) commits one face draft, no toast', () => {
    const { scene, onFaceImprint, onToast } = drawOnFace(
      [5, 1],
      makeSnap({ x: 5, y: -2, z: 0, kind: 'ground' }),
    )
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    const curve = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(curve[2]).toBeCloseTo(3, 9)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a circle the kernel keeps as drawing (a sliver) toasts once at commit, saying why', () => {
    const { scene, onFaceImprint, onCommit, onToast } = drawOnFace(
      [5, 3],
      makeSnap({ x: 5, y: 0, z: 0, kind: 'on-edge', object: 7n, elementKind: 'edge' }),
      true,
    )
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledWith(circleKeptAsDrawingMessage())
    // Still a commit: the drawing landed in the object's owned sketch.
    expect(onFaceImprint).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('CircleTool — X-ray: a hidden snap off the face drops onto it, disclosed (cursorOnFrozenPlane)', () => {
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

describe('CircleTool — X-ray: a hidden point that is no part of the face, clicked first, drops onto the face (firstPointOnFace)', () => {
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
    // Centered on the dropped point: every rim vertex is equally far from it.
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
