/**
 * SceneRenderer annotation-rendering tests — the playtest-round-2 fixes
 * (docs/design/dimensions-playtest2.md): breaking a linear dimension's line
 * around its label (§2), and radial dimensions drawing the geometry they
 * actually measure (§4). `.dom.test.tsx` (not `.test.ts`) because
 * `refreshAnnotations`/`updateAnnotationBillboards` construct `TextBillboard`
 * instances, which need a `document` global — this repo's plain `.test.ts`
 * files run under vitest's `node` environment with no DOM at all (see
 * `vitest.config.ts`'s `environmentMatchGlobs`; mirrors
 * `TextBillboard.dom.test.tsx`'s own split from `TextBillboard.test.ts`).
 *
 * jsdom has no canvas 2D backend (no `canvas`/jest-canvas-mock polyfill in
 * this repo), so `TextBillboard`'s rasterization never actually runs here —
 * `aspect`/`contentFrac` stay at their pre-raster defaults of `1`, which
 * makes `worldSize()` a clean, deterministic function of camera distance
 * alone (independent of the label's actual text) — exactly what these tests
 * exploit to hit each of the three §2 regimes on purpose.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import type { Scene as WasmScene } from '../wasm/loader'
import { SceneRenderer } from './SceneRenderer'

/** A minimal mock WasmScene exposing exactly the `annotation_*` surface
 * `refreshAnnotations`/`_buildAnnotationBase` read. */
function makeAnnotationScene(defs: {
  linear?: Record<
    string,
    { a: number[]; b: number[]; offset: number[]; plane: number[]; detached?: boolean; override?: string }
  >
  radial?: Record<
    string,
    { anchor: number[]; kind: 'radius' | 'diameter'; curve: number[]; leaderDir: number[]; detached?: boolean }
  >
}): WasmScene {
  const linear = defs.linear ?? {}
  const radial = defs.radial ?? {}
  const ids = [...Object.keys(linear), ...Object.keys(radial)].map(BigInt)
  return {
    annotation_ids: () => BigUint64Array.from(ids),
    annotation_kind: (id: bigint) => {
      if (id.toString() in linear) return 'linear'
      if (id.toString() in radial) return 'radial'
      return undefined
    },
    annotation_detached: (id: bigint) => linear[id.toString()]?.detached ?? radial[id.toString()]?.detached ?? false,
    annotation_anchor_point: (id: bigint, which: number) => {
      const l = linear[id.toString()]
      if (l !== undefined) return Float64Array.from(which === 0 ? l.a : l.b)
      const r = radial[id.toString()]
      if (r !== undefined && which === 0) return Float64Array.from(r.anchor)
      return undefined
    },
    annotation_offset: (id: bigint) => {
      const l = linear[id.toString()]
      return l !== undefined ? Float64Array.from(l.offset) : undefined
    },
    annotation_plane: (id: bigint) => {
      const l = linear[id.toString()]
      return l !== undefined ? Float64Array.from(l.plane) : undefined
    },
    annotation_text_override: (id: bigint) => linear[id.toString()]?.override ?? undefined,
    annotation_leader_dir: (id: bigint) => {
      const r = radial[id.toString()]
      return r !== undefined ? Float64Array.from(r.leaderDir) : undefined
    },
    annotation_curve: (id: bigint) => {
      const r = radial[id.toString()]
      return r !== undefined ? Float64Array.from(r.curve) : undefined
    },
    annotation_radial_kind: (id: bigint) => radial[id.toString()]?.kind,
    annotation_text: () => undefined,
  } as unknown as WasmScene
}

/** Every fat-line batch (`annotationLines`/`annotationLinesDetached`/
 * `annotationHighlight`) currently parented under the renderer's (public)
 * `annotationsGroup` — inspecting the group instead of SceneRenderer's
 * private fields, like the other SceneRenderer tests inspect public groups. */
function annotationFatLines(renderer: SceneRenderer): LineSegments2[] {
  const out: LineSegments2[] = []
  renderer.annotationsGroup.traverse((o) => {
    if (o instanceof LineSegments2) out.push(o)
  })
  return out
}

