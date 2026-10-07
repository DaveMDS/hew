import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RectangleTool } from './RectangleTool'
import type { Snap } from './types'
import { draftMock } from './draftMock'
import { setLengthUnit, getLengthUnit } from '../settings/units'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

/** A ray straight down (−Z) through world (x, y) — hits a z=1 top face at (x, y, 1). */
function rayThrough(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makePick(object: bigint, face: bigint, instance?: bigint) {
  return {
    object: () => object,
    face: () => face,
    depth: () => 1,
    instance: () => instance,
    free: vi.fn(),
  }
}

/** Minimal WasmScene stub — only the members RectangleTool calls. */
function makeWasmScene(opts: {
  pick?: () => ReturnType<typeof makePick> | undefined
  /** node_parent(0, id) result per object (a grouped object's group id). */
  parents?: Map<bigint, bigint>
} = {}): WasmScene {
  return {
    history_generation: vi.fn(() => 1n),
    ...draftMock().members,
    pick_face: vi.fn(() => opts.pick?.()),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])), // every minted sketch is on the ground plane
    node_parent: vi.fn((_kind: number, id: bigint) => opts.parents?.get(id)),
    // A top face at z=1, normal +Z.
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0])), // translated +5 in x
  } as unknown as WasmScene
}

/** The four corners (segment start points) of the nth draft's rectangle as a
 *  flat xyz Float64Array — the loop a face draft carries, now read from its
 *  four `draft_add_segment` calls (each draft adds exactly four). */
function draftLoop(scene: WasmScene, nth = 0): Float64Array {
  const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls.slice(nth * 4, nth * 4 + 4)
  expect(calls).toHaveLength(4)
  const out = new Float64Array(12)
  calls.forEach((c, i) => {
    out[i * 3] = c[1] as number
    out[i * 3 + 1] = c[2] as number
    out[i * 3 + 2] = c[3] as number
  })
  return out
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new RectangleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement }
}

// Deliberate contract change (selection-UX overhaul): drawing on a PLAIN
// solid's face at the top level no longer requires double-clicking into the
// object first — clicking its face with a draw tool means "draw on that
// face". Groups and Components keep the explicit edit step.
describe('RectangleTool — top-level draw-on-face', () => {
  it('two clicks on a plain object\'s face draw on it via one draft_begin_face draft (no edit context)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool, onFaceImprint, onToast } = makeTool(scene)

    // First corner on the face, then the opposite corner 1×2 away.
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))

    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    const [object, face] = (scene.draft_begin_face as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4) // 4 corners, one segment each
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    // No plane draft was opened.
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a face of a GROUPED object is drawn on as FREE drawing on its world plane (not the ground, not inside the group)', () => {
    const scene = makeWasmScene({
      pick: () => makePick(7n, 3n),
      parents: new Map([[7n, 5n]]), // object 7 lives inside group 5
    })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))

    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    // The face's world plane z = 1 with its +Z normal — not the ground.
    expect((scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0].slice(0, 6)).toEqual([0, 0, 1, 0, 0, 1])
    expect(scene.draft_begin_plane_in_instance).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4) // free rectangle on the plane
    expect(tool.snapProjected()).toBe(false) // reads "On Face", not "On Face Projected"
  })

  it('a face of a component instance is drawn on as FREE drawing on its world plane (pose applied, no instance draft)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, 12n) })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 5, y: 0, z: 1, kind: 'face' }), rayThrough(5, 0))
    tool.onPointerDown(makeSnap({ x: 6, y: 2, z: 1, kind: 'face' }), rayThrough(6, 2))

    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    // The face plane z = 1 of the instance (translated +5 in x), in WORLD space.
    const a = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0].slice(0, 6) as number[]
    expect(a[2]).toBeCloseTo(1)
    expect(a.slice(3)).toEqual([0, 0, 1])
    expect(scene.draft_begin_plane_in_instance).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
  })

  it('idle snapConstraint over a GROUPED object\'s face locks to its world plane so the chip reads On Face', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n), parents: new Map([[7n, 5n]]) })
    const { tool } = makeTool(scene)
    expect(tool.snapConstraint(rayThrough(0, 0))?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })
  })

  it.each([
    ['GROUPED', () => makeWasmScene({ pick: () => makePick(7n, 3n), parents: new Map([[7n, 5n]]) }), 0],
    ['instanced', () => makeWasmScene({ pick: () => makePick(7n, 3n, 12n) }), 5],
  ])('a first click ON the corner of a %s top draws free on its world plane, not the ground', (_n, mk, dx) => {
    const scene = mk()
    // The plain ray MISSES at the corner (strict polygon test); only the
    // nudged boundary probes hit the face.
    const plain = rayThrough(dx, 0).direction
    const hit = (scene.pick_face as ReturnType<typeof vi.fn>).getMockImplementation()!
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation((...a: number[]) =>
      a[3] === plain[0] && a[4] === plain[1] && a[5] === plain[2] ? undefined : (hit as (...x: number[]) => unknown)(...a))
    const { tool } = makeTool(scene)
    const corner = makeSnap({ x: dx, y: 0, z: 1, kind: 'endpoint', object: 7n, elementKind: 'vertex' })
    tool.onPointerDown(corner, rayThrough(dx, 0))
    tool.onPointerDown(makeSnap({ x: dx + 1, y: 2, z: 1, kind: 'face' }), rayThrough(dx + 1, 2))
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    const a = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0].slice(0, 6) as number[]
    expect(a[2]).toBeCloseTo(1)
    expect(a.slice(3)).toEqual([0, 0, 1])
    expect(scene.draft_begin_plane_in_instance).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
  })

  it('idle snapConstraint locks to a plain object\'s face plane so the first corner lands on it', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool } = makeTool(scene)

    const constraint = tool.snapConstraint(rayThrough(0, 0))
    expect(constraint?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })
  })

  it('a mid-gesture GROUND rectangle is not hijacked by hovering a face for the second corner', () => {
    let hovering = false
    const scene = makeWasmScene({ pick: () => (hovering ? makePick(7n, 3n) : undefined) })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0)) // ground anchor
    hovering = true // cursor drifts over a solid mid-gesture
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), rayThrough(1, 2))

    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4) // stayed a ground rectangle
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
  })

  it('inside an entered object context only that object\'s faces are drawable (unchanged)', () => {
    const scene = makeWasmScene({ pick: () => makePick(999n, 3n) })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), rayThrough(0, 0))

    // Ignored outright — no face anchor, and no plane draft either.
    expect(tool.capturingInput()).toBe(false)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
  })
})

