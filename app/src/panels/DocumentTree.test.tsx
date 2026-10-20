/**
 * DocumentTree — drawn-shape rows (planeUnits.ts `outlinerDrawing`): a shape
 * (one drawing unit of a plane) lists under its object, as an indented child
 * row, whenever any of its edges is face topology or an object-owned sketch;
 * a shape drawn entirely over the void lists as a top-level "Sketch N" row.
 * Clicking one selects the draft-island ref through the same `onSelect` every
 * other row uses.
 *
 * A plain JS object stands in for the wasm Scene (the panel imports the type
 * only, erased at runtime — the same convention ComponentsPanel.test.tsx /
 * scenePanels.test.tsx use), so no wasm/loader mock is required.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DocumentTree } from './DocumentTree'
import { makeLabelFor, nodeKey, type NodeRef } from './treeModel'
import { draftRef, outlinerDrawing, type OutlinerDrawing } from '../tools/planeUnits'
import type { Scene as WasmScene } from '../wasm/loader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeScene(overrides: Record<string, any> = {}): WasmScene {
  return {
    top_level_nodes: () => [],
    group_members: () => [],
    object_ids: () => [],
    sketch_ids: () => [],
    sketch_island_ids: () => [],
    sketch_plane: () => undefined,
    node_parent: () => undefined,
    object_name: () => undefined,
    group_name: () => undefined,
    instance_name: () => undefined,
    instance_def: () => undefined,
    component_name: () => undefined,
    object_drawing_planes: () => new Float64Array(0),
    ...overrides,
  } as unknown as WasmScene
}

const baseProps = {
  docRev: 0,
  docGeneration: 0,
  watertightMap: new Map<bigint, boolean>(),
  selectedIds: [],
  activeContext: [],
  sessionStack: [],
  sessionMembers: null,
  onEnterContext: vi.fn(),
  onExitContext: vi.fn(),
  onSetContextDepth: vi.fn(),
  hiddenKeys: new Set<string>(),
  onToggleHidden: vi.fn(),
  onSetHiddenMany: vi.fn(),
  onReparent: vi.fn(),
}

// ---------------------------------------------------------------------------
// A plane-listing double: `drawn` maps a plane's canonical context to the
// units on it; each unit is a closed square whose edges carry the given stores.
// ---------------------------------------------------------------------------

const hex = (n: number): string => n.toString(16).padStart(16, '0')
const ctxAt = (z: number): string => `{"plane":[0,0,${z},0,0,1]}`
type Store = { kind: 'topology'; object: number } | { kind: 'owned'; object: number; sketch: number } | { kind: 'free'; sketch: number }
/** `rect` (default): a 4-edge unit; `circle`/`polygon`: n edges around a centre,
 *  all in ONE curve run; `line`: one segment. The stores cycle over the edges. */
interface Shape { key: number; stores: Store[]; kind?: 'rect' | 'circle' | 'polygon' | 'line'; ox?: number }

function shapeJson(shapes: Shape[], z: number): string {
  return JSON.stringify({
    units: shapes.map((sh) => {
      const kind = sh.kind ?? 'rect'
      const ox = sh.ox ?? 0
      const n = kind === 'line' ? 1 : kind === 'rect' ? 4 : kind === 'polygon' ? 6 : 8
      const pts: number[][] = []
      if (kind === 'rect') pts.push([ox, 0, z], [ox + 1, 0, z], [ox + 1, 1, z], [ox, 1, z])
      else if (kind === 'line') pts.push([ox, 0, z], [ox + 1, 0, z])
      else for (let i = 0; i < n; i++) pts.push([ox + Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n), z])
      const curve = kind === 'circle' || kind === 'polygon' ? { center: [ox, 0, z], radius: 1 } : null
      const edges = Array.from({ length: n }, (_, i) => ({
        key: hex(sh.key * 100 + i),
        a: pts[i],
        b: pts[(i + 1) % pts.length],
        store: sh.stores[i % sh.stores.length],
        curve,
      }))
      return {
        key: hex(sh.key),
        edges,
        curves: curve === null ? [] : [{ key: hex(sh.key * 1000), curve_key: hex(sh.key * 1000), kind, center: curve.center, radius: 1, edges: edges.map((e) => e.key) }],
      }
    }),
    regions: [],
  })
}

