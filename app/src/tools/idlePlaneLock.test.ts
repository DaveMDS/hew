/**
 * Idle plane lock (sketches on any plane, Phase 3 — the sketch-planes design
 * §1 mode 3 / §5.2): while a draw tool (Line/Rectangle/Circle/Arc) is FULLY
 * idle (no anchored plane/face stage), arrow keys lock the future plane's
 * NORMAL to a world axis (Right=0/red X, Left=1/green Y, Up=2/blue Z); the
 * same arrow again, or ArrowDown, clears it. An active lock beats face pick
 * and sketch-hover adoption on the next click; the plane passes through
 * that click's snapped point and each commit is one `draft_begin_plane` on
 * it (no per-plane sketch cache any more) — on the ground plane itself when
 * the lock resolves to it exactly (blue through z=0).
 *
 * One shared parameterized suite drives all four tools through a common
 * `DrawToolUnderTest` surface (every tool exposes the same method shapes —
 * see each tool's own module doc) rather than four near-identical files.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import { RectangleTool } from './RectangleTool'
import { CircleTool } from './CircleTool'
import { ArcTool } from './ArcTool'
import { draftMock } from './draftMock'
import { toolHasArmedGesture, type EditContext, type Snap, type Tool } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(p: readonly [number, number, number]): Snap {
  return { x: p[0], y: p[1], z: p[2], kind: 'plane' }
}

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, repeat: false, preventDefault: () => { /* no-op */ } } as unknown as KeyboardEvent
}

/** A rotated (non-ground) sketch under the cursor — for the
 *  "lock overrides sketch-hover" case. Plane: y=0, normal -Y. */
const TILTED_SKETCH = 55n
const TILTED_PLANE = new Float64Array([0, 0, 0, 0, -1, 0])

type SegmentCall = { a: [number, number, number]; b: [number, number, number] }

function makeWasmScene(opts: { sketchPick?: bigint } = {}) {
  const planes = new Map<bigint, Float64Array>([[TILTED_SKETCH, TILTED_PLANE]])
  const dm = draftMock()

  const scene = {
    // World-identity drawing axes (tool-parity §4) — no test in this suite
    // exercises a moved frame; see drawPlane.test.ts/AxesTool.test.ts for
    // the movable-frame coverage.
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    history_generation: vi.fn(() => 1n),
    pick_face: vi.fn(() => undefined), // never an eligible face in these fixtures
    pick_sketch: vi.fn(() => opts.sketchPick),
    sketch_plane: vi.fn((h: bigint) => planes.get(h)),
    face_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    ...dm.members,
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  // A live array view of the draft log's segments as {a, b} pairs.
  const segmentCalls = new Proxy([] as SegmentCall[], {
    get(_t, k) {
      const live: SegmentCall[] = dm.log.segments.map((sg) => ({
        a: sg.slice(0, 3) as SegmentCall['a'],
        b: sg.slice(3, 6) as SegmentCall['b'],
      }))
      return Reflect.get(live, k)
    },
  })
  return { scene: scene as unknown as WasmScene & typeof scene, segmentCalls, log: dm.log }
}

/** The subset of each draw tool's public surface these tests drive — every
 *  concrete tool (Line/Rectangle/Circle/Arc) implements it identically. */
interface DrawToolUnderTest {
  onPointerDown(snap: Snap | null, ray: Ray): void
  onKey(ev: KeyboardEvent): void
  capturingInput(): boolean
  statusHint(): string
  cancel(): void
  onDocumentReset(): void
  setEditContext(ctx: EditContext): void
  snapConstraint(ray: Ray): { constraintPlane?: { point: [number, number, number]; normal: [number, number, number] } } | null
}

interface Driver {
  name: string
  make(scene: WasmScene): DrawToolUnderTest
  /** Drive ONE complete plane-mode gesture from first-click point `a`
   *  through `bulge` (a second/third point off any degenerate line with
   *  `a`), leaving the tool idle again so a following gesture can be driven
   *  the same way. `a` is always the point the frozen plane passes through. */
  commit(tool: DrawToolUnderTest, a: readonly [number, number, number], bulge: readonly [number, number, number]): void
}

const DRIVERS: Driver[] = [
  {
    name: 'Line',
    make: (scene) =>
      new LineTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as DrawToolUnderTest,
    commit: (tool, a, bulge) => {
      tool.onPointerDown(makeSnap(a), RAY)
      tool.onPointerDown(makeSnap(bulge), RAY)
      // LineTool chains forward after a non-closing commit — end the chain
      // (keeps the committed segment) so the tool returns to fully idle.
      tool.onKey(makeKeyEvent('Escape'))
    },
  },
  {
    name: 'Rectangle',
    make: (scene) =>
      new RectangleTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as DrawToolUnderTest,
    commit: (tool, a, bulge) => {
      tool.onPointerDown(makeSnap(a), RAY)
      tool.onPointerDown(makeSnap(bulge), RAY) // opposite corner — auto-returns to idle
    },
  },
  {
    name: 'Circle',
    make: (scene) =>
      new CircleTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as DrawToolUnderTest,
    commit: (tool, a, bulge) => {
      tool.onPointerDown(makeSnap(a), RAY)
      tool.onPointerDown(makeSnap(bulge), RAY) // rim point — auto-returns to idle
    },
  },
  {
    name: 'Arc',
    make: (scene) =>
      new ArcTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), vi.fn()) as unknown as DrawToolUnderTest,
    commit: (tool, a, bulge) => {
      // Every call site holds ONE coordinate fixed between `a` and `bulge`
      // (the locked axis — both points lie in the same locked plane) and
      // varies the other two. Build the chord's second endpoint by moving
      // along only ONE of those free axes (staying on-plane, unlike
      // deriving it from `bulge`, which would make the chord degenerate);
      // `bulge` itself then has a nonzero, non-collinear offset on the
      // OTHER free axis, giving a genuine (non-flat) bulge.
      const lockedAxis = a[0] === bulge[0] ? 0 : a[1] === bulge[1] ? 1 : 2
      const freeAxis = lockedAxis === 0 ? 1 : 0
      const chordB: [number, number, number] = [a[0], a[1], a[2]]
      chordB[freeAxis] += 3
      tool.onPointerDown(makeSnap(a), RAY)
      tool.onPointerDown(makeSnap(chordB), RAY)
      tool.onPointerDown(makeSnap(bulge), RAY) // bulge — auto-returns to idle
    },
  },
]

