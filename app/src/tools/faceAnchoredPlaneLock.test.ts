/**
 * An arrow key pressed AFTER a face-anchored first click (GitHub #51, the
 * owner's "Rectangle on the origin corner draws only on the green plane").
 *
 * Reproduced in the web shell: two boxes, one with a corner at the origin.
 * With no lock armed, a first click on that corner anchors on the most
 * camera-facing face through it (the green y = 0 wall) — by design. But
 * from there no arrow key reached the ground: the mid-gesture re-lock
 * (`nextGestureLockPlane`, drawPlane.ts) only ran for PLANE-anchored
 * gestures, so a face-anchored one ignored every arrow and the rectangle
 * stayed on the wall. An arrow pressed BEFORE the click already worked.
 *
 * The contract: an arrow lock always wins over the face pick. Pressed
 * after a face-anchored first click, it moves the gesture onto the locked
 * plane through the anchor, exactly as if it had been pressed before the
 * click (a sketch on that plane, not an imprint on the face); the same
 * arrow again, or Down, puts the gesture back on the face it started on.
 *
 * Rectangle, Circle, Polygon and Arc share the rule.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RectangleTool } from './RectangleTool'
import { CircleTool } from './CircleTool'
import { PolygonTool } from './PolygonTool'
import { ArcTool } from './ArcTool'
import { draftMock } from './draftMock'
import { isGroundPlane } from './drawPlane'
import type { EditContext, Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

type V3 = [number, number, number]

/** Looking at the green wall from in front (-Y), slightly above. */
const RAY: Ray = { origin: [0.2, -5, 0.5], direction: [0, 1, 0] }

const OBJECT = 7n
const FACE = 3n

function makeSnap(p: readonly [number, number, number]): Snap {
  return { x: p[0], y: p[1], z: p[2], kind: 'plane' }
}

function key(k: string, repeat = false): KeyboardEvent {
  return { key: k, repeat, preventDefault: () => { /* no-op */ } } as unknown as KeyboardEvent
}

/** A plain top-level object whose y = 0 wall (normal -Y) is under every ray. */
function makeScene() {
  const dm = draftMock()
  const scene = {
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => 1n),
    pick_face: vi.fn(() => ({
      object: () => OBJECT,
      face: () => FACE,
      depth: () => 5,
      instance: () => undefined,
      free: vi.fn(),
    })),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => undefined),
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array([0, -1, 0])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, -1, 0])),
    ...dm.members,
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  return { scene: scene as unknown as WasmScene, log: dm.log }
}

/** [origin, normal] of every plane draft begun, in order. */
function planeBegins(log: ReturnType<typeof draftMock>['log']): number[][] {
  return log.begins.filter((b) => b.kind === 'plane').map((b) => (b.args as number[]).slice(0, 6))
}
function faceBegins(log: ReturnType<typeof draftMock>['log']): number {
  return log.begins.filter((b) => b.kind === 'face').length
}

interface ToolUnderTest {
  onPointerDown(snap: Snap | null, ray: Ray): void
  onPointerMove(snap: Snap | null, ray: Ray): void
  onKey(ev: KeyboardEvent): void
  capturingInput(): boolean
  statusHint(): string
  setEditContext(ctx: EditContext): void
  snapConstraint(ray: Ray): { constraintPlane?: { point: V3; normal: V3 } } | null
}

interface Driver {
  name: string
  make(scene: WasmScene): ToolUnderTest
  /** The rest of the gesture after the anchor, with every point on the
   *  plane through the origin whose normal is `n` (one coordinate zero). */
  finish(tool: ToolUnderTest, n: 'x' | 'y' | 'z'): void
}

/** Two in-plane points for the plane with the given zero coordinate. */
function onPlane(n: 'x' | 'y' | 'z'): { b: V3; c: V3 } {
  if (n === 'z') return { b: [0.6, -0.4, 0], c: [0.3, -0.5, 0] }
  if (n === 'y') return { b: [0.6, 0, 0.4], c: [0.3, 0, 0.5] }
  return { b: [0, -0.6, 0.4], c: [0, -0.3, 0.5] }
}