describe('RectangleTool — instance editing context (component-edit-parity.md phase A2)', () => {
  const INSTANCE = 42n
  const COMPONENT = 5n

  it('face mode routes to draft_begin_face_in_instance, never the world draft_begin_face', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, INSTANCE) })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))

    expect(scene.draft_begin_face_in_instance).toHaveBeenCalledTimes(1)
    const [instance, object, face] = (scene.draft_begin_face_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(instance).toBe(INSTANCE)
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space opens a plane draft in the instance via draft_begin_plane_in_instance', () => {
    const scene = makeWasmScene({ pick: () => undefined })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), rayThrough(6, 1))
    tool.onPointerDown(makeSnap({ x: 7, y: 3, z: 0 }), rayThrough(7, 3))

    expect(scene.draft_begin_plane_in_instance).toHaveBeenCalledTimes(1)
    expect((scene.draft_begin_plane_in_instance as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(INSTANCE)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
    // Points go straight through in WORLD space — the engine maps them into
    // the definition through the instance pose itself (no toLocal here).
    const xs: number[] = []
    for (const call of (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls) {
      xs.push(call[1] as number, call[4] as number)
    }
    expect(Math.min(...xs)).toBe(6)
    expect(Math.max(...xs)).toBe(7)
  })

  // The face_normal-as-world-space finding: every OTHER instance-context test
  // in this file uses a translation-only pose, where the LOCAL normal
  // face_normal reports happens to equal the WORLD one — a mapping bug would
  // go unnoticed. This one genuinely rotates the instance (90° about X),
  // turning the member face's local +Z normal into world −Y — before the
  // fix, the tool used the raw local (0,0,1) normal directly and would have
  // drawn the loop into the WRONG (Z-constant) plane; after it, the loop
  // lands in the correctly posed (Y-constant) plane.
  it('face mode poses the LOCAL face_normal into WORLD space through a rotated instance pose', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, INSTANCE) })
    ;(scene.instance_pose as ReturnType<typeof vi.fn>).mockReturnValue(
      new Float64Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0]),
    )
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    // Anchor at world (0,5,1) — on the posed (Y=5) plane. Second click's ray
    // travels along +Y from (2,0,3), landing on the SAME plane at (2,5,3):
    // a nonzero, non-degenerate rectangle in BOTH in-plane directions.
    tool.onPointerDown(makeSnap({ x: 0, y: 5, z: 1, kind: 'face' }), {
      origin: [0, 0, 1],
      direction: [0, 1, 0],
    })
    tool.onPointerDown(makeSnap({ x: 2, y: 5, z: 3, kind: 'face' }), {
      origin: [2, 0, 3],
      direction: [0, 1, 0],
    })

    expect(scene.draft_begin_face_in_instance).toHaveBeenCalledTimes(1)
    const loopPts = draftLoop(scene)
    const ys: number[] = []
    for (let i = 1; i < loopPts.length; i += 3) ys.push(loopPts[i])
    // Every corner lies in the posed Y=5 plane — proof the normal was
    // actually mapped through the pose, not left at the raw local (0,0,1).
    for (const y of ys) expect(y).toBeCloseTo(5, 9)
  })
})

