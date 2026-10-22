/**
 * Arc re-homing on the Blue axis — Arc acts like Line (LineTool's
 * `_isStraightOverAnchor`, LineTool.groundVerticalLock.test.ts): with A on
 * the ground and no arrow lock, a cursor straight above A (the Blue-axis
 * inference) used to flatten onto A itself. A typed chord then only toasted
 * about the arrow keys and a click was dropped as a zero chord. The chord
 * now goes straight up, and the bulge continues on a vertical plane through
 * it — the plane Line's re-home picks for a first segment.
 *
 * The draft mock enforces plane membership (`enforcePlane`, the kernel's
 * `PointOffPlane` line), so an arc committed on the wrong plane fails here
 * the way it would in the kernel.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { ArcTool } from './ArcTool'
import { draftMock } from './draftMock'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { formatLength } from '../settings/units'

// Looking down and toward +Y, as an orbit camera does: the view-facing
// vertical plane through a vertical chord has normal +Y.
const RAY: Ray = { origin: [1, -5, 5], direction: [0, Math.SQRT1_2, -Math.SQRT1_2] }

const ground = (x: number, y: number): Snap => ({ x, y, z: 0, kind: 'ground' })
const blue = (x: number, y: number, z: number): Snap =>
  ({ x, y, z, kind: 'on-axis', direction: [0, 0, 1] })

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, repeat: false, preventDefault: () => { /* no-op */ } } as unknown as KeyboardEvent
}

function typeDigits(tool: ArcTool, s: string): void {
  for (const ch of s) tool.onKey(makeKeyEvent(ch))
}

function makeScene() {
  const dm = draftMock({ enforcePlane: true })
  // Every ended draft is one history step, and undo is one more — enough
  // for the post-commit retype window (retypeWindow.ts).
  let gen = 1n
  const baseEnd = dm.members.draft_end.getMockImplementation()!
  dm.members.draft_end.mockImplementation((...args: Parameters<typeof baseEnd>) => {
    const r = baseEnd(...args)
    gen += 1n
    return r
  })
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => gen),
    node_parent: vi.fn(() => undefined),
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => undefined),
    scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    ...dm.members,
  }
  return { scene: scene as unknown as WasmScene, log: dm.log }
}

function makeTool(scene: WasmScene) {
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new ArcTool(scene, new THREE.Group(), onCommit, onToast, vi.fn(), onMeasurement)
  return { tool, onCommit, onToast, onMeasurement }
}

const OFF_PLANE =
  'An arc stays on its drawing plane. Move the cursor along the plane, or press an arrow key to change it, then type the length.'

/** [origin, normal] of every `draft_begin_plane`. */
function planes(log: ReturnType<typeof makeScene>['log']): number[][] {
  return log.begins.map((b) => (b.args as number[]).slice(0, 6))
}