const DRIVERS: Driver[] = [
  {
    name: 'Rectangle',
    make: (s) => new RectangleTool(s, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as ToolUnderTest,
    finish: (t, n) => t.onPointerDown(makeSnap(onPlane(n).b), RAY),
  },
  {
    name: 'Circle',
    make: (s) => new CircleTool(s, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as ToolUnderTest,
    finish: (t, n) => t.onPointerDown(makeSnap(onPlane(n).b), RAY),
  },
  {
    name: 'Polygon',
    make: (s) => new PolygonTool(s, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as ToolUnderTest,
    finish: (t, n) => t.onPointerDown(makeSnap(onPlane(n).b), RAY),
  },
  {
    name: 'Arc',
    make: (s) => new ArcTool(s, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as ToolUnderTest,
    finish: (t, n) => {
      const { b, c } = onPlane(n)
      t.onPointerDown(makeSnap(b), RAY)
      t.onPointerMove(makeSnap(c), RAY)
      t.onPointerDown(makeSnap(c), RAY)
    },
  },
]

describe.each(DRIVERS)('$name — an arrow after a face-anchored first click (#51)', ({ make, finish }) => {
  it('with no lock, a click on the wall anchors on the wall (the starting point of the report)', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    finish(tool, 'y')
    expect(faceBegins(log)).toBe(1)
    expect(planeBegins(log)).toHaveLength(0)
  })

  it('Up moves the gesture onto the ground through the anchor', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    expect(tool.capturingInput()).toBe(true)
    tool.onKey(key('ArrowUp'))
    // The snap is no longer held to the wall's plane.
    const c = tool.snapConstraint(RAY)
    expect(c === null || c.constraintPlane === undefined).toBe(true)
    finish(tool, 'z')
    expect(faceBegins(log)).toBe(0)
    const begins = planeBegins(log)
    expect(begins).toHaveLength(1)
    const [px, py, pz, nx, ny, nz] = begins[0]
    expect(isGroundPlane([px, py, pz], [nx, ny, nz])).toBe(true)
  })

  it('Right moves it onto the red plane through the anchor', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowRight'))
    expect(tool.snapConstraint(RAY)?.constraintPlane?.normal).toEqual([1, 0, 0])
    finish(tool, 'x')
    expect(faceBegins(log)).toBe(0)
    expect(planeBegins(log)).toEqual([[0, 0, 0, 1, 0, 0]])
  })

  it('the same arrow again puts the gesture back on the face it started on', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowUp'))
    tool.onKey(key('ArrowUp'))
    expect(tool.snapConstraint(RAY)?.constraintPlane?.normal).toEqual([0, -1, 0])
    finish(tool, 'y')
    expect(planeBegins(log)).toHaveLength(0)
    expect(faceBegins(log)).toBe(1)
  })

  it('a held arrow (keydown autorepeat) does not flip the gesture back to the face', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowUp'))
    tool.onKey(key('ArrowUp', true))
    tool.onKey(key('ArrowUp', true))
    finish(tool, 'z')
    expect(faceBegins(log)).toBe(0)
    const begins = planeBegins(log)
    expect(begins).toHaveLength(1)
    expect(isGroundPlane([begins[0][0], begins[0][1], begins[0][2]], [begins[0][3], begins[0][4], begins[0][5]])).toBe(true)
  })

  it('Down after a lock also returns to the face; Down on the face alone changes nothing', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowDown'))
    tool.onKey(key('ArrowRight'))
    tool.onKey(key('ArrowUp')) // switch locks
    tool.onKey(key('ArrowDown'))
    finish(tool, 'y')
    expect(planeBegins(log)).toHaveLength(0)
    expect(faceBegins(log)).toBe(1)
  })

  it('inside an entered object the gesture stays on that object\'s face', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.setEditContext({ kind: 'object', id: OBJECT })
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowUp'))
    finish(tool, 'y')
    expect(planeBegins(log)).toHaveLength(0)
    expect(faceBegins(log)).toBe(1)
  })
})

describe.each(DRIVERS.slice(0, 3))('$name — Esc after a face-released stage', ({ make, finish }) => {
  it('cancels cleanly, keeps the ground lock (an in-gesture abort keeps the aim), and leaves no face to return to', () => {
    const { scene, log } = makeScene()
    const tool = make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY) // face click
    tool.onKey(key('ArrowUp')) // released onto the ground, fromFace set
    expect(tool.capturingInput()).toBe(true)
    tool.onKey(key('Escape'))
    expect(tool.capturingInput()).toBe(false)
    expect(tool.statusHint()).toContain('Locked to the blue plane')
    // The next gesture starts fresh on the locked ground plane: no stale
    // fromFace sends it back to the wall.
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    finish(tool, 'z')
    expect(faceBegins(log)).toBe(0)
    expect(planeBegins(log)).toHaveLength(1)
    // An idle Escape then clears the lock.
    tool.onKey(key('Escape'))
    expect(tool.statusHint()).not.toContain('Locked')
  })
})

describe('Arc — Esc from the bulge stage keeps the face the chord started on', () => {
  it('lock, place B, Esc, release: the arc lands on the original face', () => {
    const { scene, log } = makeScene()
    const tool = DRIVERS[3].make(scene)
    tool.onPointerDown(makeSnap([0, 0, 0]), RAY)
    tool.onKey(key('ArrowUp'))
    tool.onPointerDown(makeSnap([0.6, -0.4, 0]), RAY) // B on the ground
    tool.onKey(key('Escape')) // back to the chord stage, A kept
    tool.onKey(key('ArrowUp')) // release: back on the wall
    DRIVERS[3].finish(tool, 'y')
    expect(planeBegins(log)).toHaveLength(0)
    expect(faceBegins(log)).toBe(1)
  })
})