// Post-commit dimension retype (SketchUp: click both corners, then type
// `W,D` + Enter and the rectangle you just drew redraws to that size).
describe('RectangleTool — retype dimensions after the second click', () => {
  /** The base stub plus the history surface the retype window uses: a
   *  generation that moves on every recorded action, undo, and redo, like
   *  the kernel's. `draft_add_segment` bumps it once per gesture is more
   *  than the tool needs — one bump per commit is what matters. */
  function makeRetypeScene(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const base = makeWasmScene(opts) as unknown as Record<string, unknown>
    let gen = 1n
    let addCalls = 0
    let failAddAt = -1
    const baseAdd = base.draft_add_segment as (...args: unknown[]) => unknown
    const baseEnd = base.draft_end as (...args: unknown[]) => unknown
    const scene = {
      ...base,
      history_generation: vi.fn(() => gen),
      draft_add_segment: vi.fn((...args: unknown[]) => {
        addCalls += 1
        if (addCalls === failAddAt) throw new Error('PointOffPlane: nope')
        return baseAdd(...args)
      }),
      /** Test hook: the Nth `draft_add_segment` call overall is refused. */
      __failAddAt: (n: number) => { failAddAt = n },
      // A draft that ends records ONE step; a refused draft is cancelled
      // (draft_cancel) and records nothing.
      draft_end: vi.fn((...args: unknown[]) => { const r = baseEnd(...args); gen += 1n; return r }),
      scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      /** Test hook: an unrelated recorded action. */
      __bump: () => { gen += 1n },
    }
    return scene as unknown as WasmScene & { __bump(): void; __failAddAt(n: number): void }
  }

  function key(tool: RectangleTool, k: string) {
    tool.onKey({ key: k } as KeyboardEvent)
  }

  function typeDims(tool: RectangleTool, text: string) {
    for (const ch of text) key(tool, ch)
    key(tool, 'Enter')
  }

  /** The (x, y) corners of the last four `draft_add_segment` calls. */
  function lastRectangle(scene: WasmScene): [number, number][] {
    const calls = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
    return calls.slice(-4).map((c) => [c[1] as number, c[2] as number])
  }

  function drawGround(tool: RectangleTool, a: [number, number], b: [number, number]) {
    tool.onPointerDown(makeSnap({ x: a[0], y: a[1], z: 0 }), rayThrough(a[0], a[1]))
    tool.onPointerDown(makeSnap({ x: b[0], y: b[1], z: 0 }), rayThrough(b[0], b[1]))
  }

  it('is closed before any rectangle exists — digits are not captured', () => {
    const { tool } = makeTool(makeRetypeScene())
    expect(tool.capturesKey('5')).toBe(false)
    expect(tool.hasArmedGesture()).toBe(false)
  })

  it('after a two-click ground rectangle, typing W,D + Enter undoes it once and redraws it at that size, growing the same way', () => {
    const scene = makeRetypeScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)
    // Second corner toward −x, −y: the retyped rectangle must grow that way too.
    drawGround(tool, [1, 1], [0, -1])
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(tool.statusHint()).toContain('resize')

    // A digit opens the window; the readout shows the buffer.
    expect(tool.capturesKey('2')).toBe(true)
    typeDims(tool, '2,3')
    expect(onMeasurement).toHaveBeenCalledWith(expect.stringContaining('2'))

    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(8)
    // Anchor (1,1), far corner (1−2, 1−3) = (−1, −2).
    const xs = lastRectangle(scene).map((c) => c[0])
    const ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.min(...xs)).toBeCloseTo(-1, 9)
    expect(Math.max(...xs)).toBeCloseTo(1, 9)
    expect(Math.min(...ys)).toBeCloseTo(-2, 9)
    expect(Math.max(...ys)).toBeCloseTo(1, 9)
    expect(onCommit).toHaveBeenCalledTimes(2)
    // Readout cleared after the commit.
    expect(onMeasurement).toHaveBeenLastCalledWith('')
  })

  it('a single value makes a square; the window stays open so a second size can be typed', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 2])
    typeDims(tool, '5')
    let xs = lastRectangle(scene).map((c) => c[0])
    let ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.max(...xs)).toBeCloseTo(5, 9)
    expect(Math.max(...ys)).toBeCloseTo(5, 9)

    typeDims(tool, '1,4')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    xs = lastRectangle(scene).map((c) => c[0])
    ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.max(...xs)).toBeCloseTo(1, 9)
    expect(Math.max(...ys)).toBeCloseTo(4, 9)
  })

  it('with an empty buffer, letters and Space keep their global meaning; once a digit is in, the dimension grammar is captured', () => {
    const { tool } = makeTool(makeRetypeScene())
    drawGround(tool, [0, 0], [1, 1])
    for (const k of ['m', 'c', 'p', 'f', ' ', 'Enter', 'Backspace', ',']) {
      expect(tool.capturesKey(k)).toBe(false)
    }
    key(tool, '2')
    for (const k of ['m', ',', 'x', "'", '"', '/', 'Backspace', 'Enter', '5']) {
      expect(tool.capturesKey(k)).toBe(true)
    }
    // Space is the global reset-to-Select even with a buffer open.
    expect(tool.capturesKey(' ')).toBe(false)
    // Still not a tool-switch-blocking letter for keys outside the grammar.
    expect(tool.capturesKey('p')).toBe(false)
    expect(tool.capturesKey('q')).toBe(false)
    // An open buffer is an armed gesture for Escape's purposes.
    expect(tool.hasArmedGesture()).toBe(true)
  })

  it('the idle hover re-run after each captured key keeps the typed readout (the key router re-hovers)', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    onMeasurement.mockClear()
    tool.onPointerMove(makeSnap({ x: 2, y: 2, z: 0 }), rayThrough(2, 2))
    expect(onMeasurement).not.toHaveBeenCalledWith('')
    // Face-mode idle hover too.
    const faceScene = makeRetypeScene({ pick: () => makePick(7n, 3n) })
    const f = makeTool(faceScene)
    f.tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    f.tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))
    key(f.tool, '3')
    f.onMeasurement.mockClear()
    f.tool.onPointerMove(makeSnap({ x: 0.5, y: 0.5, z: 1, kind: 'face' }), rayThrough(0.5, 0.5))
    expect(f.onMeasurement).not.toHaveBeenCalledWith('')
  })

  it('Escape closes the window without touching the rectangle', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    key(tool, 'Escape')
    expect(onMeasurement).toHaveBeenLastCalledWith('')
    expect(tool.capturesKey('5')).toBe(false)
    expect(tool.hasArmedGesture()).toBe(false)
    // A stray Enter now does nothing.
    key(tool, 'Enter')
    expect(scene.scene_undo).not.toHaveBeenCalled()
  })

  it('a new first click closes the window; the digits then belong to the new rectangle', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    tool.onPointerDown(makeSnap({ x: 5, y: 5, z: 0 }), rayThrough(5, 5))
    expect(tool.capturingInput()).toBe(true) // anchored on the next rectangle
    typeDims(tool, '1,1')
    // The typed commit is a fresh rectangle from (5,5), not a retype.
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(8)
    expect(Math.min(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(5, 9)
  })

  it('disarmRetype (the host\'s explicit undo/redo/delete hook) closes the window quietly', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    tool.disarmRetype()
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('refuses the retype when the history generation moved (an intervening action) and says so', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    scene.__bump() // something else was recorded meanwhile
    typeDims(tool, '2,2')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('model changed'))
    // The window is gone.
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('a refused re-commit is rolled forward with a redo, so the original rectangle survives', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    const add = scene.draft_add_segment as ReturnType<typeof vi.fn>
    add.mockImplementationOnce(() => { throw new Error('PointOffPlane: nope') })
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledTimes(1)
    // Still open, re-stamped: a second attempt goes through.
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(2, 9)
  })

  // Semantic change under unified drafting: a re-commit is ONE draft, so a
  // refused segment cancels the whole draft (draft_cancel) and records NOTHING
  // — there is no longer a "partial step" to retract. The refusal therefore
  // rolls forward with a plain redo (the old test expected two undos and a
  // fresh redraw of the original).
  it('a refused later segment of the re-commit cancels the whole draft (atomic) and the original is restored with one redo', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    // First segment of the retry lands, the second (6th call overall, after
    // the 4 of the original draw) is refused: the draft is cancelled.
    scene.__failAddAt(6)
    typeDims(tool, '2,2')
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(scene.draft_cancel).toHaveBeenCalledTimes(1)
    // Only the original draft ever ended; the retry recorded nothing.
    expect(scene.draft_end).toHaveBeenCalledTimes(1)
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).toHaveBeenCalledTimes(1)
    // Still open: a good retype now goes through.
    typeDims(tool, '3,3')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(3, 9)
    expect(Math.max(...lastRectangle(scene).map((c) => c[1]))).toBeCloseTo(3, 9)
  })

  it('Escape with an open but untyped window is not armed: it closes the window quietly and is not consumed', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    expect(tool.hasArmedGesture()).toBe(false)
    key(tool, 'Escape')
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('a face rectangle retypes through a fresh face draft with the loop rebuilt on the face plane', () => {
    const scene = makeRetypeScene({ pick: () => makePick(7n, 3n) })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)

    typeDims(tool, '3,4')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(2)
    const [object, face] = (scene.draft_begin_face as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    const pts = draftLoop(scene, 1)
    const xs = [pts[0], pts[3], pts[6], pts[9]]
    const ys = [pts[1], pts[4], pts[7], pts[10]]
    const zs = [pts[2], pts[5], pts[8], pts[11]]
    expect(Math.min(...xs)).toBeCloseTo(0, 9)
    expect(Math.min(...ys)).toBeCloseTo(0, 9)
    // 3 × 4 on the +Z face: one extent is 3 and the other 4 (the face basis
    // fixes which axis is which; the growth direction is preserved either way).
    const extents = [Math.max(...xs), Math.max(...ys)].sort((a, b) => a - b)
    expect(extents[0]).toBeCloseTo(3, 9)
    expect(extents[1]).toBeCloseTo(4, 9)
    for (const z of zs) expect(z).toBeCloseTo(1, 9)
    expect(onFaceImprint).toHaveBeenCalledTimes(2)
  })

  it('a typed (Enter) commit arms the window too', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0))
    typeDims(tool, '1,1')
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(2, 9)
  })
})

