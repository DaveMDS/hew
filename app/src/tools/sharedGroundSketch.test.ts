/**
 * Cross-tool shared ground plane — under unified drafting there is no
 * per-plane sketch cache: the PLANE is the drafting context, so every commit
 * (an arc, then a circle from a freshly built tool) is its own draft opened
 * on the same plane via `draft_begin_plane`, and the engine lowers each into
 * whatever lies under that plane. These tests drive two real tools against
 * one fake WasmScene and assert both drafts open on the same ground plane.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { ArcTool } from './ArcTool'
import { CircleTool } from './CircleTool'
import { draftMock } from './draftMock'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

/** Fake WasmScene covering what ArcTool and CircleTool call in ground mode. */
function makeWasmScene() {
  const dm = draftMock()
  const scene = {
    history_generation: vi.fn(() => 1n),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    ...dm.members,
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
  }
  return { scene: scene as unknown as WasmScene, dm }
}

function makeArcTool(scene: WasmScene) {
  return new ArcTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn())
}

function makeCircleTool(scene: WasmScene) {
  return new CircleTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn())
}

describe('draw tools share the ground plane as their drafting context', () => {
  it('an arc and a circle drawn by different tools each open their own draft on the same plane', () => {
    const { scene, dm } = makeWasmScene()

    const arc = makeArcTool(scene)
    arc.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    // A fresh CircleTool instance — tools are recreated on every switch.
    const circle = makeCircleTool(scene)
    circle.onPointerDown(makeSnap({ x: 5, y: 5 }), RAY)
    circle.onPointerDown(makeSnap({ x: 6, y: 5 }), RAY)

    expect(dm.log.begins).toHaveLength(2)
    expect(dm.log.begins.every((b) => b.kind === 'plane')).toBe(true)
    // Both drafts open on the SAME ground plane (origin z = 0, normal +Z).
    const planeOf = (b: { args: unknown[] }) => b.args.slice(0, 6) as number[]
    const [p0, p1] = dm.log.begins.map(planeOf)
    expect(p0[2]).toBeCloseTo(0, 9)
    expect(p0.slice(3)).toEqual([0, 0, 1])
    expect(p1[2]).toBeCloseTo(0, 9)
    expect(p1.slice(3)).toEqual([0, 0, 1])
    expect(dm.log.ended).toBe(2)
    expect(dm.log.segments.length).toBeGreaterThan(0)
  })

  it('onDocumentReset on ONE tool is harmless: the next commit opens a fresh draft on the plane', () => {
    const { scene, dm } = makeWasmScene()

    const arc = makeArcTool(scene)
    arc.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    const circle = makeCircleTool(scene)
    circle.onDocumentReset() // document replaced — nothing stale to drop

    arc.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    arc.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    expect(dm.log.begins).toHaveLength(2)
    expect(dm.log.begins.every((b) => b.kind === 'plane')).toBe(true)
    expect(dm.log.ended).toBe(2)
  })
})