/** Every 2-point segment `[ax,ay,az,bx,by,bz]` across every live fat-line
 * batch, decoded from `LineSegmentsGeometry`'s interleaved `instanceStart`
 * buffer (the same flat array `makeFatSegments`/`setPositions` was given). */
function allSegments(renderer: SceneRenderer): [THREE.Vector3, THREE.Vector3][] {
  const segs: [THREE.Vector3, THREE.Vector3][] = []
  for (const line of annotationFatLines(renderer)) {
    const attr = line.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute | undefined
    if (attr === undefined) continue
    const arr = attr.data.array as Float32Array
    for (let i = 0; i + 5 < arr.length; i += 6) {
      segs.push([new THREE.Vector3(arr[i], arr[i + 1], arr[i + 2]), new THREE.Vector3(arr[i + 3], arr[i + 4], arr[i + 5])])
    }
  }
  return segs
}

/** Whether any segment spans (within `tol`, absorbing the §1 view-direction
 * bias — which scales with camera distance, e.g. ~0.7 world units at this
 * file's farthest (regime 3) camera, so the default is generous rather than
 * a tight geometric tolerance) from `p` to `q` OR `q` to `p` (fat-line
 * segment endpoints have no fixed order relative to a logical a->b line). */
function hasSegmentSpanning(renderer: SceneRenderer, p: THREE.Vector3, q: THREE.Vector3, tol = 1.0): boolean {
  return allSegments(renderer).some(
    ([a, b]) => (a.distanceTo(p) < tol && b.distanceTo(q) < tol) || (a.distanceTo(q) < tol && b.distanceTo(p) < tol),
  )
}

/** A camera looking straight down -Z at `(midX, midY, 0)` from `dist` units
 * up — `fov`/`viewportHeight` match the values baked into this file's
 * regime-selecting distances (see the module doc comment on why `dist`
 * alone determines the (deterministic, jsdom-no-canvas) label size). */
function topDownCamera(midX: number, midY: number, dist: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 10000)
  cam.position.set(midX, midY, dist)
  cam.lookAt(midX, midY, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

const FOV_DEG = 50
const VIEWPORT = 800

describe('SceneRenderer — dimension-line/label gap (dimensions-playtest2.md §2)', () => {
  // RED-CHECK (all three regimes): the unfixed `_buildAnnotationLines`
  // always emits the SINGLE, unbroken `a1 -> b1` segment — `hasSegmentSpanning`
  // for the full a1/b1 span would be TRUE in every regime, including regime
  // 1 (label fits with room), where the fixed expectation is that it is
  // FALSE (broken around the label). The unfixed code also has no
  // `annotationTextWorldPosition` deviation for regime 3 — the label always
  // sits at the exact midpoint, never pushed outside.

  // a1=(0,5,0), b1=(10,5,0): a 10-unit dimension line, offset 5 units off
  // the (0,0,0)-(10,0,0) baseline, drawn in the z=0 plane.
  const scene = makeAnnotationScene({
    linear: { '1': { a: [0, 0, 0], b: [10, 0, 0], offset: [0, 5, 0], plane: [0, 0, 0, 0, 0, 1] } },
  })
  const A1 = new THREE.Vector3(0, 5, 0)
  const B1 = new THREE.Vector3(10, 5, 0)
  const MID = new THREE.Vector3(5, 5, 0)

  it('regime 1: label fits with room to spare -> the line is broken (no segment spans the whole a1-b1 run)', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    // dist=50 -> worldHeight ~0.82 world units -> gap ~1.5 units, well under
    // the 10-unit line (see this file's module doc comment for the formula).
    const camera = topDownCamera(5, 5, 50)
    renderer.updateAnnotationBillboards(camera, VIEWPORT, VIEWPORT, 'dark')

    expect(hasSegmentSpanning(renderer, A1, B1)).toBe(false)
    // The label stays centered — this is the "fits comfortably" case, not
    // the "pushed outside" one.
    const labelPos = renderer.annotationTextWorldPosition(1n)
    expect(labelPos).not.toBeNull()
    expect(labelPos![0]).toBeCloseTo(MID.x, 1)
  })

  it('regime 2: label nearly fills the line -> still broken, but the gap consumes most of it', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    // dist=300 -> worldHeight ~4.9 -> gap ~8.8 units of the 10-unit line —
    // comfortably inside "broken" but with only a sliver of line on each side.
    const camera = topDownCamera(5, 5, 300)
    renderer.updateAnnotationBillboards(camera, VIEWPORT, VIEWPORT, 'dark')

    expect(hasSegmentSpanning(renderer, A1, B1)).toBe(false)
    // A short stub must still remain on EACH side of the gap (not degenerate
    // to nothing) — some segment starts at (or very near) a1, and some
    // segment ends at (or very near) b1.
    const segs = allSegments(renderer)
    const nearA1 = segs.some(([a, b]) => a.distanceTo(A1) < 1.0 || b.distanceTo(A1) < 1.0)
    const nearB1 = segs.some(([a, b]) => a.distanceTo(B1) < 1.0 || b.distanceTo(B1) < 1.0)
    expect(nearA1).toBe(true)
    expect(nearB1).toBe(true)
    const labelPos = renderer.annotationTextWorldPosition(1n)
    expect(labelPos![0]).toBeCloseTo(MID.x, 1)
  })

  it('regime 3: label wider than the line -> the line is drawn WHOLE and the label moves outside', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    // dist=800 -> worldHeight ~13.1 -> gap ~23.5 units, wider than the
    // 10-unit line itself.
    const camera = topDownCamera(5, 5, 800)
    renderer.updateAnnotationBillboards(camera, VIEWPORT, VIEWPORT, 'dark')

    expect(hasSegmentSpanning(renderer, A1, B1)).toBe(true)
    // The label is no longer at the midpoint — it moved past one end.
    const labelPos = renderer.annotationTextWorldPosition(1n)
    expect(labelPos).not.toBeNull()
    expect(Math.abs(labelPos![0] - MID.x)).toBeGreaterThan(3)
    // And it landed roughly on the line's own axis extended (y ~ 5), not
    // off in some unrelated direction.
    expect(labelPos![1]).toBeCloseTo(5, 0)
  })
})

