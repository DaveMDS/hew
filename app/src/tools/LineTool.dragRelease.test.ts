/**
 * Line by click-drag-release (GitHub #52b): press on the start, drag, release
 * on the end draws ONE segment and ends the chain (SketchUp), where a click
 * keeps chaining. A length typed right after the release still resizes the
 * line, as after a click. Driven through the Viewport's own gate
 * (viewport/dragCommit.ts) with real pointer sequences.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { draftMock } from './draftMock'
import { DragCommitGate } from '../viewport/dragCommit'

const rayThrough = (x: number, y: number): Ray => ({ origin: [x, y, 5], direction: [0, 0, -1] })
const ground = (x: number, y: number): Snap => ({ x, y, z: 0, kind: 'ground' })

/** Ground-only scene whose history generation moves with each commit (the retype window's proof). */
function makeScene(): WasmScene {
  const dm = draftMock()
  let gen = 1n
  const baseEnd = dm.members.draft_end as unknown as (d: bigint) => string
  return {
    ...dm.members,
    history_generation: vi.fn(() => gen),
    draft_end: vi.fn((d: bigint) => { const r = baseEnd(d); gen += 1n; return r }),
    scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    pick_face: vi.fn(() => undefined),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    node_parent: vi.fn(() => undefined),
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  } as unknown as WasmScene
}

const segs = (scene: WasmScene) =>
  (scene.draft_add_segment as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[1], c[2], c[4], c[5]] as number[])

function makeTool(scene: WasmScene): LineTool {
  return new LineTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn())
}

/** World x, y ↔ screen: 100 px per meter, offset (100, 100). */
const px = (x: number, y: number): [number, number] => [100 + x * 100, 100 + y * 100]

/** One pointer move as the Viewport delivers it: the world move, then the screen move, then the gate. */
function moveTo(gate: DragCommitGate, tool: LineTool, x: number, y: number): void {
  tool.onPointerMove(ground(x, y), rayThrough(x, y))
  const [sx, sy] = px(x, y)
  tool.onPointerScreenMove(sx, sy)
  gate.move(1, sx, sy)
}

