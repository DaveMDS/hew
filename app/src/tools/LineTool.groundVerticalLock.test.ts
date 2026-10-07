/**
 * Ground-anchored hard Z lock — the canonical SketchUp gesture Kurt asked
 * for: "I need the ability to axis-lock at any point right up until
 * clicking the second point... it is the SketchUp way." Click a point on
 * the ground (the case every fresh drawing starts in) and press the up
 * arrow to draw straight up.
 *
 * `_planeCursor`'s ground fast path (see LineTool.ts's module doc and
 * `_planeCursor`'s own doc) used to force EVERY point back onto `z = 0`
 * regardless of any active lock — so a Z-locked point could never leave the
 * anchor: the segment always collapsed to zero length and the degenerate-
 * click guard in `_commitPlaneSegment` refused it, with the rubber-band
 * readout stuck at a formatted-zero length the whole time. This is the
 * ground-anchored counterpart of `LineTool.rehome.test.ts`'s off-plane
 * re-homing coverage — same machinery (`_rehomeChain`), reached from the one
 * anchor plane (`plane.ground === true`) that used to be excluded from it
 * entirely.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { formatLength } from '../settings/units'
import { draftMock } from './draftMock'

const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(p: readonly [number, number, number]): Snap {
  return { x: p[0], y: p[1], z: p[2], kind: 'ground' }
}

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, repeat: false, preventDefault: () => { /* no-op */ } } as unknown as KeyboardEvent
}

function makeWasmScene() {
  const dm = draftMock()
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => 1n),
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => undefined),
    ...dm.members,
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  // Every draft is one `draft_begin_plane`; `planeCalls` is its [origin, normal] args.
  return {
    scene: scene as unknown as WasmScene,
    segmentCalls: dm.log.segments,
    get planeCalls() {
      return dm.log.begins.map((b) => b.args.slice(0, 6) as number[])
    },
    log: dm.log,
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

describe('LineTool — ground-anchored hard Z lock (the up-arrow "draw straight up" gesture)', () => {
  it('a Z-locked hover away from the ground anchor reports a real, non-zero measurement instead of a stuck zero', () => {
    const { scene } = makeWasmScene()
    const { tool, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap([2, 3, 0]), RAY) // first click: anchors on the ground
    tool.onKey(makeKeyEvent('ArrowUp')) // Z lock
    onMeasurement.mockClear()
    tool.onPointerMove(makeSnap([2, 3, 4]), RAY) // hover 4m straight up, still Z-locked

    expect(onMeasurement).toHaveBeenCalledWith(formatLength(4))
  })

  it('clicking straight up from a ground anchor while Z-locked commits a real vertical segment instead of refusing every click', () => {
    const w = makeWasmScene()
    const { scene, segmentCalls } = w
    const { tool, onToast, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap([2, 3, 0]), RAY) // first click: ground anchor
    tool.onKey(makeKeyEvent('ArrowUp')) // Z lock
    tool.onPointerDown(makeSnap([2, 3, 4]), RAY) // second click: straight up

    expect(onToast).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segmentCalls).toHaveLength(1)
    expect(segmentCalls[0]).toEqual([2, 3, 0, 2, 3, 4])

    // The vertical segment leaves the ground plane, so it re-homes onto a
    // genuine (non-ground) plane through the anchor — same machinery as
    // `LineTool.rehome.test.ts`'s wall-to-wall case, just reached from the
    // ground for the first time. With no previous segment to span and a
    // straight-down view direction exactly antiparallel to the vertical
    // segment (the view-facing fallback degenerates too), `rehomePlaneNormal`
    // lands in its last-resort arbitrary-plane branch: normal (0, 1, 0),
    // any genuine vertical plane containing the drawn line.
    // (One draft, begun directly on the re-homed plane.)
    expect(w.planeCalls).toHaveLength(1)
    expect(w.planeCalls[0]).toEqual([2, 3, 0, 0, 1, 0])
  })

  it('an ordinary unlocked ground click is completely unaffected — same exact z = 0 coordinates as before', () => {
    const w = makeWasmScene()
    const { scene, segmentCalls } = w
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap([2, 3, 0]), RAY)
    tool.onPointerDown(makeSnap([9, 3, 0]), RAY) // no lock — ordinary horizontal segment

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segmentCalls).toHaveLength(1)
    expect(segmentCalls[0]).toEqual([2, 3, 0, 9, 3, 0])
    // never re-homed — the one draft is on the ground plane
    expect(w.planeCalls).toEqual([[0, 0, 0, 0, 0, 1]])
  })
})