/** Scene extras: planes `drawn` (z -> shapes), the face handle that lies on a
 *  plane (`object_drawing_planes`), and the sketches' planes. */
function drawingScene(opts: {
  drawn: Record<number, Shape[]>
  /** Object 1's faces: face handle -> plane z (reported via object_drawing_planes). */
  faces?: Record<number, number>
  /** Sketch handle -> plane z. */
  sketches?: Record<number, number>
  extra?: Record<string, unknown>
}) {
  const faces = opts.faces ?? {}
  const sketches = opts.sketches ?? {}
  return makeScene({
    top_level_nodes: () => [{ kind: 'object', id: 1n }],
    object_ids: () => [1n],
    object_name: (id: bigint) => (id === 1n ? 'Panel' : undefined),
    object_drawing_planes: (o: bigint) =>
      o === 1n
        ? new Float64Array(Object.keys(faces).flatMap((f) => [0, 0, faces[Number(f)] ?? 0, 0, 0, 1]))
        : new Float64Array(0),
    face_normal: () => new Float64Array([0, 0, 1]),
    sketch_ids: () => Object.keys(sketches).map((k) => BigInt(k)),
    sketch_plane: (sid: bigint) => (sketches[Number(sid)] === undefined ? undefined : new Float64Array([0, 0, sketches[Number(sid)], 0, 0, 1])),
    plane_units_json: (ctx: string) => {
      for (const [z, shapes] of Object.entries(opts.drawn)) {
        if (ctx === ctxAt(Number(z))) return shapeJson(shapes, Number(z))
      }
      return JSON.stringify({ units: [], regions: [] })
    },
    ...opts.extra,
  })
}

const topo1: Store = { kind: 'topology', object: 1 }
const FACE_Z = 0.5

