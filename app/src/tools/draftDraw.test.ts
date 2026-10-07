/**
 * The five draw tools commit through the drafting engine (unified drafting):
 * a loose line on a face commits per click, a shape overhanging a face edge
 * commits, a circle on a face keeps its analytic claim through
 * `draft_begin_curve_with`, an instance face drafts through
 * `draft_begin_face_in_instance` with WORLD points, and a refusal cancels
 * the draft and toasts.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import { RectangleTool } from './RectangleTool'
import { CircleTool } from './CircleTool'
import { PolygonTool } from './PolygonTool'
import { ArcTool } from './ArcTool'
import { draftMock, type DraftMockOpts } from './draftMock'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

const rayThrough = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })
const faceSnap = (x: number, y: number, kind: Snap['kind'] = 'on-face'): Snap =>
  ({ x, y, z: 1, kind, object: 7n, element: 3n, elementKind: 'face' })
const hardFace = (x: number, y: number): Snap => faceSnap(x, y, 'endpoint')
const pick = (object: bigint, face: bigint, instance?: bigint) => ({
  object: () => object, face: () => face, depth: () => 1, instance: () => instance, free: vi.fn(),
})

function makeScene(opts: { instance?: bigint; mock?: DraftMockOpts } = {}) {
  const dm = draftMock(opts.mock)
  const scene = {
    ...dm.members,
    history_generation: vi.fn(() => 1n),
    scene_undo: vi.fn(() => ({ free: vi.fn() })),
    pick_face: vi.fn(() => pick(7n, 3n, opts.instance)),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    face_boundary: vi.fn(() => new Float32Array([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0])),
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  return { scene: scene as unknown as WasmScene & typeof scene, dm }
}

const hooks = () => ({ onCommit: vi.fn(), onToast: vi.fn(), onFaceImprint: vi.fn() })

describe('LineTool on a face — one draft per click', () => {
  it('a loose line (touching no edge) commits on its first segment, one draft each', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new LineTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.onPointerDown(hardFace(0.25, 0.25), rayThrough(0.25, 0.25))
    expect(scene.draft_begin_face).not.toHaveBeenCalled() // the first click only anchors
    tool.onPointerDown(hardFace(0.75, 0.25), rayThrough(0.75, 0.25))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_face).toHaveBeenCalledWith(7n, 3n, expect.any(String))
    expect(dm.log.segments).toEqual([[0.25, 0.25, 1, 0.75, 0.25, 1]])
    expect(dm.log.ended).toBe(1)
    expect(h.onFaceImprint).toHaveBeenCalledWith(7n)
    expect(h.onToast).not.toHaveBeenCalled()

    tool.onPointerDown(hardFace(0.75, 0.75), rayThrough(0.75, 0.75))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(2) // its own draft, its own undo step
    expect(dm.log.segments[1]).toEqual([0.75, 0.25, 1, 0.75, 0.75, 1])
    expect(dm.log.ended).toBe(2)
    // Nothing is pending: finishing the chain commits nothing further.
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(2)
    expect(tool.capturingInput()).toBe(false)
  })

  it('a closing click on the chain start commits that segment and ends the chain', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new LineTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    for (const [x, y] of [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.2]]) {
      tool.onPointerDown(hardFace(x, y), rayThrough(x, y))
    }
    expect(dm.log.segments).toHaveLength(3)
    expect(dm.log.ended).toBe(3)
    expect(tool.capturingInput()).toBe(false)
  })

  it('a kernel refusal cancels the draft, toasts, and leaves the chain where it was', () => {
    const { scene, dm } = makeScene({ mock: { failSegmentAt: () => new Error('DegenerateSegment: too short') } })
    const h = hooks()
    const tool = new LineTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.onPointerDown(hardFace(0.25, 0.25), rayThrough(0.25, 0.25))
    tool.onPointerDown(hardFace(0.75, 0.25), rayThrough(0.75, 0.25))
    expect(dm.log.cancelled).toBe(1)
    expect(dm.isOpen()).toBe(false)
    expect(h.onToast).toHaveBeenCalledTimes(1)
    expect(h.onFaceImprint).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)
  })
})

describe('RectangleTool on a face', () => {
  it('a rectangle overhanging the face edge commits (four segments, one draft)', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new RectangleTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    // The face is the unit square; the rectangle runs from inside to past x=1.
    tool.onPointerDown(hardFace(0.5, 0.25), rayThrough(0.5, 0.25))
    tool.onPointerDown(hardFace(1.5, 0.75), rayThrough(1.5, 0.75))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(dm.log.segments).toHaveLength(4)
    const xs = dm.log.segments.map((s) => s[0])
    expect(Math.max(...xs)).toBeCloseTo(1.5)
    expect(dm.log.ended).toBe(1)
    expect(h.onToast).not.toHaveBeenCalled()
    expect(h.onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('an instance face drafts through draft_begin_face_in_instance with WORLD points', () => {
    const INSTANCE = 42n
    const { scene, dm } = makeScene({ instance: INSTANCE })
    const h = hooks()
    const tool = new RectangleTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: 5n })
    tool.setFaceEligibility((_o, instance) => instance === INSTANCE)
    tool.onPointerDown(hardFace(0, 0), rayThrough(0, 0))
    tool.onPointerDown(hardFace(1, 2), rayThrough(1, 2))
    expect(scene.draft_begin_face_in_instance).toHaveBeenCalledWith(INSTANCE, 7n, 3n, expect.any(String))
    expect(scene.draft_begin_face).not.toHaveBeenCalled()
    // World coordinates straight through — no pose mapping in the tool.
    expect(dm.log.segments).toHaveLength(4)
    for (const s of dm.log.segments) {
      expect(s[2]).toBe(1)
      expect(s[5]).toBe(1)
    }
    expect(dm.log.segments.flatMap((s) => [s[0], s[3]]).sort()).toEqual([0, 0, 0, 0, 1, 1, 1, 1].sort())
  })
})

describe('CircleTool / PolygonTool / ArcTool on a face', () => {
  it('a circle brackets draft_begin_curve_with (world center and radius) around its facets', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new CircleTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.onPointerDown(hardFace(0.5, 0.5), rayThrough(0.5, 0.5))
    tool.onPointerDown(hardFace(0.75, 0.5), rayThrough(0.75, 0.5))
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_curve_with).toHaveBeenCalledTimes(1)
    const [, center, radius] = (scene.draft_begin_curve_with as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(center as Float64Array)).toEqual([0.5, 0.5, 1])
    expect(radius).toBeCloseTo(0.25)
    expect(dm.log.segments.length).toBeGreaterThanOrEqual(8)
    expect(dm.log.curves.map((c) => c.kind)).toEqual(['circle', 'end'])
    expect(scene.draft_begin_polygon_with).not.toHaveBeenCalled()
    expect(h.onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('a regular polygon brackets draft_begin_polygon_with', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new PolygonTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.onPointerDown(hardFace(0.5, 0.5), rayThrough(0.5, 0.5))
    tool.onPointerDown(hardFace(0.75, 0.5), rayThrough(0.75, 0.5))
    expect(scene.draft_begin_polygon_with).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_curve_with).not.toHaveBeenCalled()
    expect(dm.log.curves.map((c) => c.kind)).toEqual(['polygon', 'end'])
    expect(dm.log.ended).toBe(1)
  })

  it('an open arc on a face commits without reaching an edge', () => {
    const { scene, dm } = makeScene()
    const h = hooks()
    const tool = new ArcTool(scene, new THREE.Group(), h.onCommit, h.onToast, h.onFaceImprint, vi.fn())
    tool.onPointerDown(hardFace(0.25, 0.5), rayThrough(0.25, 0.5)) // chord A
    tool.onPointerDown(hardFace(0.75, 0.5), rayThrough(0.75, 0.5)) // chord B
    tool.onPointerMove(faceSnap(0.5, 0.7), rayThrough(0.5, 0.7))
    tool.onPointerDown(faceSnap(0.5, 0.7), rayThrough(0.5, 0.7)) // bulge
    expect(scene.draft_begin_face).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_curve_with).toHaveBeenCalledTimes(1)
    expect(dm.log.segments.length).toBeGreaterThan(2)
    expect(dm.log.ended).toBe(1)
    expect(h.onToast).not.toHaveBeenCalled()
  })
})