describe('SceneRenderer — radial dimension geometry shows the measurement (dimensions-playtest2.md §4)', () => {
  // RED-CHECK: the unfixed `_buildAnnotationLines`'s 'radial' branch draws
  // ONLY `anchor -> anchor+leaderDir` — `hasSegmentSpanning(center, anchor)`
  // and the diameter chord-through-centre check both fail against it (the
  // centre point never appears in the geometry at all).

  it('Radius: a segment runs from the true centre to the rim anchor', () => {
    const scene = makeAnnotationScene({
      radial: {
        '1': {
          anchor: [4, 2, 0], // radius 3 along +X from center (1,2,0)
          kind: 'radius',
          curve: [1, 2, 0, 3, 1, 2, 0, 0, 0, 1],
          leaderDir: [1, 0, 0],
        },
      },
    })
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    const camera = topDownCamera(1, 2, 50)
    renderer.updateAnnotationBillboards(camera, VIEWPORT, VIEWPORT, 'dark')

    const center = new THREE.Vector3(1, 2, 0)
    const anchor = new THREE.Vector3(4, 2, 0)
    expect(hasSegmentSpanning(renderer, center, anchor)).toBe(true)
    expect(renderer.annotationLabelText(1n)).toContain('R')
  })

  it('Diameter: the drawn chord spans rim to rim, straight through the centre', () => {
    const scene = makeAnnotationScene({
      radial: {
        '1': {
          anchor: [5, 0, 0], // radius 5 along +X from center (0,0,0)
          kind: 'diameter',
          curve: [0, 0, 0, 5, 0, 0, 0, 0, 0, 1],
          leaderDir: [1, 0, 0],
        },
      },
    })
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    const camera = topDownCamera(0, 0, 50)
    renderer.updateAnnotationBillboards(camera, VIEWPORT, VIEWPORT, 'dark')

    const rim = new THREE.Vector3(5, 0, 0)
    const antipode = new THREE.Vector3(-5, 0, 0)
    expect(hasSegmentSpanning(renderer, rim, antipode)).toBe(true)
    expect(renderer.annotationLabelText(1n)).toContain('Ø')
  })
})