describe('DocumentTree — drawn shape child rows', () => {
  it("lists an object's single drawn shape as a child row under it (a circle is labelled \"Circle\")", () => {
    const scene = drawingScene({ drawn: { [FACE_Z]: [{ key: 10, stores: [topo1], kind: 'circle' }] }, faces: { 10: FACE_Z } })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Panel')).toBeInTheDocument()
    expect(screen.getByText('Circle')).toBeInTheDocument()
  })

  it('clicking the shape child row selects the draft-island ref via onSelect', () => {
    const scene = drawingScene({ drawn: { [FACE_Z]: [{ key: 10, stores: [topo1], kind: 'circle' }] }, faces: { 10: FACE_Z } })
    const onSelect = vi.fn()
    render(<DocumentTree {...baseProps} scene={scene} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Circle'))
    expect(onSelect).toHaveBeenCalledWith(
      { kind: 'draft-island', id: 10n, ctx: ctxAt(FACE_Z), key: hex(10) },
      false,
    )
  })

  it('an object with no drawing shows no shape child row', () => {
    const scene = drawingScene({ drawn: {}, faces: {} })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Panel')).toBeInTheDocument()
    expect(screen.queryByText('Circle')).not.toBeInTheDocument()
  })

  it('numbers two shapes on one object ("Circle 1" / "Circle 2")', () => {
    const scene = drawingScene({
      drawn: { [FACE_Z]: [{ key: 10, stores: [topo1], kind: 'circle' }, { key: 11, stores: [topo1], kind: 'circle', ox: 3 }] },
      faces: { 10: FACE_Z },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Circle 1')).toBeInTheDocument()
    expect(screen.getByText('Circle 2')).toBeInTheDocument()
  })
})

describe('DocumentTree — shape names come from the unit\'s edges', () => {
  it('names a rectangle-shaped unit, a circle, a polygon, and an owned line', () => {
    const owned1: Store = { kind: 'owned', object: 1, sketch: 7 }
    const scene = drawingScene({
      drawn: {
        [FACE_Z]: [
          { key: 10, stores: [topo1], kind: 'rect' },
          { key: 11, stores: [topo1], kind: 'circle', ox: 3 },
          { key: 12, stores: [topo1], kind: 'polygon', ox: 6 },
        ],
        2: [{ key: 20, stores: [owned1], kind: 'line' }],
      },
      faces: { 10: FACE_Z },
      sketches: { 7: 2 },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Rectangle')).toBeInTheDocument()
    expect(screen.getByText('Circle')).toBeInTheDocument()
    expect(screen.getByText('Polygon')).toBeInTheDocument()
    expect(screen.getByText('Line')).toBeInTheDocument()
    expect(screen.queryByText('Shape')).not.toBeInTheDocument()
  })

  it('numbers repeated names 1-based ("Circle 1" / "Circle 2") but leaves a lone name bare', () => {
    const scene = drawingScene({
      drawn: {
        [FACE_Z]: [
          { key: 10, stores: [topo1], kind: 'circle' },
          { key: 11, stores: [topo1], kind: 'circle', ox: 3 },
          { key: 12, stores: [topo1], kind: 'rect', ox: 6 },
        ],
      },
      faces: { 10: FACE_Z },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Circle 1')).toBeInTheDocument()
    expect(screen.getByText('Circle 2')).toBeInTheDocument()
    expect(screen.getByText('Rectangle')).toBeInTheDocument()
  })
})

describe('DocumentTree — outliner placement by store', () => {
  const owned1: Store = { kind: 'owned', object: 1, sketch: 7 }
  const free5: Store = { kind: 'free', sketch: 5 }

  it('an object-OWNED sketch\'s shape lists under its object (found from the sketch\'s plane, no face feature needed)', () => {
    const scene = drawingScene({
      drawn: { 2: [{ key: 20, stores: [owned1, owned1, owned1, owned1] }] },
      sketches: { 7: 2 },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Rectangle')).toBeInTheDocument()
    // Not a free-sketch row.
    expect(screen.queryByText('Sketch 1')).not.toBeInTheDocument()
  })

  it('a shape entirely in a FREE sketch lists as a top-level Sketch row, not under an object', () => {
    const scene = drawingScene({
      drawn: { 0: [{ key: 30, stores: [free5, free5, free5, free5] }] },
      sketches: { 5: 0 },
    })
    const onSelect = vi.fn()
    render(<DocumentTree {...baseProps} scene={scene} onSelect={onSelect} />)
    expect(screen.getByText('Sketch 1')).toBeInTheDocument()
    expect(screen.queryByText('Rectangle')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Sketch 1'))
    expect(onSelect).toHaveBeenCalledWith(
      { kind: 'draft-island', id: 30n, ctx: ctxAt(0), key: hex(30) },
      false,
    )
  })

  it('a MIXED shape (some topology edges, some free) lists under its object only', () => {
    const scene = drawingScene({
      drawn: { 0: [{ key: 40, stores: [topo1, topo1, free5, free5] }] },
      faces: { 40: 0 },
      sketches: { 5: 0 },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Rectangle')).toBeInTheDocument()
    expect(screen.queryByText('Sketch 1')).not.toBeInTheDocument()
  })

  it('two free shapes on the ground get two numbered Sketch rows', () => {
    const scene = drawingScene({
      drawn: { 0: [{ key: 30, stores: [free5, free5, free5, free5] }, { key: 31, stores: [free5, free5, free5, free5] }] },
      sketches: { 5: 0 },
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Sketch 1')).toBeInTheDocument()
    expect(screen.getByText('Sketch 2')).toBeInTheDocument()
  })

  it('a selected draft-edge or draft-curve lights its shape\'s row', () => {
    const scene = drawingScene({ drawn: { [FACE_Z]: [{ key: 10, stores: [topo1, topo1, topo1, topo1] }] }, faces: { 10: FACE_Z } })
    render(
      <DocumentTree
        {...baseProps}
        scene={scene}
        onSelect={vi.fn()}
        selectedIds={[{ kind: 'draft-edge', id: 1001n, ctx: ctxAt(FACE_Z), key: hex(1001) }]}
      />,
    )
    // Lit as a selected (non-primary) row: the selection is the edge, not the shape.
    const row = screen.getByText('Rectangle').closest('div')
    expect(row).toHaveStyle({ background: 'var(--accent-tint-15)' })
  })
})

describe('makeLabelFor — parity with the Outliner rows', () => {
  const owned1: Store = { kind: 'owned', object: 1, sketch: 7 }

  it('numbers a free sketch by its Outliner row, not by its sketch_ids() position', () => {
    const scene = drawingScene({
      drawn: {
        1: [{ key: 30, stores: [{ kind: 'free', sketch: 5 }], kind: 'rect' }],
        2: [{ key: 31, stores: [{ kind: 'free', sketch: 6 }], kind: 'rect' }],
      },
      sketches: { 5: 1, 6: 2 },
      // sketch_ids() lists them in the opposite order to the Outliner's rows.
      extra: { sketch_ids: () => [6n, 5n] },
    })
    const drawing = outlinerDrawing(scene as unknown as Parameters<typeof outlinerDrawing>[0], [1n])
    expect(drawing.free).toHaveLength(2)
    const labelFor = makeLabelFor(scene, new Map(), new Map(), () => drawing)
    drawing.free.forEach((u, i) => {
      const e = u.unit.edges[0].store
      if (e.kind !== 'free') throw new Error('expected a free store')
      expect(labelFor({ kind: 'sketch', id: e.sketch })).toBe(`Sketch ${i + 1}`)
    })
    // Without a drawing it falls back to the sketch_ids() position.
    expect(makeLabelFor(scene, new Map())({ kind: 'sketch', id: 6n })).toBe('Sketch 1')
  })

  it('prints a drawn selection with the Outliner\'s numbered label, for the shape and its lines', () => {
    const scene = drawingScene({
      drawn: { [FACE_Z]: [{ key: 10, stores: [topo1], kind: 'circle' }, { key: 11, stores: [topo1], kind: 'circle', ox: 3 }] },
      faces: { 10: FACE_Z },
    })
    const drawing: OutlinerDrawing = outlinerDrawing(scene as unknown as Parameters<typeof outlinerDrawing>[0], [1n])
    const labelFor = makeLabelFor(scene, new Map(), new Map(), () => drawing)
    const island2 = draftRef('draft-island', ctxAt(FACE_Z), hex(11))
    expect(drawing.labels.get(nodeKey(island2))).toBe('Circle 2')
    expect(labelFor(island2)).toBe('Circle 2')
    // A line of that shape resolves to the shape's row label.
    expect(labelFor(draftRef('draft-edge', ctxAt(FACE_Z), hex(11 * 100)))).toBe('Circle 2')
    // No drawing to consult: the bare kind word.
    expect(makeLabelFor(scene, new Map())(island2)).toBe('Shape')
    void owned1
  })
})

describe('DocumentTree — filter keeps positional labels', () => {
  it('an unnamed child keeps its unfiltered "Group N" while siblings are filtered out', () => {
    const g = (id: number): NodeRef => ({ kind: 'group', id: BigInt(id) })
    const scene = makeScene({
      top_level_nodes: () => [g(1)],
      group_ids: () => [1n, 2n, 3n, 4n],
      group_members: (id: bigint) => (id === 1n ? [g(2), g(3), g(4)] : []),
      group_name: (id: bigint) => (id === 1n ? 'Top' : undefined),
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Filter outliner'), { target: { value: 'Group 3' } })
    expect(screen.getByText('Group 3')).toBeInTheDocument()
    expect(screen.queryByText('Group 1')).not.toBeInTheDocument()
  })
})