describe('RectangleTool — clicks on an edge or corner adopt the face through that point (inference-permissiveness fixes)', () => {
  /** `pick_face` misses on the exact ray (strict at the boundary) but hits
   *  face 3 of object 7 for any nudged direction — the boundary probe ring. */
  function boundaryScene(opts: { facePlane?: [number, number, number, number, number, number] } = {}) {
    const scene = makeWasmScene()
    const plane = opts.facePlane ?? [0, 0, 1, 0, 0, 1]
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) =>
        dx === 0 && dy === 0 && dz === -1 ? undefined : makePick(7n, 3n),
    )
    ;(scene.face_plane as ReturnType<typeof vi.fn>).mockImplementation(() => new Float64Array(plane))
    ;(scene.face_normal as ReturnType<typeof vi.fn>).mockImplementation(() => new Float64Array(plane.slice(3)))
    return scene
  }

  it('a first click on an edge midpoint (the ray itself misses every face) anchors FACE mode on the neighbouring face, not the ground', () => {
    const scene = boundaryScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(
      makeSnap({ x: 0.5, y: 0, z: 1, kind: 'midpoint', object: 7n, element: 11n, elementKind: 'edge' }),
      rayThrough(0.5, 0),
    )
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 1, kind: 'endpoint', object: 7n, element: 2n, elementKind: 'vertex' }), rayThrough(1, 1))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_plane).not.toHaveBeenCalled()
  })

  it('a probed neighbour whose plane does NOT hold the snapped point is rejected (falls through to plane mode)', () => {
    const scene = boundaryScene({ facePlane: [0, 0, 5, 0, 0, 1] }) // a face at z = 5, not through the snap
    const { tool } = makeTool(scene)
    tool.onPointerDown(
      makeSnap({ x: 0.5, y: 0, z: 0, kind: 'midpoint', object: 7n, element: 11n, elementKind: 'edge' }),
      rayThrough(0.5, 0),
    )
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), rayThrough(1, 1))
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
  })

  it('a non-boundary snap over a miss stays in plane mode — the ring probe only runs for object vertices/edges', () => {
    const scene = boundaryScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0.5, y: 0, z: 0, kind: 'ground' }), rayThrough(0.5, 0))
    expect(scene.pick_face).toHaveBeenCalledTimes(1)
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), rayThrough(1, 1))
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
  })

  it('Shift over an edge midpoint pins the FACE that edge belongs to, not the ground the plain pick fell through to', () => {
    const scene = boundaryScene({ facePlane: [0, 0, 0, 0, 1, 0] }) // a vertical wall, plane y = 0
    const { tool } = makeTool(scene)
    const edgeRay = rayThrough(0.5, 0)
    tool.snapConstraint(edgeRay)
    tool.onPointerMove(makeSnap({ x: 0.5, y: 0, z: 0.5, kind: 'midpoint', object: 7n, element: 11n, elementKind: 'edge' }), edgeRay)
    tool.setShiftHeld(true); tool.setShiftHeld(false)
    expect(tool.statusHint()).toMatch(/Pinned/)
    expect(tool.snapConstraint(rayThrough(5, 5))?.constraintPlane).toEqual({ point: [0, 0, 0], normal: [0, 1, 0] })
  })
})

