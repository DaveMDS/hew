/**
 * RotateTool on construction guides: the selected guides
 * (`setGuideSelection`) rotate, copy, fan, and retype in the nodes' own
 * kernel calls (`transform_selection`, `duplicate_selection_array`); the
 * pivot click on a guide takes it for the gesture only with nothing
 * selected, and is just a pivot with a selection — SketchUp's rule —
 * against a mocked WasmScene. `isMac` is mocked to true so a bare Alt tap
 * toggles copy mode (see RotateTool.test.ts).
 */

import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RotateTool } from './RotateTool'
import type { Snap } from './types'
import type { Ray } from '../viewport/math'
import type { NodeRef } from '../panels/treeModel'

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, isMac: true, COPY_MODIFIER_KEY: 'Alt', COPY_MODIFIER_LABEL: 'Option' }
})

/** A ray straight down through (x, y): the ground rotation plane at z = 0. */
const rayAt = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })
const snapAt = (x: number, y: number): Snap => ({ x, y, z: 0, kind: 'ground' })
const key = (k: string): KeyboardEvent =>
  ({ key: k, repeat: false, preventDefault: () => { /* no-op */ } }) as unknown as KeyboardEvent
const type = (tool: RotateTool, text: string): void => {
  for (const ch of text) tool.onKey(key(ch))
}
/** The angle of a row-major 3×4 affine rotating about world Z. */
const thetaOf = (affine: Float64Array): number => Math.atan2(affine[4], affine[0])

/** The members RotateTool calls on a guide gesture. Every commit, undo and
 *  redo moves the history generation, as the kernel's would. */
function makeScene() {
  const state = { gen: 1n, nextGuide: 50n, nextNode: 100n }
  const bump = () => { state.gen += 1n }
  return {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    guide_kind: vi.fn(() => 'line'),
    guide_geometry: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0])),
    transform_guide: vi.fn(),
    duplicate_guide_array: vi.fn(),
    // Copies in creation order: every source's copy 1, then copy 2, …
    duplicate_selection_array: vi.fn(
      (_kinds: Uint8Array, ids: BigUint64Array, guides: BigUint64Array, _affine: Float64Array, count: number) => {
        bump()
        const roots: { kind: string; id: bigint }[] = []
        const copies: bigint[] = []
        for (let k = 0; k < count; k++) {
          for (let i = 0; i < ids.length; i++) roots.push({ kind: 'object', id: state.nextNode++ })
          for (let i = 0; i < guides.length; i++) copies.push(state.nextGuide++)
        }
        return { roots: () => roots, guides: () => BigUint64Array.from(copies), free: () => { /* no-op */ } }
      },
    ),
    transform_selection: vi.fn(
      (_kinds: Uint8Array, _ids: BigUint64Array, _sketches: BigUint64Array, _guides: BigUint64Array, _affine: Float64Array) => bump(),
    ),
    history_generation: vi.fn(() => state.gen),
    max_array_count: vi.fn(() => 1000),
    scene_undo: vi.fn(() => { bump(); return { free: () => { /* no-op */ } } }),
    scene_redo: vi.fn(() => { bump(); return { free: () => { /* no-op */ } } }),
  }
}

/** A tool with `nodes` and `guides` as the app's selection and a guide
 *  acquirer hitting `hit`; the hooks mirror the Viewport (MoveTool.guides
 *  test's `makeTool`), each pushing the app selection back into the tool. */
function makeTool(opts: { guides?: bigint[]; hit?: bigint | null; nodes?: NodeRef[] } = {}) {
  const scene = makeScene()
  const preview = new THREE.Group()
  const onToast = vi.fn()
  const app = { nodes: opts.nodes ?? [], guides: opts.guides ?? [] }
  const push = () => {
    tool.setSelection(app.nodes)
    tool.setGuideSelection(app.guides)
  }
  const onCommit = vi.fn((nodes: NodeRef[]) => {
    app.nodes = nodes
    app.guides = []
    push()
  })
  const tool = new RotateTool(scene as never, preview, null, app.nodes, onCommit, onToast)
  tool.setGuideSelection(app.guides)
  const acquire = vi.fn(() => {
    const g = opts.hit ?? null
    if (g !== null) {
      app.nodes = []
      app.guides = [g]
      push()
    }
    return g
  })
  const onGuides = vi.fn((guides: bigint[]) => {
    app.guides = guides
    push()
  })
  tool.setGuideHooks(acquire, onGuides)
  const nodeAcquire = vi.fn(() => null)
  const release = vi.fn(() => {
    app.nodes = []
    app.guides = []
    push()
  })
  tool.setSelectionAcquirer(nodeAcquire, release)
  return { tool, scene, preview, onToast, onCommit, app, acquire, onGuides, nodeAcquire }
}

