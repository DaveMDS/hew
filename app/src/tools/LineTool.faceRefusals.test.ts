/**
 * #36: "A splitting line must start and end on the face's edges"
 * (`EndpointNotOnBoundary`), and its neighbors `PointNotOnFace` and
 * `PathNotSimple`, came from 1.1's face chains, which were committed as one
 * `split_face` path that had to run edge to edge. Since the unified drafting
 * work every face-mode click is its own draft on the face: the engine keeps a
 * segment as face topology only where it separates regions, keeps a loose
 * line as the object's own sketch drawing, and keeps a stretch past the face
 * as a free sketch — rehearsing the topology change and keeping as drawing
 * whatever the face cannot hold. So none of those refusals should reach a
 * Line tool user from an ordinary gesture.
 *
 * These cases drive the REAL LineTool against the REAL compiled kernel (the
 * `*.wasm.test.ts` pattern: wasm loaded into vitest), on the top face of a
 * unit box, for each shape that used to be refused: a chain ending in the
 * middle of the face, one ending on an edge, one crossing a line already
 * drawn on the face, one running off the face's outer edge, and a chain that
 * touches itself partway along. Every one must commit without a toast.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import init, { Scene } from '../wasm/pkg/wasm_api.js'
import { LineTool } from './LineTool'
import type { Snap } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

beforeAll(async () => {
  const wasmBytes = await readFile(resolve(__dirname, '../wasm/pkg/wasm_api_bg.wasm'))
  await init({ module_or_path: wasmBytes })
})

/** A unit box [0,1]^3 as one plain Object; its top face is at z = 1. */
function makeBox(scene: Scene): bigint {
  const sketch = scene.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
  const c: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i]
    const [bx, by] = c[(i + 1) % 4]
    scene.sketch_add_segment(sketch, ax, ay, 0, bx, by, 0)
  }
  const regions = Array.from(scene.sketch_regions(sketch))
  expect(regions.length).toBe(1)
  return scene.extrude_region(sketch, regions[0], 1)
}

/** Straight down through (x, y): onto the top face, or past it to the ground. */
const rayThrough = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })

function setup() {
  const scene = new Scene()
  const box = makeBox(scene)
  // Every commit below must go through a draft on the face (face mode),
  // not fall back to a ground or plane sketch.
  const faceDrafts = vi.spyOn(scene, 'draft_begin_face')
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onCommit = vi.fn()
  const tool = new LineTool(scene as unknown as WasmScene, new THREE.Group(), onCommit, onToast, onFaceImprint, vi.fn())
  /** A point inside the top face (a hard pick, so it commits as placed). */
  const onFace = (x: number, y: number): Snap => ({ x, y, z: 1, kind: 'endpoint', object: box, elementKind: 'face' })
  /** A point on one of the top face's outer edges. */
  const onEdge = (x: number, y: number): Snap => ({ x, y, z: 1, kind: 'on-edge', object: box, elementKind: 'edge' })
  /** A point on the top face's plane, past its outer edge (nothing under it there). */
  const offFace = (x: number, y: number): Snap => ({ x, y, z: 1, kind: 'plane' })
  const click = (snap: Snap) => {
    tool.onPointerMove(snap, rayThrough(snap.x, snap.y))
    tool.onPointerDown(snap, rayThrough(snap.x, snap.y))
  }
  const topFaceAt = (x: number, y: number): bigint | undefined => {
    const pick = scene.pick_face(x, y, 5, 0, 0, -1)
    if (pick === undefined) return undefined
    const face = pick.face()
    pick.free()
    return face
  }
  return { scene, box, faceDrafts, tool, onToast, onFaceImprint, onCommit, onFace, onEdge, offFace, click, topFaceAt }
}