describe('RectangleTool — face mode honours the snap (the chip and the rectangle agree)', () => {
  it('the opposite corner lands on the snapped Endpoint exactly, not on the ray\'s own plane hit a few mm off', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face' }), rayThrough(0, 0))
    // The cursor ray pierces the plane at (1.004, 2.003) but the kernel
    // snapped the corner at (1, 2) — the corner wins.
    tool.onPointerDown(
      makeSnap({ x: 1, y: 2, z: 1, kind: 'endpoint', object: 7n, element: 2n, elementKind: 'vertex' }),
      rayThrough(1.004, 2.003),
    )
    const pts = Array.from(draftLoop(scene))
    expect(pts.slice(6, 9)).toEqual([1, 2, 1]) // the far corner
  })

  it('with no snap the ray∩plane point is still used (past the face\'s extent)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face' }), rayThrough(0, 0))
    tool.onPointerDown(null, rayThrough(1.5, 2.5))
    const pts = Array.from(draftLoop(scene))
    expect(pts[6]).toBeCloseTo(1.5)
    expect(pts[7]).toBeCloseTo(2.5)
    expect(pts[8]).toBeCloseTo(1)
  })
})

describe('RectangleTool — Shift pins the hovered plane (GitHub issue 14)', () => {
  it('Shift over a face pins its plane: hovers elsewhere are constrained to it and the first click anchors PLANE mode on it', () => {
    const scene = makeWasmScene({ pick: () => undefined })
    const faceRay = rayThrough(0, 0)
    // Over the face: pick hits, plane at z=1. Everywhere else: nothing.
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementationOnce(() => makePick(7n, 3n))
    const { tool } = makeTool(scene)
    tool.snapConstraint(faceRay)
    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face', object: 7n, element: 3n, elementKind: 'face' }), faceRay)

    tool.setShiftHeld(true)
    tool.setShiftHeld(false)
    expect(tool.statusHint()).toMatch(/Pinned/)
    expect(tool.hasArmedGesture()).toBe(true)

    // Off the face, over empty ground: still constrained to the face plane.
    const groundRay = rayThrough(5, 5)
    expect(tool.snapConstraint(groundRay)?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })

    // The gesture lands on that plane as a sketch, not as a face imprint
    // and not on the ground.
    tool.onPointerDown(makeSnap({ x: 5, y: 5, z: 1, kind: 'plane' }), groundRay)
    expect(tool.statusHint()).toMatch(/opposite corner/)
    tool.onPointerDown(makeSnap({ x: 6, y: 7, z: 1, kind: 'plane' }), rayThrough(6, 7))
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    // One plane draft on the pinned z = 1 plane (not the ground, not a face).
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    const begin = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(begin[2]).toBeCloseTo(1, 9)
    expect(begin.slice(3, 6)).toEqual([0, 0, 1])
    expect(scene.draft_add_segment).toHaveBeenCalledTimes(4)
    const seg = (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(seg.slice(1, 7)).toEqual([5, 5, 1, 6, 5, 1])

    // The pin survives the completed gesture (like the arrow lock) …
    expect(tool.statusHint()).toMatch(/Pinned/)
    // … a second Shift press releases it; keydown autorepeat never toggles.
    tool.setShiftHeld(true)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).not.toMatch(/Pinned/)
    tool.setShiftHeld(false)
    expect(tool.snapConstraint(groundRay)).toBeNull()
  })

  it('Escape while idle releases the pin; an arrow lock displaces it; Escape mid-gesture keeps it (like the arrow lock)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool } = makeTool(scene)
    const faceRay = rayThrough(0, 0)
    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face' }), faceRay)
    tool.setShiftHeld(true); tool.setShiftHeld(false)
    expect(tool.statusHint()).toMatch(/Pinned/)
    // Mid-gesture Escape aborts the rectangle but keeps the pin.
    tool.onPointerDown(makeSnap({ x: 5, y: 5, z: 1, kind: 'plane' }), rayThrough(5, 5))
    expect(tool.statusHint()).toMatch(/opposite corner/)
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(tool.statusHint()).toMatch(/Pinned/)
    // Idle Escape releases it.
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(tool.statusHint()).not.toMatch(/Pinned/)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'on-face' }), faceRay)
    tool.setShiftHeld(true); tool.setShiftHeld(false)
    expect(tool.statusHint()).toMatch(/Pinned/)
    tool.onKey({ key: 'ArrowUp' } as KeyboardEvent)
    expect(tool.statusHint()).toMatch(/Locked to the blue plane/)
    expect(tool.statusHint()).not.toMatch(/Pinned/)
  })
})