/** For locked axis `axis`, two in-plane points through `locked` (the axis's
 *  fixed coordinate) that are non-collinear with a third — used to build
 *  `a`/`bulge` pairs that work for every driver, including Arc's chord math
 *  (which needs a genuine 2D spread in the plane, not a single line). */
function planePoint(axis: 0 | 1 | 2, locked: number, c1: number, c2: number): [number, number, number] {
  const p: [number, number, number] = [0, 0, 0]
  const others = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
  p[axis] = locked
  p[others[0]] = c1
  p[others[1]] = c2
  return p
}

const ARROW_FOR_AXIS = ['ArrowRight', 'ArrowLeft', 'ArrowUp'] as const

describe.each(DRIVERS)('$name — idle plane lock', ({ make, commit }) => {
  // -------------------------------------------------------------- lock state machine

  it('an arrow key locks the plane while idle, named in statusHint', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)
    expect(tool.statusHint()).not.toContain('Locked')

    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(tool.statusHint()).toContain('Locked to the red plane')
  })

  it('pressing the same arrow again clears the lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(tool.statusHint()).toContain('red')
    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('a different arrow switches the lock axis (not toggle-off)', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    tool.onKey(makeKeyEvent('ArrowUp'))
    expect(tool.statusHint()).toContain('Locked to the blue plane')
  })

  it('ArrowDown clears an active lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowLeft'))
    expect(tool.statusHint()).toContain('green')
    tool.onKey(makeKeyEvent('ArrowDown'))
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('Escape while idle-locked clears the lock first; a second Escape does not throw', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(tool.statusHint()).toContain('Locked')
    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.statusHint()).not.toContain('Locked')
    expect(() => tool.onKey(makeKeyEvent('Escape'))).not.toThrow()
  })

  it('Escape aborting an anchored-but-uncommitted gesture preserves the lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    tool.onPointerDown(makeSnap([2, 1, 3]), RAY) // anchor only — nothing committed
    expect(tool.capturingInput()).toBe(true)
    tool.onKey(makeKeyEvent('Escape')) // abort the gesture, keep the aim
    expect(tool.capturingInput()).toBe(false)
    expect(tool.statusHint()).toContain('Locked to the red plane')
    tool.onKey(makeKeyEvent('Escape')) // idle Escape is what clears the lock
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('cancel() clears the lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    tool.cancel()
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('onDocumentReset() clears the lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    tool.onDocumentReset()
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('setEditContext() clears the lock', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    tool.setEditContext({ kind: 'object', id: 7n })
    expect(tool.statusHint()).not.toContain('Locked')
  })

  it('the lock survives a completed gesture', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    commit(tool, planePoint(0, 2, 1, 3), planePoint(0, 2, 4, 3.5))
    expect(tool.statusHint()).toContain('Locked to the red plane')
  })

  // -------------------------------------------------------------- lock beats inference

  it('an active lock overrides sketch-hover adoption — a NEW plane-mode gesture starts, not sketch adoption', () => {
    const { scene } = makeWasmScene({ sketchPick: TILTED_SKETCH })
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight')) // red/X lock
    expect(tool.snapConstraint(RAY)).toBeNull() // idle-locked: unconstrained, per design §5.2
    expect(scene.pick_sketch).not.toHaveBeenCalled()

    commit(tool, planePoint(0, 2, 1, 3), planePoint(0, 2, 4, 3.5))

    expect(scene.pick_sketch).not.toHaveBeenCalled()
    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    expect(scene.draft_begin_plane).toHaveBeenCalledWith(2, 1, 3, 1, 0, 0, expect.any(String))
  })

  // -------------------------------------------------------------- first click resolves the plane

  it('first click through a snapped point begins the draft plane through THAT point', () => {
    const { scene, segmentCalls } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight')) // red/X
    commit(tool, planePoint(0, 2, 1, 3), planePoint(0, 2, 4, 3.5))

    expect(scene.draft_begin_plane).toHaveBeenCalledWith(2, 1, 3, 1, 0, 0, expect.any(String))
    expect(segmentCalls.length).toBeGreaterThan(0)
    for (const call of segmentCalls) {
      expect(call.a[0]).toBeCloseTo(2)
      expect(call.b[0]).toBeCloseTo(2)
    }
  })

  it.each([
    [0, 'red'] as const,
    [1, 'green'] as const,
  ])('lock axis %i (%s) through a nonzero offset begins a draft on that plane (draft_begin_plane)', (axis, _color) => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent(ARROW_FOR_AXIS[axis]))
    commit(tool, planePoint(axis, 5, 1, 1), planePoint(axis, 5, 4, 1.5))

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    const c = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(c[axis + 3]).toBe(1) // the lock axis is the plane normal
    expect(c[axis]).toBe(5) // through the nonzero offset
  })

  // -------------------------------------------------------------- one draft per commit

  it('two gestures through the SAME locked plane are two drafts on that one plane', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    commit(tool, planePoint(0, 2, 1, 3), planePoint(0, 2, 4, 3.5))
    // Lock survives — draw a second shape through a DIFFERENT point on the
    // SAME plane (x = 2). There is no per-plane sketch cache any more (the
    // old "share one minted sketch" assertion): each commit is its own draft,
    // so the same plane is simply begun twice.
    commit(tool, planePoint(0, 2, 10, 10), planePoint(0, 2, 13, 10.5))

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(2)
    for (const c of (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls) {
      expect(c[0]).toBe(2) // x = 2 plane
      expect(c.slice(3, 6)).toEqual([1, 0, 0])
    }
  })

  it('a second gesture on the SAME axis through a DIFFERENT offset begins a draft on a different plane', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowRight'))
    commit(tool, planePoint(0, 2, 1, 3), planePoint(0, 2, 4, 3.5))
    commit(tool, planePoint(0, 5, 1, 3), planePoint(0, 5, 4, 3.5)) // x = 5, not 2

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(2)
    const calls = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toBe(2)
    expect(calls[1][0]).toBe(5)
  })

  // -------------------------------------------------------------- ground-plane special case

  it('blue lock through z=0 begins its draft on the ground plane (normal +Z, z = 0)', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)

    tool.onKey(makeKeyEvent('ArrowUp')) // blue/Z
    commit(tool, planePoint(2, 0, 1, 2), planePoint(2, 0, 4, 2.5))

    expect(scene.draft_begin_plane).toHaveBeenCalledTimes(1)
    const c = (scene.draft_begin_plane as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(c[2]).toBe(0)
    expect(c.slice(3, 6)).toEqual([0, 0, 1])
  })

  // -------------------------------------------------------------- hasArmedGesture (Escape routing)

  it('an idle plane lock arms the tool for toolHasArmedGesture, even though capturingInput() is false', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene) as unknown as Tool

    expect(toolHasArmedGesture(tool)).toBe(false)
    tool.onKey(makeKeyEvent('ArrowRight'))
    expect((tool as unknown as DrawToolUnderTest).capturingInput()).toBe(false) // idle-locked, not anchored
    expect(toolHasArmedGesture(tool)).toBe(true)
  })

  it('one Escape clears an idle plane lock and the tool reports unarmed afterward', () => {
    const { scene } = makeWasmScene()
    const tool = make(scene)
    const asTool = tool as unknown as Tool

    tool.onKey(makeKeyEvent('ArrowRight'))
    expect(toolHasArmedGesture(asTool)).toBe(true)

    tool.onKey(makeKeyEvent('Escape')) // idle-locked: Escape clears the lock, nothing else
    expect(tool.statusHint()).not.toContain('Locked')
    expect(toolHasArmedGesture(asTool)).toBe(false)
  })
})
