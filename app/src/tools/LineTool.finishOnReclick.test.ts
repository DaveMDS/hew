/**
 * #36: clicking the last placed point again finishes the chain, at any
 * pace, in plane and face mode alike — the same finish as Enter on an empty
 * buffer or a double-click, with no toast. A quick double-click already did
 * this (`onDoubleClick`); a slow re-click never produces a `dblclick`, so it
 * used to toast "That point is the same as the last one" and leave the chain
 * running.
 *
 * Also pinned here: a genuine double-click still places exactly one point
 * and finishes once; the `dblclick` that follows a re-click finish is
 * consumed (never handed to the Viewport's enter-context gesture); a snap
 * that collapses onto the last point while the cursor is elsewhere still
 * toasts; and a typed zero length gets a toast about the length.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { draftMock } from './draftMock'
import { isCoarsePointer } from '../platform'

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, isCoarsePointer: vi.fn(() => false) }
})

type V3 = [number, number, number]

/** Straight down through (x, y). */
const rayThrough = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })

const snapAt = (p: V3, kind = 'ground', extra: Partial<Snap> = {}): Snap => ({ x: p[0], y: p[1], z: p[2], kind, ...extra })

function key(k: string): KeyboardEvent {
  return { key: k, repeat: false, preventDefault: () => { /* no-op */ } } as unknown as KeyboardEvent
}

/** Ground plane: nothing under the cursor but the ground. */
function groundScene() {
  const dm = draftMock()
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => 1n),
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    ...dm.members,
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  return { scene: scene as unknown as WasmScene, log: dm.log }
}

/** Object 7's top face 3 (z = 1), always under the ray. */
function faceScene() {
  const dm = draftMock()
  const pick = { object: () => 7n, face: () => 3n, depth: () => 1, instance: () => undefined, free: vi.fn() }
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => 1n),
    pick_face: vi.fn(() => pick),
    pick_sketch: vi.fn(() => undefined),
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])),
    ...dm.members,
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  return { scene: scene as unknown as WasmScene, log: dm.log }
}

function makeTool(scene: WasmScene) {
  const onToast = vi.fn()
  const onCommit = vi.fn()
  const onFaceImprint = vi.fn()
  const tool = new LineTool(scene, new THREE.Group(), onCommit, onToast, onFaceImprint, vi.fn())
  return { tool, onToast, onCommit, onFaceImprint }
}

/** A click with the cursor on `p`: the hover, then the press. */
function clickOn(tool: LineTool, snap: Snap, ray: Ray = rayThrough(snap.x, snap.y)) {
  tool.onPointerMove(snap, ray)
  tool.onPointerDown(snap, ray)
}

const faceSnap = (x: number, y: number): Snap => snapAt([x, y, 1], 'endpoint', { object: 7n, element: 3n, elementKind: 'face' })

describe('LineTool — a click back on the last point finishes the chain (#36)', () => {
  it('plane mode: a slow re-click on the last point ends the chain with no toast, keeping the segment', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0]))
    expect(log.segments).toHaveLength(1)
    // Some time later, the cursor goes back onto the endpoint and clicks.
    tool.onPointerMove(snapAt([0.6, 0.4, 0]), rayThrough(0.6, 0.4))
    clickOn(tool, snapAt([1, 0, 0], 'endpoint'))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(false)
    expect(log.segments).toHaveLength(1)
    expect(log.begins).toHaveLength(1) // no extra draft was opened for the finish
    // The next click starts a fresh chain rather than continuing the old one.
    clickOn(tool, snapAt([3, 3, 0]))
    clickOn(tool, snapAt([4, 3, 0]))
    expect(log.segments[1]).toEqual([3, 3, 0, 4, 3, 0])
  })

  it('plane mode: a chain with only its first point placed, re-clicked, just ends with no toast', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([2, 3, 0]))
    clickOn(tool, snapAt([2, 3, 0]))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(false)
    expect(log.segments).toHaveLength(0)
  })

  it('face mode: a slow re-click on the last point ends the chain with no toast, keeping the segments', () => {
    const { scene, log } = faceScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, faceSnap(0.2, 0.2))
    clickOn(tool, faceSnap(0.6, 0.2))
    clickOn(tool, faceSnap(0.6, 0.7))
    expect(log.segments).toHaveLength(2)
    tool.onPointerMove(faceSnap(0.4, 0.5), rayThrough(0.4, 0.5))
    clickOn(tool, faceSnap(0.6, 0.7))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(false)
    expect(log.segments).toHaveLength(2)
    expect(log.begins.every((b) => b.kind === 'face')).toBe(true)
  })

  it('face mode: a chain with only its first point placed, re-clicked, just ends with no toast', () => {
    const { scene, log } = faceScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, faceSnap(0.3, 0.3))
    clickOn(tool, faceSnap(0.3, 0.3))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(false)
    expect(log.segments).toHaveLength(0)
  })

  it('a point within the kernel coincidence line of the last one counts as the last point', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0]))
    clickOn(tool, snapAt([1 + 5e-10, 0, 0]))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(false)
    expect(log.segments).toHaveLength(1)
  })
})