describe('SceneRenderer — dimension arrowheads are sized on screen (#36)', () => {
  /** World size of one pixel at distance `dist` for the test camera. */
  const wppAt = (dist: number) => (2 * dist * Math.tan((FOV_DEG * Math.PI) / 360)) / VIEWPORT
  /** Head length (along the dimension axis, x here) of every wing at a tip. */
  function headLengths(renderer: SceneRenderer, tip: THREE.Vector3): number[] {
    return allSegments(renderer)
      .filter(([a, b]) => a.distanceTo(tip) < 1e-4 || b.distanceTo(tip) < 1e-4)
      // Wings are the slanted ones; the dimension, extension and leader
      // lines through the same tip are axis-aligned here.
      .filter(([a, b]) => Math.abs(a.x - b.x) > 1e-9 && Math.abs(a.y - b.y) > 1e-9)
      .map(([a, b]) => Math.abs(a.x - b.x))
  }
  const dimOf = (len: number) =>
    makeAnnotationScene({
      linear: { '1': { a: [0, 0, 0], b: [len, 0, 0], offset: [0, len, 0], plane: [0, 0, 0, 0, 0, 1] } },
    })
  const radialOf = (kind: 'radius' | 'diameter') =>
    makeAnnotationScene({
      radial: {
        '1': { anchor: [0.025, 0, 0], kind, curve: [0, 0, 0, 0.025, 0, 0, 0, 0, 0, 1], leaderDir: [0.01, 0, 0] },
      },
    })
  const orthoCamera = (halfHeight: number, z: number, zoom = 1): THREE.OrthographicCamera => {
    const cam = new THREE.OrthographicCamera(-halfHeight, halfHeight, halfHeight, -halfHeight, 0.1, 10000)
    cam.zoom = zoom
    cam.position.set(0, 0, z)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    return cam
  }

  it('a 2 cm dimension: the two heads are capped at 30 percent of the line each', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(0.02))
    renderer.refreshAnnotations()
    // dist 1: the 12.6 px head (~0.0147 m) is longer than the 0.006 cap.
    renderer.updateAnnotationBillboards(topDownCamera(0.01, 0.02, 1), VIEWPORT, VIEWPORT, 'dark')
    expect(12.6 * wppAt(1)).toBeGreaterThan(0.006)
    for (const tip of [new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(0.02, 0.02, 0)]) {
      const heads = headLengths(renderer, tip)
      expect(heads).toHaveLength(2)
      for (const h of heads) expect(h).toBeCloseTo(0.3 * 0.02, 6)
    }
  })

  it('below the cap the head is the pixel size (the cap does not bind near)', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(0.02))
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(topDownCamera(0.01, 0.02, 0.2), VIEWPORT, VIEWPORT, 'dark')
    for (const h of headLengths(renderer, new THREE.Vector3(0, 0.02, 0))) expect(h).toBeCloseTo(12.6 * wppAt(Math.hypot(0.01, 0.2)), 6)
  })

  it('head length is constant on screen: it grows with camera distance for a long dimension', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(100))
    renderer.refreshAnnotations()
    const tip = new THREE.Vector3(0, 100, 0)
    renderer.updateAnnotationBillboards(topDownCamera(0, 100, 20), VIEWPORT, VIEWPORT, 'dark')
    const near = Math.max(...headLengths(renderer, tip))
    renderer.updateAnnotationBillboards(topDownCamera(0, 100, 40), VIEWPORT, VIEWPORT, 'dark')
    const far = Math.max(...headLengths(renderer, tip))
    expect(far / near).toBeGreaterThan(1.8)
    expect(far / near).toBeLessThan(2.2)
    expect(far).toBeCloseTo(12.6 * wppAt(40), 2)
  })

  it('a radius dimension caps its one head at 60 percent of the measured run', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), radialOf('radius'))
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(topDownCamera(0, 0, 2), VIEWPORT, VIEWPORT, 'dark')
    expect(12.6 * wppAt(2)).toBeGreaterThan(0.015)
    const heads = headLengths(renderer, new THREE.Vector3(0.025, 0, 0))
    expect(heads).toHaveLength(2)
    for (const h of heads) expect(h).toBeCloseTo(0.6 * 0.025, 6)
  })

  it('a diameter dimension puts a head at each rim end, each capped at 30 percent of the run', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), radialOf('diameter'))
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(topDownCamera(0, 0, 2), VIEWPORT, VIEWPORT, 'dark')
    // Measured run is the whole 0.05 diameter; two heads share 60 percent.
    for (const tip of [new THREE.Vector3(0.025, 0, 0), new THREE.Vector3(-0.025, 0, 0)]) {
      const heads = headLengths(renderer, tip)
      expect(heads).toHaveLength(2)
      for (const h of heads) expect(h).toBeCloseTo(0.3 * 0.05, 6)
    }
  })

  it('an orthographic camera sizes the head by the frustum, not by distance', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(1))
    renderer.refreshAnnotations()
    // Frustum 2 units tall over 800 px: 0.0025 per pixel at any depth.
    const tip = new THREE.Vector3(0, 1, 0)
    for (const z of [5, 500]) {
      renderer.updateAnnotationBillboards(orthoCamera(1, z), VIEWPORT, VIEWPORT, 'dark')
      for (const h of headLengths(renderer, tip)) expect(h).toBeCloseTo(12.6 * 0.0025, 6)
    }
    // Zooming in halves the pixel size, so the head halves with it.
    renderer.updateAnnotationBillboards(orthoCamera(1, 5, 2), VIEWPORT, VIEWPORT, 'dark')
    for (const h of headLengths(renderer, tip)) expect(h).toBeCloseTo(12.6 * 0.00125, 6)
  })

  it('an orthographic camera still honours the cap on a short dimension', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(0.02))
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(orthoCamera(1, 5), VIEWPORT, VIEWPORT, 'dark')
    for (const h of headLengths(renderer, new THREE.Vector3(0, 0.02, 0))) expect(h).toBeCloseTo(0.006, 6)
  })

  it('the vector print path reports arrows for the page to size', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), dimOf(1))
    renderer.refreshAnnotations()
    const drawing = renderer.collectAnnotationDrawing()
    expect(drawing.arrows).toHaveLength(2)
    expect(drawing.arrows[0].maxLen).toBeCloseTo(0.3, 9)
  })

  it('the vector print path tells the page to push a radial label, and only that', () => {
    const radial = new SceneRenderer(new THREE.Scene(), radialOf('radius'))
    radial.refreshAnnotations()
    expect(radial.collectAnnotationDrawing().labels[0].pushDir).toEqual([1, 0, 0])
    const linear = new SceneRenderer(new THREE.Scene(), dimOf(1))
    linear.refreshAnnotations()
    expect(linear.collectAnnotationDrawing().labels[0].pushDir).toBeUndefined()
  })

  it('a radial label sits past the leader end, not centered on it', () => {
    const scene = makeAnnotationScene({
      radial: {
        '1': { anchor: [5, 0, 0], kind: 'radius', curve: [0, 0, 0, 5, 0, 0, 0, 0, 0, 1], leaderDir: [2, 0, 0] },
      },
    })
    const renderer = new SceneRenderer(new THREE.Scene(), scene)
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(topDownCamera(5, 0, 50), VIEWPORT, VIEWPORT, 'dark')
    // Leader ends at x = 7; the quad's near edge must clear it.
    expect(renderer.annotationTextWorldPosition(1n)![0]).toBeGreaterThan(7.5)
  })

  it('the centre cross of a small circle is capped at 40 percent of the radius per arm', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), radialOf('radius'))
    renderer.refreshAnnotations()
    // dist 3: 6 px (~0.021 m) is longer than the 0.01 cap.
    renderer.updateAnnotationBillboards(topDownCamera(0, 0, 3), VIEWPORT, VIEWPORT, 'dark')
    expect(6 * wppAt(3)).toBeGreaterThan(0.01)
    const vertical = allSegments(renderer).filter(([a, b]) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) > 1e-9)
    expect(vertical).toHaveLength(1)
    expect(vertical[0][0].distanceTo(vertical[0][1])).toBeCloseTo(2 * 0.4 * 0.025, 6)
  })

  it('the centre cross is 6 px per arm when the circle is large enough', () => {
    const renderer = new SceneRenderer(new THREE.Scene(), radialOf('radius'))
    renderer.refreshAnnotations()
    renderer.updateAnnotationBillboards(topDownCamera(0, 0, 0.2), VIEWPORT, VIEWPORT, 'dark')
    const vertical = allSegments(renderer).filter(([a, b]) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) > 1e-9)
    expect(vertical).toHaveLength(1)
    expect(vertical[0][0].distanceTo(vertical[0][1])).toBeCloseTo(2 * 6 * wppAt(0.2), 6)
  })

  describe('extension-line overshoot', () => {
    // a=(0,0,0) b=(10,0,0), offset 1 up: the extension line at x=0 runs from
    // y=0 to the dimension line at y=1; the overshoot continues past y=1.
    const scene = makeAnnotationScene({
      linear: { '1': { a: [0, 0, 0], b: [10, 0, 0], offset: [0, 1, 0], plane: [0, 0, 0, 0, 0, 1] } },
    })
    const overshoot = (renderer: SceneRenderer): number[] =>
      allSegments(renderer)
        .filter(([a, b]) => Math.abs(a.x) < 1e-6 && Math.abs(b.x) < 1e-6 && Math.min(a.y, b.y) > 1 - 1e-6)
        .map(([a, b]) => a.distanceTo(b))

    it('is a few pixels when the offset allows', () => {
      const renderer = new SceneRenderer(new THREE.Scene(), scene)
      renderer.refreshAnnotations()
      renderer.updateAnnotationBillboards(topDownCamera(5, 0.5, 5), VIEWPORT, VIEWPORT, 'dark')
      // The overshoot starts at (0, 1, 0), seen from (5, 0.5, 5).
      const wpp = wppAt(Math.hypot(5, 0.5, 5))
      expect(6 * wpp).toBeLessThan(0.12)
      const o = overshoot(renderer)
      expect(o).toHaveLength(1)
      expect(o[0]).toBeCloseTo(6 * wpp, 5)
    })

    it('is capped at 12 percent of the offset when far away', () => {
      const renderer = new SceneRenderer(new THREE.Scene(), scene)
      renderer.refreshAnnotations()
      renderer.updateAnnotationBillboards(topDownCamera(5, 0.5, 30), VIEWPORT, VIEWPORT, 'dark')
      expect(6 * wppAt(30)).toBeGreaterThan(0.12)
      const o = overshoot(renderer)
      expect(o).toHaveLength(1)
      expect(o[0]).toBeCloseTo(0.12, 5)
    })
  })

  describe('an outside label (line shorter than the label plus padding)', () => {
    // 4 mm line seen from 20 cm is ~17 px; the 14 px label plus padding is
    // ~25 px, so the whole line is kept and the label moves past one end.
    it('keeps the whole line and the tail stops at the label near edge', () => {
      const len = 0.004
      const renderer = new SceneRenderer(new THREE.Scene(), dimOf(len))
      renderer.refreshAnnotations()
      renderer.updateAnnotationBillboards(topDownCamera(len / 2, len, 0.2), VIEWPORT, VIEWPORT, 'dark')
      const labelX = renderer.annotationTextWorldPosition(1n)![0]
      const halfW = (14 * wppAt(0.2)) / 2
      // Genuinely outside: the label centre is past one end.
      expect(labelX > len || labelX < 0).toBe(true)
      const horizontal = allSegments(renderer).filter(
        ([a, b]) => Math.abs(a.y - len) < 1e-6 && Math.abs(b.y - len) < 1e-6 && Math.abs(a.x - b.x) > 1e-9,
      )
      const xs = horizontal.flatMap(([a, b]) => [a.x, b.x])
      // The whole 0..len run is still drawn.
      expect(Math.min(...xs)).toBeLessThanOrEqual(1e-6)
      expect(Math.max(...xs)).toBeGreaterThanOrEqual(len - 1e-6)
      if (labelX > len) {
        // The tail ends exactly at the label's near edge, not at its centre.
        expect(Math.max(...xs)).toBeCloseTo(labelX - halfW, 5)
        expect(Math.max(...xs)).toBeLessThan(labelX - halfW / 2)
      } else {
        expect(Math.min(...xs)).toBeCloseTo(labelX + halfW, 5)
        expect(Math.min(...xs)).toBeGreaterThan(labelX + halfW / 2)
      }
    })
  })
})
