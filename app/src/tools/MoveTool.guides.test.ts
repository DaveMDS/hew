/**
 * MoveTool on construction guides: the selected guides (`setGuideSelection`)
 * move, copy, array, and retype in the nodes' own kernel calls
 * (`transform_selection`, `duplicate_selection_array`), and the click that
 * takes a guide (`setGuideHooks`) selects it for the gesture only — against
 * a mocked WasmScene. `isMac` is mocked to true so a bare Alt tap toggles
 * copy mode (see MoveTool.test.ts).
 */

import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { MoveTool } from './MoveTool'
import type { Snap } from './types'
import type { Ray } from '../viewport/math'
import type { NodeRef } from '../panels/treeModel'

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, isMac: true, COPY_MODIFIER_KEY: 'Alt', COPY_MODIFIER_LABEL: 'Option' }
})

const ray: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }
const snapAt = (x: number, y = 0, z = 0): Snap => ({ x, y, z, kind: 'ground' })
const key = (k: string): KeyboardEvent =>
  ({ key: k, repeat: false, preventDefault: () => { /* no-op */ } }) as unknown as KeyboardEvent
const type = (tool: MoveTool, text: string): void => {
  for (const ch of text) tool.onKey(key(ch))
}
const translationOf = (affine: Float64Array): number[] => [affine[3], affine[7], affine[11]]

/** The members MoveTool calls on a guide gesture. Every commit, undo and
 *  redo moves the history generation, as the kernel's would. */
function makeScene() {
  const state = { gen: 1n, nextGuide: 50n, nextNode: 100n }
  const bump = () => { state.gen += 1n }
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    guide_kind: vi.fn(() => 'line'),
    guide_geometry: vi.fn(() => new Float64Array([0, 0, 0, 0, 1, 0])),
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
  return scene
}

/**
 * A tool with `nodes` and `guides` as the app's selection and a guide
 * acquirer that hits `hit` (null: a miss). The hooks mirror the Viewport:
 * the acquirer selects the guide it names, a node commit replaces the whole
 * selection with its nodes, a guide landing sets the guides beside them,
 * and the release empties everything — each pushed back into the tool.
 */
function makeTool(opts: { guides?: bigint[]; hit?: bigint | null; nodes?: NodeRef[] } = {}) {
  const scene = makeScene()
  const preview = new THREE.Group()
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
  const onToast = vi.fn()
  const tool = new MoveTool(scene as never, preview, null, app.nodes, onCommit, onToast)
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
  return { tool, scene, preview, onCommit, onToast, app, acquire, onGuides, nodeAcquire, release }
}

/** Click a base point at the origin, then a destination at (x, 0, 0). */
function clickMove(tool: MoveTool, x: number): void {
  tool.onPointerDown(snapAt(0), ray)
  tool.onPointerMove(snapAt(x), ray)
  tool.onPointerDown(snapAt(x), ray)
}

/** The guides and the translation of a `transform_selection` call. */
const moved = (call: unknown[]): { ids: bigint[]; guides: bigint[]; by: number[] } => ({
  ids: [...(call[1] as BigUint64Array)],
  guides: [...(call[3] as BigUint64Array)],
  by: translationOf(call[4] as Float64Array),
})
/** The sources, the step, and the count of a `duplicate_selection_array` call. */
const copied = (call: unknown[]): { ids: bigint[]; guides: bigint[]; by: number[]; count: number } => ({
  ids: [...(call[1] as BigUint64Array)],
  guides: [...(call[2] as BigUint64Array)],
  by: translationOf(call[3] as Float64Array),
  count: call[4] as number,
})