/** Pivot at the origin, reference along +X: the sweep is about +Z. */
function setPivotAndReference(tool: RotateTool): void {
  tool.onPointerMove(snapAt(0, 0), rayAt(0, 0))
  tool.onPointerDown(snapAt(0, 0), rayAt(0, 0))
  tool.onPointerDown(snapAt(1, 0), rayAt(1, 0))
}

/** A full quarter turn about +Z through the origin. */
function rotateQuarter(tool: RotateTool): void {
  setPivotAndReference(tool)
  tool.onPointerMove(snapAt(0, 1), rayAt(0, 1))
  tool.onPointerDown(snapAt(0, 1), rayAt(0, 1))
}

/** The nodes, guides, and angle of a `transform_selection` call. */
const rotated = (call: unknown[]): { ids: bigint[]; guides: bigint[]; theta: number } => ({
  ids: [...(call[1] as BigUint64Array)],
  guides: [...(call[3] as BigUint64Array)],
  theta: thetaOf(call[4] as Float64Array),
})
/** The sources, step angle, and count of a `duplicate_selection_array` call. */
const copied = (call: unknown[]): { ids: bigint[]; guides: bigint[]; theta: number; count: number } => ({
  ids: [...(call[1] as BigUint64Array)],
  guides: [...(call[2] as BigUint64Array)],
  theta: thetaOf(call[3] as Float64Array),
  count: call[4] as number,
})