describe('ArcTool — a chord straight up the Blue axis from a ground A', () => {
  it('the chord stage on the ground offers the soft axes through A, so Blue can be hovered at all', () => {
    const { scene } = makeScene()
    const { tool } = makeTool(scene)

    expect(tool.snapConstraint(RAY)).toBeNull()                       // idle: nothing to infer from
    tool.onPointerDown(ground(1, 2), RAY)
    expect(tool.snapConstraint(RAY)).toEqual({ anchor: [1, 2, 0] })  // chord: A anchors Red, Green, Blue
    tool.onPointerDown(ground(4, 2), RAY)
    expect(tool.snapConstraint(RAY)).toBeNull()                       // bulge on the ground: unchanged
  })

  it('a typed chord goes straight up and the arc commits on a vertical plane through it', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)        // A on the ground
    tool.onPointerMove(blue(1, 2, 3), RAY)       // Blue, straight up from A
    expect(tool.snapProjected()).toBe(false)     // the height is kept, not dropped
    typeDigits(tool, '5')
    tool.onKey(makeKeyEvent('Enter'))            // B = A + 5 up

    expect(onToast).not.toHaveBeenCalled()
    // The bulge is now held to the vertical plane through the chord.
    expect(tool.snapConstraint(RAY)?.constraintPlane?.normal).toEqual([0, 1, 0])

    tool.onPointerMove({ x: 2, y: 2, z: 2.5, kind: 'free' }, RAY)
    tool.onPointerDown({ x: 2, y: 2, z: 2.5, kind: 'free' }, RAY)

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[1, 2, 0, 0, 1, 0]])
    const first = log.segments[0]
    const last = log.segments[log.segments.length - 1]
    expect([first[0], first[1], first[2]]).toEqual([1, 2, 0])
    expect([last[3], last[4], last[5]]).toEqual([1, 2, 5])
    // Every facet stays on y = 2 and bulges toward +X, where the cursor was.
    for (const sg of log.segments) {
      expect(sg[1]).toBeCloseTo(2, 12)
      expect(sg[4]).toBeCloseTo(2, 12)
    }
    expect(Math.max(...log.segments.map((sg) => sg[3]))).toBeGreaterThan(1.5)
  })

  it('a click on the Blue axis places B there instead of being dropped as a zero chord', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerMove(blue(1, 2, 3), RAY)
    tool.onPointerDown(blue(1, 2, 3), RAY)       // B, on Blue
    expect(tool.snapConstraint(RAY)?.constraintPlane?.normal).toEqual([0, 1, 0])
    tool.onPointerDown({ x: 0.2, y: 2, z: 1.5, kind: 'free' }, RAY)

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[1, 2, 0, 0, 1, 0]])
    const last = log.segments[log.segments.length - 1]
    expect([last[3], last[4], last[5]]).toEqual([1, 2, 3])
  })

  it('a click on a point straight below A goes down the same way', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerDown({ x: 1, y: 2, z: -2, kind: 'endpoint' }, RAY)
    tool.onPointerDown({ x: 2, y: 2, z: -1, kind: 'free' }, RAY)

    expect(onCommit).toHaveBeenCalledTimes(1)
    const last = log.segments[log.segments.length - 1]
    expect([last[3], last[4], last[5]]).toEqual([1, 2, -2])
  })

  it('Esc from the bulge goes back to the chord on the ground', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerDown(blue(1, 2, 3), RAY)
    tool.onKey(makeKeyEvent('Escape'))           // bulge → chord, A kept
    expect(tool.snapConstraint(RAY)).toEqual({ anchor: [1, 2, 0] }) // ground again: no plane, A's soft axes
    tool.onPointerDown(ground(4, 2), RAY)        // B on the ground
    tool.onPointerDown(ground(2.5, 3), RAY)      // bulge

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[0, 0, 0, 0, 0, 1]])
    for (const sg of log.segments) expect([sg[2], sg[5]]).toEqual([0, 0])
  })

  it('a plane chosen with an arrow key holds: Blue over A then lands on A, and the toast says so', () => {
    const { scene, log } = makeScene()
    const { tool, onToast } = makeTool(scene)

    tool.onKey(makeKeyEvent('ArrowUp'))          // idle lock: the Blue-normal (flat) plane
    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerMove(blue(1, 2, 3), RAY)
    typeDigits(tool, '5')
    tool.onKey(makeKeyEvent('Enter'))

    expect(onToast).toHaveBeenCalledWith(
      'An arc stays on its drawing plane. Move the cursor along the plane, or press an arrow key to change it, then type the length.',
    )
    expect(log.segments).toHaveLength(0)
    expect(tool.capturingInput()).toBe(true)
  })

  it('a snap off to the side of A still drops onto the ground, as before', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerMove({ x: 3, y: 2, z: 4, kind: 'endpoint' }, RAY)
    expect(tool.snapProjected()).toBe(true)
    tool.onPointerDown({ x: 3, y: 2, z: 4, kind: 'endpoint' }, RAY)
    tool.onPointerDown(ground(2, 3), RAY)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[0, 0, 0, 0, 0, 1]])
    const last = log.segments[log.segments.length - 1]
    expect([last[3], last[4], last[5]]).toEqual([3, 2, 0])
  })

  it('hovering Blue shows the real vertical chord length in the measurement box', () => {
    const { scene } = makeScene()
    const { tool, onMeasurement } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    onMeasurement.mockClear()
    tool.onPointerMove(blue(1, 2, 3), RAY)
    expect(onMeasurement).toHaveBeenCalledWith(formatLength(3))
  })

  it('a typed chord on Blue straight DOWN goes down', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerMove(blue(1, 2, -3), RAY)
    typeDigits(tool, '2')
    tool.onKey(makeKeyEvent('Enter'))
    tool.onPointerDown({ x: 2, y: 2, z: -1, kind: 'free' }, RAY)

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    const last = log.segments[log.segments.length - 1]
    expect([last[3], last[4], last[5]]).toEqual([1, 2, -2])
  })

  it('a typed bulge in the re-homed bulge stage commits on the vertical plane at that sagitta', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerDown(blue(1, 2, 4), RAY)                        // chord straight up, 4 long
    tool.onPointerMove({ x: 1.3, y: 2, z: 2, kind: 'free' }, RAY) // pick the +X side
    typeDigits(tool, '0.5')
    tool.onKey(makeKeyEvent('Enter'))

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[1, 2, 0, 0, 1, 0]])
    const xs = log.segments.flatMap((sg) => [sg[0], sg[3]])
    // Facets sit a hair inside the true sagitta.
    expect(Math.max(...xs) - 1).toBeCloseTo(0.5, 2)
    expect(Math.min(...xs)).toBeCloseTo(1, 9)
  })

  it('a bulge retyped after the commit redraws the arc on the same vertical plane, not the ground', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerDown(blue(1, 2, 4), RAY)
    tool.onPointerMove({ x: 1.5, y: 2, z: 2, kind: 'free' }, RAY)
    tool.onPointerDown({ x: 1.5, y: 2, z: 2, kind: 'free' }, RAY) // commit
    expect(onCommit).toHaveBeenCalledTimes(1)
    const from = log.segments.length

    typeDigits(tool, '1')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(planes(log)).toEqual([[1, 2, 0, 0, 1, 0], [1, 2, 0, 0, 1, 0]])
    const redrawn = log.segments.slice(from)
    for (const sg of redrawn) {
      expect(sg[1]).toBeCloseTo(2, 12)
      expect(sg[4]).toBeCloseTo(2, 12)
    }
    expect(Math.max(...redrawn.flatMap((sg) => [sg[0], sg[3]])) - 1).toBeCloseTo(1, 2)
  })

  it('straight over A means within 1e-9 m across: just inside keeps the height, just outside flattens', () => {
    const { scene } = makeScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerMove({ x: 1 + 5e-10, y: 2, z: 3, kind: 'endpoint' }, RAY)
    expect(tool.snapProjected()).toBe(false)
    tool.onPointerMove({ x: 1 + 2e-9, y: 2, z: 3, kind: 'endpoint' }, RAY)
    expect(tool.snapProjected()).toBe(true)
  })

  it('a ground Shift pin holds: no soft Blue axis from A, a point straight over A flattens, and both a typed chord and a click are refused aloud', () => {
    const { scene, log } = makeScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerMove(ground(1, 2), RAY)
    tool.setShiftHeld(true)                     // pin the ground
    tool.setShiftHeld(false)
    expect(tool.statusHint()).toContain('Pinned')
    tool.onPointerDown(ground(1, 2), RAY)
    expect(tool.snapConstraint(RAY)?.anchor).toBeUndefined()

    const over: Snap = { x: 1, y: 2, z: 3, kind: 'endpoint' }
    tool.onPointerMove(over, RAY)
    expect(tool.snapProjected()).toBe(true)
    typeDigits(tool, '5')
    tool.onKey(makeKeyEvent('Enter'))
    expect(onToast).toHaveBeenLastCalledWith(OFF_PLANE)
    tool.onKey(makeKeyEvent('Backspace'))
    tool.onPointerDown(over, RAY)
    expect(onToast).toHaveBeenCalledTimes(2)
    expect(onToast).toHaveBeenLastCalledWith(OFF_PLANE)
    expect(tool.capturingInput()).toBe(true)    // still waiting for B

    // The chord then goes along the pinned ground as usual.
    tool.onPointerDown(ground(4, 2), RAY)
    tool.onPointerDown(ground(2.5, 3), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(planes(log)).toEqual([[0, 0, 0, 0, 0, 1]])
  })

  it('an arrow lock withholds the soft Blue axis from A too, and a click straight over A is refused aloud', () => {
    const { scene } = makeScene()
    const { tool, onToast } = makeTool(scene)

    tool.onKey(makeKeyEvent('ArrowUp'))         // the Blue-normal (flat) plane through the click
    tool.onPointerDown(ground(1, 2), RAY)
    expect(tool.snapConstraint(RAY)?.anchor).toBeUndefined()
    tool.onPointerDown({ x: 1, y: 2, z: 3, kind: 'endpoint' }, RAY)
    expect(onToast).toHaveBeenCalledWith(OFF_PLANE)
    expect(tool.capturingInput()).toBe(true)
  })

  it('a locked vertical chord whose B lands a hair (5e-8 m) off its plane stays on that plane', () => {
    const { scene } = makeScene()
    const { tool } = makeTool(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))      // plane through A, normal Red
    tool.onPointerDown(ground(1, 2), RAY)
    tool.onPointerDown({ x: 1 + 5e-8, y: 2, z: 3, kind: 'endpoint' }, RAY)
    expect(tool.statusHint()).toMatch(/^Click to set the curve/)
    const c = tool.snapConstraint(RAY)?.constraintPlane
    expect(c?.normal).toEqual([1, 0, 0])
    expect(c?.point[0]).toBe(1)
  })
})