// A typed W,D right after the first click — before the cursor has moved off
// the anchor (a click on a snapped guide intersection leaves it exactly
// there) — grows the way the face reads on screen: right and up as seen from
// outside it, +X then +Y on a horizontal face. It must not depend on the
// arbitrary handedness of the face's basis axes, which on a −Y wall points
// the width toward −X (off the left end of a face the click sits near).
describe('RectangleTool — typed size before any cursor movement grows right and up', () => {
  function typeOnFace(normal: [number, number, number], anchor: V3Tuple) {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    ;(scene.face_normal as ReturnType<typeof vi.fn>).mockReturnValue(new Float64Array(normal))
    ;(scene.face_plane as ReturnType<typeof vi.fn>).mockReturnValue(new Float64Array([...anchor, ...normal]))
    const { tool } = makeTool(scene)
    tool.onPointerDown(
      makeSnap({ x: anchor[0], y: anchor[1], z: anchor[2], kind: 'face' }),
      { origin: [anchor[0] - normal[0] * 5, anchor[1] - normal[1] * 5, anchor[2] - normal[2] * 5], direction: [normal[0] * -1, normal[1] * -1, normal[2] * -1] },
    )
    for (const ch of '3,2') tool.onKey({ key: ch } as KeyboardEvent)
    tool.onKey({ key: 'Enter' } as KeyboardEvent)
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    const pts = draftLoop(scene)
    const axis = (k: number) => [pts[k], pts[3 + k], pts[6 + k], pts[9 + k]]
    const range = (k: number): [number, number] => [Math.min(...axis(k)), Math.max(...axis(k))]
    return { x: range(0), y: range(1), z: range(2) }
  }
  type V3Tuple = [number, number, number]

  it('on a −Y wall (the front face) the width grows toward +X and the height toward +Z', () => {
    const r = typeOnFace([0, -1, 0], [1, 0, 1])
    expect(r.x[0]).toBeCloseTo(1, 9)
    expect(r.x[1]).toBeCloseTo(4, 9)
    expect(r.z[0]).toBeCloseTo(1, 9)
    expect(r.z[1]).toBeCloseTo(3, 9)
  })

  it('on a +Y wall (seen from behind) the width grows toward −X, which is right as seen from outside', () => {
    const r = typeOnFace([0, 1, 0], [1, 0, 1])
    expect(r.x[0]).toBeCloseTo(-2, 9)
    expect(r.x[1]).toBeCloseTo(1, 9)
    expect(r.z[1]).toBeCloseTo(3, 9)
  })

  it('on a +X wall the width grows toward +Y and the height toward +Z', () => {
    const r = typeOnFace([1, 0, 0], [0, 1, 1])
    expect(r.y[0]).toBeCloseTo(1, 9)
    expect(r.y[1]).toBeCloseTo(4, 9)
    expect(r.z[0]).toBeCloseTo(1, 9)
    expect(r.z[1]).toBeCloseTo(3, 9)
  })

  it('on a top face the width grows toward +X and the depth toward +Y, like the ground', () => {
    const r = typeOnFace([0, 0, 1], [1, 1, 0])
    expect(r.x[0]).toBeCloseTo(1, 9)
    expect(r.x[1]).toBeCloseTo(4, 9)
    expect(r.y[0]).toBeCloseTo(1, 9)
    expect(r.y[1]).toBeCloseTo(3, 9)
  })
})