describe('RotateTool — rotating selected guides', () => {
  it('commits one transform_selection by the swept angle; the guide stays selected', () => {
    const t = makeTool({ guides: [7n] })
    setPivotAndReference(t.tool)
    expect(t.preview.children.some((c) => c instanceof THREE.LineSegments)).toBe(true) // the ghost
    t.tool.onPointerMove(snapAt(0, 1), rayAt(0, 1))
    t.tool.onPointerDown(snapAt(0, 1), rayAt(0, 1))

    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    const call = rotated(t.scene.transform_selection.mock.calls[0])
    expect(call.ids).toEqual([])
    expect(call.guides).toEqual([7n])
    expect(call.theta).toBeCloseTo(Math.PI / 2, 9)
    expect(t.scene.transform_guide).not.toHaveBeenCalled()
    expect(t.app.guides).toEqual([7n])
    expect(t.onCommit).not.toHaveBeenCalled()
  })

  it('rotates nodes and every selected guide in one call, and keeps them selected', () => {
    const node: NodeRef = { kind: 'object', id: 1n }
    const t = makeTool({ nodes: [node], guides: [7n, 8n] })
    rotateQuarter(t.tool)
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    const call = rotated(t.scene.transform_selection.mock.calls[0])
    expect([call.ids, call.guides]).toEqual([[1n], [7n, 8n]])
    expect(t.app.nodes).toEqual([node])
    expect(t.app.guides).toEqual([7n, 8n])
  })

  it('the pivot click on ANOTHER guide only sets the pivot — the selected guide rotates', () => {
    const t = makeTool({ guides: [7n], hit: 9n })
    rotateQuarter(t.tool)
    expect(t.acquire).not.toHaveBeenCalled()
    expect(rotated(t.scene.transform_selection.mock.calls[0]).guides).toEqual([7n])
    expect(t.app.guides).toEqual([7n])
  })

  it('a typed angle rotates the guides exactly; a retyped one redoes it', () => {
    const t = makeTool({ guides: [7n, 8n] })
    setPivotAndReference(t.tool)
    t.tool.onPointerMove(snapAt(0, 1), rayAt(0, 1))
    type(t.tool, '30')
    t.tool.onKey(key('Enter'))
    expect(rotated(t.scene.transform_selection.mock.calls[0]).theta).toBeCloseTo(Math.PI / 6, 9)
    type(t.tool, '45')
    t.tool.onKey(key('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    const redo = rotated(t.scene.transform_selection.mock.calls[1])
    expect(redo.guides).toEqual([7n, 8n])
    expect(redo.theta).toBeCloseTo(Math.PI / 4, 9)
  })

  it('a refused rotation toasts the kernel error and lands nothing', () => {
    const t = makeTool({ guides: [7n] })
    t.scene.transform_selection.mockImplementationOnce(() => {
      throw new Error('UnknownGuide: no such guide in this document')
    })
    rotateQuarter(t.tool)
    expect(t.onToast).toHaveBeenCalledTimes(1)
    expect(t.onGuides).not.toHaveBeenCalled()
  })
})

describe('RotateTool — copying guides', () => {
  it('copy mode commits one duplicate_selection_array (count 1); the copies become the selected guides', () => {
    const t = makeTool({ guides: [7n, 8n] })
    t.tool.onKey(key('Alt'))
    rotateQuarter(t.tool)
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.scene.duplicate_guide_array).not.toHaveBeenCalled()
    const call = copied(t.scene.duplicate_selection_array.mock.calls[0])
    expect([call.guides, call.count]).toEqual([[7n, 8n], 1])
    expect(call.theta).toBeCloseTo(Math.PI / 2, 9)
    expect(t.app.guides).toEqual([50n, 51n])
  })

  it('copies nodes and guides in the one call; all the copies become the selection', () => {
    const t = makeTool({ nodes: [{ kind: 'object', id: 1n }], guides: [7n] })
    t.tool.onKey(key('Alt'))
    rotateQuarter(t.tool)
    const call = copied(t.scene.duplicate_selection_array.mock.calls[0])
    expect([call.ids, call.guides]).toEqual([[1n], [7n]])
    expect(t.app.nodes).toEqual([{ kind: 'object', id: 100n }])
    expect(t.app.guides).toEqual([50n])
  })

  it('/6 retracts the copy and fans six copies from the ORIGINAL guide, one call on the step', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onKey(key('Alt'))
    rotateQuarter(t.tool)
    type(t.tool, '/6')
    t.tool.onKey(key('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    const call = copied(t.scene.duplicate_selection_array.mock.calls[1])
    expect([call.guides, call.count]).toEqual([[7n], 6])
    expect(call.theta).toBeCloseTo(Math.PI / 12, 9)
    expect(t.app.guides).toEqual([51n, 52n, 53n, 54n, 55n, 56n]) // every copy, like nodes
  })
})

describe('RotateTool — a pivot click on a guide with nothing selected takes it, for the gesture only', () => {
  it('the clicked guide rotates and the selection is empty afterwards', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onPointerMove(snapAt(0, 0), rayAt(0, 0))
    t.tool.onPointerDown(snapAt(0, 0), rayAt(0, 0))
    expect(t.app.guides).toEqual([9n]) // highlighted while it rotates
    expect(t.nodeAcquire).not.toHaveBeenCalled()
    t.tool.onPointerDown(snapAt(1, 0), rayAt(1, 0))
    t.tool.onPointerMove(snapAt(0, 1), rayAt(0, 1))
    t.tool.onPointerDown(snapAt(0, 1), rayAt(0, 1))
    expect(rotated(t.scene.transform_selection.mock.calls[0]).guides).toEqual([9n])
    expect(t.app.guides).toEqual([])
  })

  it('Escape at the reference stage gives the selection back', () => {
    const t = makeTool({ hit: 9n })
    setPivotAndReference(t.tool)
    t.tool.onKey(key('Escape'))
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.app.guides).toEqual([])
  })

  it('a zero sweep rotates nothing and gives the selection back', () => {
    const t = makeTool({ hit: 9n })
    setPivotAndReference(t.tool)
    t.tool.onPointerDown(snapAt(1, 0), rayAt(1, 0))
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.app.guides).toEqual([])
  })

  it('a fan of a click-taken guide leaves nothing selected', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onKey(key('Alt'))
    rotateQuarter(t.tool)
    type(t.tool, '3x')
    t.tool.onKey(key('Enter'))
    expect(copied(t.scene.duplicate_selection_array.mock.calls[1]).guides).toEqual([9n])
    expect(t.app.guides).toEqual([])
  })

  it('with nodes selected, a pivot click on a guide is their pivot', () => {
    const t = makeTool({ hit: 9n, nodes: [{ kind: 'object', id: 1n }] })
    rotateQuarter(t.tool)
    expect(t.acquire).not.toHaveBeenCalled()
    const call = rotated(t.scene.transform_selection.mock.calls[0])
    expect([call.ids, call.guides]).toEqual([[1n], []])
  })

  it('a miss falls through to the node acquirer, then the hint', () => {
    const t = makeTool({ hit: null })
    t.tool.onPointerMove(snapAt(0, 0), rayAt(0, 0))
    t.tool.onPointerDown(snapAt(0, 0), rayAt(0, 0))
    expect(t.nodeAcquire).toHaveBeenCalledTimes(1)
    expect(t.onToast).toHaveBeenCalledWith('Click an object to rotate it')
  })
})