describe('MoveTool — moving selected guides', () => {
  it('commits one transform_selection by the clicked vector and keeps the guide selected', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onPointerDown(snapAt(0), ray)
    // The guide's ghost, and the dashed base→destination line.
    expect(t.preview.children).toHaveLength(2)
    expect(t.preview.children.filter((c) => (c as THREE.LineSegments).material instanceof THREE.LineDashedMaterial))
      .toHaveLength(1)
    t.tool.onPointerMove(snapAt(2), ray)
    t.tool.onPointerDown(snapAt(2), ray)

    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(moved(t.scene.transform_selection.mock.calls[0])).toEqual({ ids: [], guides: [7n], by: [2, 0, 0] })
    expect(t.scene.transform_guide).not.toHaveBeenCalled()
    expect(t.onGuides).toHaveBeenLastCalledWith([7n])
    expect(t.app.guides).toEqual([7n])
    expect(t.onCommit).not.toHaveBeenCalled() // no node selection churn
    expect(t.preview.children).toHaveLength(0)
  })

  it('moves every selected guide in the one call', () => {
    const t = makeTool({ guides: [7n, 8n, 9n] })
    clickMove(t.tool, 2)
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(moved(t.scene.transform_selection.mock.calls[0]).guides).toEqual([7n, 8n, 9n])
    expect(t.app.guides).toEqual([7n, 8n, 9n])
  })

  it('moves nodes and guides together in one call, and keeps both selected', () => {
    const node: NodeRef = { kind: 'object', id: 1n }
    const t = makeTool({ nodes: [node], guides: [7n, 8n] })
    t.tool.onPointerDown(snapAt(0), ray)
    // One ghost group (the node's and the guides') and the dashed line.
    expect(t.preview.children).toHaveLength(2)
    t.tool.onPointerMove(snapAt(3), ray)
    t.tool.onPointerDown(snapAt(3), ray)

    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(moved(t.scene.transform_selection.mock.calls[0])).toEqual({ ids: [1n], guides: [7n, 8n], by: [3, 0, 0] })
    expect(t.app.nodes).toEqual([node])
    expect(t.app.guides).toEqual([7n, 8n])
  })

  it('a typed distance along a locked axis moves the guide exactly that far', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onPointerDown(snapAt(0), ray)
    t.tool.onKey(key('ArrowLeft')) // lock green (Y)
    type(t.tool, '3')
    t.tool.onKey(key('Enter'))
    expect(moved(t.scene.transform_selection.mock.calls[0]).by).toEqual([0, 3, 0])
  })

  it('a click is the selected guides\' base point, on another guide too — nothing is acquired', () => {
    const t = makeTool({ guides: [7n], hit: 9n })
    clickMove(t.tool, 1)
    expect(t.acquire).not.toHaveBeenCalled()
    expect(t.nodeAcquire).not.toHaveBeenCalled()
    expect(moved(t.scene.transform_selection.mock.calls[0]).guides).toEqual([7n])
    expect(t.app.guides).toEqual([7n])
  })

  it('a retyped distance redoes the move: one undo, the same guides moved again', () => {
    const t = makeTool({ guides: [7n, 8n] })
    clickMove(t.tool, 2)
    type(t.tool, '5')
    t.tool.onKey(key('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(2)
    expect(moved(t.scene.transform_selection.mock.calls[1])).toEqual({ ids: [], guides: [7n, 8n], by: [5, 0, 0] })
  })

  it('a refused move toasts the kernel error and lands nothing', () => {
    const t = makeTool({ guides: [7n] })
    t.scene.transform_selection.mockImplementationOnce(() => {
      throw new Error('UnknownGuide: no such guide in this document')
    })
    clickMove(t.tool, 2)
    expect(t.onToast).toHaveBeenCalledTimes(1)
    expect(t.onGuides).not.toHaveBeenCalled()
  })

  it('with a guide selected the hover highlights nothing; with nothing selected it offers both', () => {
    expect(makeTool({ guides: [7n] }).tool.clickAcquire()).toBeNull()
    expect(makeTool().tool.clickAcquire()).toEqual({ guides: true, nodes: true })
  })
})