/** Press at `a`, drag through the midpoint, release at `b`. */
function dragLine(gate: DragCommitGate, tool: LineTool, a: [number, number], b: [number, number]): boolean {
  moveTo(gate, tool, a[0], a[1])
  const [ax, ay] = px(a[0], a[1])
  gate.press(tool, 1, ax, ay, () => tool.onPointerDown(ground(a[0], a[1]), rayThrough(a[0], a[1])))
  moveTo(gate, tool, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  moveTo(gate, tool, b[0], b[1])
  const [bx, by] = px(b[0], b[1])
  return gate.release(tool, 1, bx, by, () => tool.onPointerDown(ground(b[0], b[1]), rayThrough(b[0], b[1])))
}

function click(gate: DragCommitGate, tool: LineTool, x: number, y: number): void {
  moveTo(gate, tool, x, y)
  const [sx, sy] = px(x, y)
  gate.press(tool, 1, sx, sy, () => tool.onPointerDown(ground(x, y), rayThrough(x, y)))
  gate.release(tool, 1, sx, sy, () => tool.onPointerDown(ground(x, y), rayThrough(x, y)))
}

const key = (tool: LineTool, k: string) => tool.onKey({ key: k } as KeyboardEvent)

describe('LineTool — click-drag-release (#52b)', () => {
  it('a drag draws one segment and the chain is over', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    expect(dragLine(gate, tool, [0, 0], [1, 0])).toBe(true)
    expect(segs(scene)).toEqual([[0, 0, 1, 0]])
    // No rubber band follows the cursor: the next move hovers, it does not chain.
    moveTo(gate, tool, 1, 1)
    expect(tool.capturingInput()).toBe(false)
    // The next press starts a NEW line; a click there anchors it, nothing is drawn yet.
    click(gate, tool, 3, 3)
    expect(segs(scene)).toHaveLength(1)
    expect(tool.capturingInput()).toBe(true)
  })

  it('a press right after the drag (no move) starts a new line rather than chaining', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    expect(dragLine(gate, tool, [1, 0], [1, 2])).toBe(true)
    expect(segs(scene)).toEqual([[0, 0, 1, 0], [1, 0, 1, 2]])
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(2) // two lines, two drafts
  })

  it('a length typed right after the release resizes the dragged line, and the tool stays idle', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    expect(tool.statusHint()).toContain('resize the line you just drew')
    expect(tool.capturesKey('3')).toBe(true)
    key(tool, '3')
    key(tool, 'Enter')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(segs(scene)[1]).toEqual([0, 0, 3, 0])
    // Still one line, still not chaining: a move afterwards hovers.
    moveTo(gate, tool, 2, 2)
    expect(tool.capturingInput()).toBe(false)
  })

  it('after the drag, letter shortcuts are free while the retype buffer is empty', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    expect(tool.capturesKey('r')).toBe(false)
    expect(tool.capturesKey(' ')).toBe(false)
    expect(tool.capturesKey('5')).toBe(true)
  })

  it('an arrow key after the drag is an idle plane lock for the next line', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    key(tool, 'ArrowRight')
    expect(tool.capturingInput()).toBe(false)
    expect(tool.hasArmedGesture()).toBe(true) // the lock is armed
  })

  it('Escape after the drag ends it quietly, keeping the line', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    key(tool, 'Escape')
    expect(tool.capturingInput()).toBe(false)
    expect(segs(scene)).toHaveLength(1)
  })

  it('click-click is unchanged: a short press keeps chaining', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    click(gate, tool, 0, 0)
    click(gate, tool, 1, 0)
    click(gate, tool, 1, 1)
    expect(segs(scene)).toEqual([[0, 0, 1, 0], [1, 0, 1, 1]])
    expect(tool.capturingInput()).toBe(true)
  })

  it('a drag during a chain\'s later point is a plain click there: the chain continues', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    click(gate, tool, 0, 0)
    // Press on (1, 0), drag away, release: only the press counts.
    expect(dragLine(gate, tool, [1, 0], [2, 2])).toBe(false)
    expect(segs(scene)).toEqual([[0, 0, 1, 0]])
    expect(tool.capturingInput()).toBe(true)
  })
  it('after the drag the tool reads as not armed to the host, yet Escape still ends it', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    expect(tool.hasArmedGesture()).toBe(false)
    expect(tool.gestureInFlight()).toBe(false)
    key(tool, 'Escape')
    expect(tool.capturingInput()).toBe(false)
    expect(segs(scene)).toHaveLength(1)
  })

  it('the next press resolves as a first click: no old anchor or plane in the snap constraint', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    // Before: an anchored chain hands its anchor to the snap service.
    click(gate, tool, 0, 0)
    expect(tool.snapConstraint(rayThrough(1, 1))?.anchor).toEqual([0, 0, 0])
    key(tool, 'Escape')
    dragLine(gate, tool, [0, 0], [1, 0])
    // No move, no hover (touch): the constraint is the idle one.
    expect(tool.snapConstraint(rayThrough(3, 3))).toBeNull()
  })

  it('a release that commits nothing keeps the chain anchored, exactly as after a click', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    moveTo(gate, tool, 0, 0)
    gate.press(tool, 1, 100, 100, () => tool.onPointerDown(ground(0, 0), rayThrough(0, 0)))
    gate.move(1, 300, 100)
    // The release lands with no snap and a ray that never meets the ground.
    const skyward: Ray = { origin: [2, 0, 5], direction: [0, 0, 1] }
    expect(gate.release(tool, 1, 300, 100, () => tool.onPointerDown(null, skyward))).toBe(true)
    expect(segs(scene)).toHaveLength(0)
    expect(tool.capturingInput()).toBe(true)
    expect(tool.gestureInFlight()).toBe(true)
    // The first point survived: a click draws from it.
    click(gate, tool, 1, 1)
    expect(segs(scene)).toHaveLength(1)
    expect(segs(scene)[0].slice(0, 2)).toEqual([0, 0])
    expect(segs(scene)[0][2]).toBeCloseTo(1, 3)
    expect(segs(scene)[0][3]).toBeCloseTo(1, 3)
  })

  it('Shift while typing the retype length (a quote mark) keeps the dragged line and its buffer', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    dragLine(gate, tool, [0, 0], [1, 0])
    key(tool, '3')
    tool.setShiftHeld(true)
    key(tool, 'Shift') // the host routes the bare Shift keydown to onKey too
    key(tool, '"')
    tool.setShiftHeld(false)
    key(tool, 'Enter')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(segs(scene)[1][0]).toBeCloseTo(0, 9)
    expect(segs(scene)[1][2]).toBeCloseTo(3 * 0.0254, 9)
  })

  it('modifiers and arrow keys DURING the drag work: an arrow lock holds the dragged segment to red', () => {
    const scene = makeScene()
    const tool = makeTool(scene)
    const gate = new DragCommitGate()
    moveTo(gate, tool, 0, 0)
    gate.press(tool, 1, 100, 100, () => tool.onPointerDown(ground(0, 0), rayThrough(0, 0)))
    moveTo(gate, tool, 0.8, 0.1)
    key(tool, 'ArrowRight')
    moveTo(gate, tool, 1.5, 0.6)
    // The host resolves the release snap under the lock: on red at x = 1.5.
    expect(gate.release(tool, 1, 250, 160, () => tool.onPointerDown({ x: 1.5, y: 0, z: 0, kind: 'on-axis' }, rayThrough(1.5, 0.6)))).toBe(true)
    expect(segs(scene)).toEqual([[0, 0, 1.5, 0]])
    expect(tool.gestureInFlight()).toBe(false)
  })
})