describe('LineTool — the double-click that may follow a re-click finish (#36)', () => {
  it('a long-gap double-click whose second press reached the tool finishes once, and its dblclick is consumed', () => {
    // The Viewport routes the second press when its click count says 1
    // (multiClick.ts is stricter than the browser), and the browser still
    // fires `dblclick` after it.
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0])) // first press of the double-click
    tool.onPointerDown(snapAt([1, 0, 0], 'endpoint'), rayThrough(1, 0)) // second press: finishes
    expect(tool.capturingInput()).toBe(false)
    // A hand on the mouse jitters before the dblclick lands.
    tool.onPointerMove(snapAt([1, 0, 0], 'endpoint'), rayThrough(1.001, 0))
    expect(tool.onDoubleClick(snapAt([1, 0, 0]), rayThrough(1, 0))).toBe(true) // this gesture's: consumed
    expect(tool.onDoubleClick(snapAt([1, 0, 0]), rayThrough(1, 0))).toBe(false) // a later one is the host's
    expect(onToast).not.toHaveBeenCalled()
    expect(log.segments).toHaveLength(1)
  })

  it('after a slow re-click finish, the next press clears the claim: a later idle double-click is the host\'s', () => {
    const { scene } = groundScene()
    const { tool } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0], 'endpoint')) // finishes
    clickOn(tool, snapAt([5, 5, 0])) // a new chain…
    tool.onKey(key('Escape')) // …ended at once
    expect(tool.capturingInput()).toBe(false)
    expect(tool.onDoubleClick(snapAt([5, 5, 0]), rayThrough(5, 5))).toBe(false)
  })

  it('a quick double-click (second press suppressed upstream) still places exactly one point and finishes once', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0])) // first press; the Viewport drops the second
    expect(tool.onDoubleClick(snapAt([1, 0, 0]), rayThrough(1, 0))).toBe(true)
    expect(tool.capturingInput()).toBe(false)
    expect(tool.onDoubleClick(snapAt([1, 0, 0]), rayThrough(1, 0))).toBe(false)
    expect(log.segments).toHaveLength(1)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('face mode: the dblclick after a re-click finish is consumed too', () => {
    const { scene } = faceScene()
    const { tool } = makeTool(scene)
    clickOn(tool, faceSnap(0.2, 0.2))
    clickOn(tool, faceSnap(0.6, 0.2))
    tool.onPointerDown(faceSnap(0.6, 0.2), rayThrough(0.6, 0.2))
    expect(tool.capturingInput()).toBe(false)
    expect(tool.onDoubleClick(faceSnap(0.6, 0.2), rayThrough(0.6, 0.2))).toBe(true)
    expect(tool.onDoubleClick(faceSnap(0.6, 0.2), rayThrough(0.6, 0.2))).toBe(false)
  })
})

describe('LineTool — where the same-point toasts still belong (#36)', () => {
  it('a snap that collapses onto the last point with the cursor elsewhere still toasts and keeps the chain', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0], 'on-axis'), rayThrough(1.6, 0.5))
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][0]).toBe(
      'That click landed on the last point. Move the cursor off it and click again, or press Enter to finish.',
    )
    expect(tool.capturingInput()).toBe(true)
    expect(log.segments).toHaveLength(1)
  })

  it('on a touch screen the same toast speaks of taps, with no cursor or Enter key', () => {
    vi.mocked(isCoarsePointer).mockReturnValue(true)
    try {
      const { scene } = groundScene()
      const { tool, onToast } = makeTool(scene)
      clickOn(tool, snapAt([0, 0, 0]))
      clickOn(tool, snapAt([1, 0, 0]))
      clickOn(tool, snapAt([1, 0, 0], 'on-axis'), rayThrough(1.6, 0.5))
      expect(onToast).toHaveBeenCalledTimes(1)
      expect(onToast.mock.calls[0][0]).toBe(
        'That tap landed on the last point. Tap somewhere else to continue, or tap it again to finish.',
      )
      expect(tool.capturingInput()).toBe(true)
    } finally {
      vi.mocked(isCoarsePointer).mockReturnValue(false)
    }
  })

  it('the re-click test follows the live pixel scale: a few pixels off finishes, many pixels off toasts', () => {
    const { scene } = groundScene()
    const { tool, onToast } = makeTool(scene)
    // 1 mm per pixel at any distance: the 8 px acquire radius is 8 mm.
    tool.updateDiskScale(new THREE.PerspectiveCamera(), () => 0.001)
    clickOn(tool, snapAt([0, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0]))
    clickOn(tool, snapAt([1, 0, 0], 'endpoint'), rayThrough(1.02, 0)) // 20 px off
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(tool.capturingInput()).toBe(true)
    clickOn(tool, snapAt([1, 0, 0], 'endpoint'), rayThrough(1.003, 0)) // 3 px off
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(tool.capturingInput()).toBe(false)
  })

  it('a typed zero length toasts about the length and keeps the chain', () => {
    const { scene, log } = groundScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, snapAt([0, 0, 0]))
    tool.onPointerMove(snapAt([1, 0, 0]), rayThrough(1, 0))
    tool.onKey(key('0'))
    tool.onKey(key('Enter'))
    expect(onToast).toHaveBeenCalledWith('A line needs a length. Type a length other than 0.')
    expect(tool.capturingInput()).toBe(true)
    expect(log.segments).toHaveLength(0)
  })

  it('face mode: a typed zero length toasts about the length and keeps the chain', () => {
    const { scene, log } = faceScene()
    const { tool, onToast } = makeTool(scene)
    clickOn(tool, faceSnap(0.2, 0.2))
    tool.onPointerMove(faceSnap(0.6, 0.2), rayThrough(0.6, 0.2))
    tool.onKey(key('0'))
    tool.onKey(key('Enter'))
    expect(onToast).toHaveBeenCalledWith('A line needs a length. Type a length other than 0.')
    expect(tool.capturingInput()).toBe(true)
    expect(log.segments).toHaveLength(0)
  })
})
