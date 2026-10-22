/**
 * Click-drag-release dispatch (GitHub #52b, dragCommit.ts), driven the way
 * the Viewport drives it: a press delivered through `press`, pointer moves
 * through `move`, the release through `release`. The fake tool counts the
 * clicks it receives and keeps a simple stage, like every participating
 * tool's "idle → first point → …" machine.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Snap, Tool } from '../tools/types'
import type { Ray } from './math'
import { DragCommitGate, gestureInFlight } from './dragCommit'
import { DRAG_MOVE_THRESHOLD_PX } from './dragMove'

/** A tool whose gesture takes `points` clicks; `capturingInput` is "mid-gesture". */
class FakeTool implements Tool {
  readonly name = 'Fake'
  clicks = 0
  stage = 0
  onDragCommitted = vi.fn()
  constructor(readonly dragCommits: boolean, private readonly points = 2) {}
  onPointerMove(_s: Snap | null, _r: Ray): void { /* preview only */ }
  onPointerDown(_s: Snap | null, _r: Ray): void {
    this.clicks += 1
    this.stage = (this.stage + 1) % this.points
  }
  onKey(ev: KeyboardEvent): void { if (ev.key === 'Escape') this.stage = 0 }
  cancel(): void { this.stage = 0 }
  capturingInput(): boolean { return this.stage !== 0 }
}

const ID = 1

/** A full pointer sequence: press at (x0, y0), moves along `path`, release at the last point. */
function drive(gate: DragCommitGate, tool: Tool, x0: number, y0: number, path: [number, number][]): boolean {
  gate.press(tool, ID, x0, y0, () => tool.onPointerDown(null, RAY))
  for (const [x, y] of path) gate.move(ID, x, y)
  const [rx, ry] = path.length > 0 ? path[path.length - 1] : [x0, y0]
  return gate.release(tool, ID, rx, ry, () => tool.onPointerDown(null, RAY))
}
const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