describe('MoveTool — copying guides', () => {
  it('copy mode commits one duplicate_selection_array (count 1); the copies become the selected guides', () => {
    const t = makeTool({ guides: [7n, 8n] })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 1)
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.scene.duplicate_guide_array).not.toHaveBeenCalled()
    expect(copied(t.scene.duplicate_selection_array.mock.calls[0])).toEqual({ ids: [], guides: [7n, 8n], by: [1, 0, 0], count: 1 })
    expect(t.app.guides).toEqual([50n, 51n])
  })

  it('copies nodes and guides in the one call; all the copies become the selection', () => {
    const t = makeTool({ nodes: [{ kind: 'object', id: 1n }], guides: [7n] })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 1)
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    expect(copied(t.scene.duplicate_selection_array.mock.calls[0])).toEqual({ ids: [1n], guides: [7n], by: [1, 0, 0], count: 1 })
    expect(t.app.nodes).toEqual([{ kind: 'object', id: 100n }])
    expect(t.app.guides).toEqual([50n])
  })

  it('3x retracts the single copy and lays three from the ORIGINAL guide in one call', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 1)
    type(t.tool, '3x')
    t.tool.onKey(key('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(copied(t.scene.duplicate_selection_array.mock.calls[1])).toEqual({ ids: [], guides: [7n], by: [1, 0, 0], count: 3 })
    expect(t.app.guides).toEqual([51n, 52n, 53n]) // every copy, like nodes
  })

  it('/4 divides the committed distance into four steps', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 2)
    type(t.tool, '/4')
    t.tool.onKey(key('Enter'))
    const call = copied(t.scene.duplicate_selection_array.mock.calls[1])
    expect(call.count).toBe(4)
    expect(call.by).toEqual([0.5, 0, 0])
  })

  it('a distance typed after an array re-spaces it from the original guide', () => {
    const t = makeTool({ guides: [7n] })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 1)
    type(t.tool, '3x'); t.tool.onKey(key('Enter'))
    type(t.tool, '2'); t.tool.onKey(key('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(copied(t.scene.duplicate_selection_array.mock.calls[2])).toEqual({ ids: [], guides: [7n], by: [2, 0, 0], count: 3 })
  })
})

describe('MoveTool — a click on a guide takes it, for the gesture only', () => {
  it('with nothing selected, the clicked guide moves and the selection is empty afterwards', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onPointerDown(snapAt(0), ray)
    expect(t.app.guides).toEqual([9n]) // highlighted while it moves
    expect(t.nodeAcquire).not.toHaveBeenCalled()
    t.tool.onPointerMove(snapAt(2), ray)
    t.tool.onPointerDown(snapAt(2), ray)
    expect(moved(t.scene.transform_selection.mock.calls[0]).guides).toEqual([9n])
    expect(t.app.guides).toEqual([])
  })

  it('the next click takes another guide: nothing stays selected between gestures', () => {
    const t = makeTool({ hit: 9n })
    clickMove(t.tool, 2)
    clickMove(t.tool, 2)
    expect(t.acquire).toHaveBeenCalledTimes(2)
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(2)
  })

  it('Escape mid-gesture gives the selection back', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onPointerDown(snapAt(0), ray)
    t.tool.onKey(key('Escape'))
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.app.guides).toEqual([])
  })

  it('a second click on the base point moves nothing and gives the selection back', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onPointerDown(snapAt(0), ray)
    t.tool.onPointerDown(snapAt(0), ray)
    expect(t.scene.transform_selection).not.toHaveBeenCalled()
    expect(t.app.guides).toEqual([])
  })

  it('a retyped distance re-lands the click-taken guide and leaves nothing selected', () => {
    const t = makeTool({ hit: 9n })
    clickMove(t.tool, 2)
    type(t.tool, '5')
    t.tool.onKey(key('Enter'))
    expect(moved(t.scene.transform_selection.mock.calls[1])).toEqual({ ids: [], guides: [9n], by: [5, 0, 0] })
    expect(t.app.guides).toEqual([])
  })

  it('a copy of a click-taken guide, and its array, leave nothing selected', () => {
    const t = makeTool({ hit: 9n })
    t.tool.onKey(key('Alt'))
    clickMove(t.tool, 1)
    expect(t.app.guides).toEqual([])
    type(t.tool, '2x')
    t.tool.onKey(key('Enter'))
    expect(copied(t.scene.duplicate_selection_array.mock.calls[1]).guides).toEqual([9n])
    expect(t.app.guides).toEqual([])
  })

  it('with nodes selected, a click on a guide is their base point', () => {
    const t = makeTool({ hit: 9n, nodes: [{ kind: 'object', id: 1n }] })
    clickMove(t.tool, 1)
    expect(t.acquire).not.toHaveBeenCalled()
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(moved(t.scene.transform_selection.mock.calls[0])).toEqual({ ids: [1n], guides: [], by: [1, 0, 0] })
  })

  it('a miss falls through to the node acquirer, then the hint', () => {
    const t = makeTool({ hit: null })
    t.tool.onPointerDown(snapAt(0), ray)
    expect(t.nodeAcquire).toHaveBeenCalledTimes(1)
    expect(t.onToast).toHaveBeenCalledWith('Click an object to move it')
  })
})