describe('LineTool — a face chain is never refused for where it ends or what it crosses (#36)', () => {
  it('a chain from an edge that ends in the middle of the face commits as drawing, with no toast', () => {
    const t = setup()
    t.click(t.onEdge(0, 0.5))
    t.click(t.onFace(0.5, 0.5))
    t.click(t.onFace(0.5, 0.8))
    t.tool.onKey({ key: 'Enter' } as KeyboardEvent)
    expect(t.onToast).not.toHaveBeenCalled()
    expect(t.faceDrafts).toHaveBeenCalledTimes(2)
    // Two segments, two drafts, both kept (one undo step each).
    expect(t.onFaceImprint.mock.calls.length + t.onCommit.mock.calls.length).toBeGreaterThanOrEqual(2)
    // A loose line splits nothing: the top face is still one face.
    expect(t.topFaceAt(0.25, 0.25)).toBe(t.topFaceAt(0.75, 0.75))
  })

  it('a chain drawn entirely inside the face, starting and ending mid-face, commits with no toast', () => {
    const t = setup()
    t.click(t.onFace(0.2, 0.2))
    t.click(t.onFace(0.4, 0.3))
    t.click(t.onFace(0.6, 0.2))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(t.onToast).not.toHaveBeenCalled()
    expect(t.faceDrafts).toHaveBeenCalledTimes(2)
    expect(t.topFaceAt(0.1, 0.9)).toBe(t.topFaceAt(0.9, 0.1))
  })

  it('a chain that runs from edge to edge splits the face, with no toast', () => {
    const t = setup()
    t.click(t.onEdge(0, 0.5))
    t.click(t.onFace(0.5, 0.5))
    t.click(t.onEdge(1, 0.5))
    expect(t.onToast).not.toHaveBeenCalled()
    expect(t.onFaceImprint).toHaveBeenCalledWith(t.box)
    expect(t.topFaceAt(0.5, 0.25)).not.toBe(t.topFaceAt(0.5, 0.75))
  })

  it('a chain that crosses a line already drawn across the face commits, with no toast', () => {
    const t = setup()
    // First split the face edge to edge.
    t.click(t.onEdge(0, 0.5))
    t.click(t.onEdge(1, 0.5))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(t.topFaceAt(0.5, 0.25)).not.toBe(t.topFaceAt(0.5, 0.75))
    // Then a free-ended chain straight across that edge, ending mid-face.
    t.click(t.onFace(0.3, 0.2))
    t.click(t.onFace(0.3, 0.8))
    t.click(t.onFace(0.6, 0.8))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    // And one from an outer edge across it to the opposite outer edge.
    t.click(t.onEdge(0.7, 0))
    t.click(t.onEdge(0.7, 1))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(t.onToast).not.toHaveBeenCalled()
    // The last line split both halves it crossed.
    expect(t.topFaceAt(0.6, 0.25)).not.toBe(t.topFaceAt(0.8, 0.25))
    expect(t.topFaceAt(0.6, 0.75)).not.toBe(t.topFaceAt(0.8, 0.75))
  })

  it('a chain that runs off the face across its outer edge commits, with no toast', () => {
    const t = setup()
    t.click(t.onFace(0.5, 0.5))
    t.click(t.offFace(1.5, 0.5))
    t.click(t.offFace(1.5, 0.8))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(t.onToast).not.toHaveBeenCalled()
    expect(t.faceDrafts).toHaveBeenCalledTimes(2)
  })

  it('a chain that comes back to touch itself partway along commits, with no toast', () => {
    const t = setup()
    // A "6": down from an edge, round a loop, and back onto the first segment.
    t.click(t.onEdge(0.5, 1))
    t.click(t.onFace(0.5, 0.2))
    t.click(t.onFace(0.8, 0.2))
    t.click(t.onFace(0.8, 0.5))
    t.click(t.onFace(0.5, 0.5))
    t.tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(t.onToast).not.toHaveBeenCalled()
    expect(t.faceDrafts).toHaveBeenCalledTimes(4)
    // The loop closed a region of its own on the face.
    expect(t.topFaceAt(0.65, 0.35)).not.toBe(t.topFaceAt(0.2, 0.8))
  })
})