describe('DragCommitGate — click-drag-release for two-point tools', () => {
  it('press, move past the threshold, release: two clicks, the gesture complete', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    expect(drive(gate, tool, 100, 100, [[103, 100], [120, 110], [160, 140]])).toBe(true)
    expect(tool.clicks).toBe(2)
    expect(tool.stage).toBe(0)
    expect(tool.onDragCommitted).toHaveBeenCalledTimes(1)
    expect(gate.isArmed).toBe(false)
  })

  it('press and release inside the threshold: one click, the gesture continues click-click', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    expect(drive(gate, tool, 100, 100, [[102, 101]])).toBe(false)
    expect(tool.clicks).toBe(1)
    expect(tool.capturingInput()).toBe(true)
    expect(tool.onDragCommitted).not.toHaveBeenCalled()
    // The second click, as a plain click: no drag armed (the tool was mid-gesture).
    expect(drive(gate, tool, 300, 300, [[300, 300]])).toBe(false)
    expect(tool.clicks).toBe(2)
    expect(tool.stage).toBe(0)
  })

  it('the threshold is the Select drag-move one: just under stays a click, exactly at it is a drag', () => {
    const under = new FakeTool(true)
    expect(drive(new DragCommitGate(), under, 0, 0, [[DRAG_MOVE_THRESHOLD_PX - 0.01, 0]])).toBe(false)
    expect(under.clicks).toBe(1)
    const at = new FakeTool(true)
    expect(drive(new DragCommitGate(), at, 0, 0, [[DRAG_MOVE_THRESHOLD_PX, 0]])).toBe(true)
    expect(at.clicks).toBe(2)
  })

  it('a drag that travels and comes back is still a drag (sticky, like drag-move)', () => {
    const tool = new FakeTool(true)
    expect(drive(new DragCommitGate(), tool, 50, 50, [[80, 50], [51, 50]])).toBe(true)
    expect(tool.clicks).toBe(2)
  })

  it('a release with no moves seen but far from the press still counts (the move events were coalesced)', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    gate.press(tool, ID, 10, 10, () => tool.onPointerDown(null, RAY))
    expect(gate.release(tool, ID, 90, 10, () => tool.onPointerDown(null, RAY))).toBe(true)
    expect(tool.clicks).toBe(2)
  })

  it('a drag in a later stage is ignored: only the press that STARTED the gesture arms', () => {
    // A three-point gesture (Arc: chord start, chord end, bulge).
    const gate = new DragCommitGate()
    const tool = new FakeTool(true, 3)
    expect(drive(gate, tool, 0, 0, [[60, 0]])).toBe(true) // the chord, dragged
    expect(tool.clicks).toBe(2)
    expect(tool.stage).toBe(2) // waiting for the bulge
    // Dragging during the bulge: the press is the bulge click; the release does nothing.
    expect(drive(gate, tool, 30, 30, [[30, 80]])).toBe(false)
    expect(tool.clicks).toBe(3)
    expect(tool.stage).toBe(0)
    expect(tool.onDragCommitted).toHaveBeenCalledTimes(1)
  })

  it('a press in the middle stage of a gesture never arms (a chain\'s later points)', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true, 3)
    drive(gate, tool, 0, 0, [[1, 0]]) // first point, clicked
    expect(tool.stage).toBe(1)
    expect(drive(gate, tool, 0, 0, [[90, 0]])).toBe(false) // second point: a press-drag
    expect(tool.clicks).toBe(2)
    expect(tool.stage).toBe(2)
  })

  it('a non-participating tool is unchanged: one click per press, whatever the drag', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(false)
    expect(drive(gate, tool, 0, 0, [[200, 200]])).toBe(false)
    expect(tool.clicks).toBe(1)
    expect(tool.capturingInput()).toBe(true)
    expect(gate.isArmed).toBe(false)
  })

  it('a press that does not start a gesture (a miss — the tool stays idle) never arms', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    const deliver = vi.fn() // the tool ignores the press
    expect(gate.press(tool, ID, 0, 0, deliver)).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(gate.isArmed).toBe(false)
  })

  it('Escape during the drag ends the gesture: the release delivers nothing', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    gate.press(tool, ID, 0, 0, () => tool.onPointerDown(null, RAY))
    gate.move(ID, 50, 0)
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(gate.release(tool, ID, 50, 0, () => tool.onPointerDown(null, RAY))).toBe(false)
    expect(tool.clicks).toBe(1)
  })

  it('a tool switch during the drag: the release never reaches the new tool', () => {
    const gate = new DragCommitGate()
    const first = new FakeTool(true)
    const second = new FakeTool(true)
    second.stage = 1 // mid-gesture, so only the tool identity check can stop it
    gate.press(first, ID, 0, 0, () => first.onPointerDown(null, RAY))
    gate.move(ID, 50, 0)
    expect(gate.release(second, ID, 50, 0, () => second.onPointerDown(null, RAY))).toBe(false)
    expect(second.clicks).toBe(0)
  })

  it('only the arming pointer counts: another finger neither drags nor releases it', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    gate.press(tool, ID, 0, 0, () => tool.onPointerDown(null, RAY))
    gate.move(2, 90, 90)
    expect(gate.isDragging).toBe(false)
    expect(gate.release(tool, 2, 90, 90, () => tool.onPointerDown(null, RAY))).toBe(false)
    expect(gate.isArmed).toBe(true)
    expect(gate.release(tool, ID, 1, 0, () => tool.onPointerDown(null, RAY))).toBe(false) // a click
    expect(tool.clicks).toBe(1)
  })

  it('cancel (pointercancel, blur, a new press) drops the armed press without a click', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true)
    gate.press(tool, ID, 0, 0, () => tool.onPointerDown(null, RAY))
    gate.move(ID, 50, 0)
    gate.cancel()
    expect(gate.release(tool, ID, 50, 0, () => tool.onPointerDown(null, RAY))).toBe(false)
    expect(tool.clicks).toBe(1)
  })

  it('gestureInFlight prefers the tool\'s own answer over capturingInput (Move\'s array window)', () => {
    const tool = new FakeTool(true)
    const withWindow = Object.assign(tool, { capturingInput: () => true, gestureInFlight: () => false })
    expect(gestureInFlight(withWindow)).toBe(false)
    expect(gestureInFlight(new FakeTool(true))).toBe(false)
  })
  it('spend (a typed Enter or Escape mid-drag): the release delivers nothing, the pointer stays the gate\'s until it lifts', () => {
    const gate = new DragCommitGate()
    const tool = new FakeTool(true, 3) // a chain-like tool: still in flight after the typed commit
    gate.press(tool, ID, 0, 0, () => tool.onPointerDown(null, RAY))
    gate.move(ID, 80, 0)
    gate.spend()
    expect(gate.isArmed).toBe(true)
    expect(gate.pointerId).toBe(ID)
    expect(gate.release(tool, ID, 80, 0, () => tool.onPointerDown(null, RAY))).toBe(false)
    expect(tool.clicks).toBe(1)
    expect(gate.isArmed).toBe(false)
  })
})