describe('RectangleTool — a clicked value is exactly the displayed value', () => {
  const calls = (scene: WasmScene) => (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls
  const corners = (scene: WasmScene) => calls(scene).slice(-4).map((c) => [c[1] as number, c[2] as number, c[3] as number])
  const prev = getLengthUnit()
  function withMm<T>(fn: () => T): T {
    setLengthUnit('mm')
    try {
      return fn()
    } finally {
      setLengthUnit(prev)
    }
  }

  it('free ground click at an off-grid cursor commits the same corners as typing "9.4,3.8"', () => {
    withMm(() => {
      const clicked = makeWasmScene()
      const a = makeTool(clicked)
      a.tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), rayThrough(1, 1))
      a.tool.onPointerMove(makeSnap({ x: 1.00939876, y: 1.00378732, z: 0 }), rayThrough(1.00939876, 1.00378732))
      a.tool.onPointerDown(makeSnap({ x: 1.00939876, y: 1.00378732, z: 0 }), rayThrough(1.00939876, 1.00378732))
      expect(a.onMeasurement).toHaveBeenCalledWith('9.4 mm × 3.8 mm')

      const typed = makeWasmScene()
      const b = makeTool(typed)
      b.tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), rayThrough(1, 1))
      b.tool.onPointerMove(makeSnap({ x: 1.00939876, y: 1.00378732, z: 0 }), rayThrough(1.00939876, 1.00378732))
      for (const ch of '9.4,3.8') b.tool.onKey({ key: ch } as KeyboardEvent)
      b.tool.onKey({ key: 'Enter' } as KeyboardEvent)

      expect(calls(clicked).length).toBe(4)
      expect(corners(clicked)).toEqual(corners(typed))
      // Bit-for-bit: far corner offset equals the typed 9.4 mm / 3.8 mm.
      const xs = corners(clicked).map((c) => c[0])
      expect(Math.max(...xs)).toBe(1 + 9.4 * 0.001)
    })
  })

  it('a hard-snapped (endpoint) ground click keeps the snapped point unchanged', () => {
    withMm(() => {
      const scene = makeWasmScene()
      const { tool } = makeTool(scene)
      tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), rayThrough(1, 1))
      tool.onPointerDown(makeSnap({ x: 1.00939876, y: 1.00378732, z: 0, kind: 'endpoint' }), rayThrough(1.00939876, 1.00378732))
      const far = corners(scene)[2]
      expect(far[0]).toBe(1.00939876)
      expect(far[1]).toBe(1.00378732)
    })
  })

  it('free face click commits the displayed extents; endpoint keeps the point', () => {
    withMm(() => {
      const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
      const { tool } = makeTool(scene)
      tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
      const s = makeSnap({ x: 0.00939876, y: 0.00378732, z: 1, kind: 'on-face' })
      tool.onPointerMove(s, rayThrough(s.x, s.y))
      tool.onPointerDown(s, rayThrough(s.x, s.y))
      const loop = draftLoop(scene)
      const xs = [0, 3, 6, 9].map((i) => loop[i])
      const ys = [1, 4, 7, 10].map((i) => loop[i])
      expect(Math.max(...xs)).toBe(9.4 * 0.001)
      expect(Math.max(...ys)).toBe(3.8 * 0.001)

      const scene2 = makeWasmScene({ pick: () => makePick(7n, 3n) })
      const t2 = makeTool(scene2).tool
      t2.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
      const e = makeSnap({ x: 0.00939876, y: 0.00378732, z: 1, kind: 'endpoint' })
      t2.onPointerMove(e, rayThrough(e.x, e.y))
      t2.onPointerDown(e, rayThrough(e.x, e.y))
      const loop2 = draftLoop(scene2)
      expect(Math.max(...[0, 3, 6, 9].map((i) => loop2[i]))).toBe(0.00939876)
    })
  })
})
