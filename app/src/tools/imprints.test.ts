/**
 * Draft refs of a plane's drawing (`planeUnits.ts`): the selection ref mint
 * and round-trip, resolving a ref against a plane-unit listing, and
 * `isRectangle` (the shape word's corner test).
 */
import { describe, it, expect } from 'vitest'
import { isRectangle } from './imprints'
import { nodeKey, type NodeRef } from '../panels/treeModel'
import { draftRef, draftRefAlive, isDraftRef, resolveDraft } from './planeUnits'

// ---------------------------------------------------------------------------
// draftRef / nodeKey round trip, isDraftRef, draft-ref filtering
// (the selection refs of what imprints draw moved to planeUnits: an imprint
// is a drawing UNIT of its face's plane, named by the kernel's unit key)
// ---------------------------------------------------------------------------

const CTX = '{"plane":[0,0,0,0,0,1]}'
const CTX_B = '{"plane":[0,0,2,0,0,1]}'
const U_SHAPE = '000000000000000a'
const U_CHORD = '0000000000000005'

describe('draftRef', () => {
  it('mints a draft-island ref keyed by the unit key for a drawn shape', () => {
    const ref = draftRef('draft-island', CTX, U_SHAPE)
    expect(ref).toEqual({ kind: 'draft-island', id: 10n, ctx: CTX, key: U_SHAPE })
  })

  it('mints a draft-edge ref keyed by the edge key for a chord (a plain line)', () => {
    const ref = draftRef('draft-edge', CTX, U_CHORD)
    expect(ref).toEqual({ kind: 'draft-edge', id: 5n, ctx: CTX, key: U_CHORD })
  })

  it('round-trips through nodeKey: same plane+unit -> same key, different plane -> different key', () => {
    const a = draftRef('draft-island', CTX, U_SHAPE)
    const b = draftRef('draft-island', CTX, U_SHAPE)
    const c = draftRef('draft-island', CTX_B, U_SHAPE)
    expect(nodeKey(a)).toBe(nodeKey(b))
    expect(nodeKey(a)).not.toBe(nodeKey(c))
  })

  it('isDraftRef is true only for draft kinds with a context and key set', () => {
    expect(isDraftRef(draftRef('draft-island', CTX, U_SHAPE))).toBe(true)
    expect(isDraftRef(draftRef('draft-edge', CTX, U_CHORD))).toBe(true)
    expect(isDraftRef({ kind: 'object', id: 1n })).toBe(false)
    expect(isDraftRef({ kind: 'draft-island', id: 10n })).toBe(false) // no ctx / key
  })

  it('a mixed selection filters down to its draft refs, keeping their plane', () => {
    const sel: NodeRef[] = [
      { kind: 'object', id: 1n },
      draftRef('draft-island', CTX, U_SHAPE),
      { kind: 'sketch', id: 2n },
      draftRef('draft-edge', CTX, U_CHORD),
    ]
    expect(sel.filter(isDraftRef)).toEqual([draftRef('draft-island', CTX, U_SHAPE), draftRef('draft-edge', CTX, U_CHORD)])
  })
})

// ---------------------------------------------------------------------------
// resolveDraft (was findImprint)
// ---------------------------------------------------------------------------

describe('resolveDraft', () => {
  const listing = JSON.stringify({
    units: [
      {
        key: U_SHAPE,
        edges: [
          { key: '0000000000000001', a: [0, 0, 0], b: [1, 0, 0], store: { kind: 'topology', object: 1 }, curve: null },
          { key: '0000000000000002', a: [1, 0, 0], b: [1, 1, 0], store: { kind: 'topology', object: 1 }, curve: null },
        ],
      },
    ],
    regions: [],
  })
  const scene = { plane_units_json: () => listing }

  it('resolves a live draft ref to its current unit and edges', () => {
    const ref = draftRef('draft-island', CTX, U_SHAPE)
    const r = resolveDraft(scene, ref)
    expect(r).not.toBeNull()
    expect(r?.unit?.key).toBe(U_SHAPE)
    expect(r?.edges.map((e) => e.key)).toEqual(['0000000000000001', '0000000000000002'])
    expect(draftRefAlive(scene, ref)).toBe(true)
  })

  it('returns null for a stale ref (key no longer listed)', () => {
    const stale = draftRef('draft-island', CTX, '00000000000003e7')
    expect(resolveDraft(scene, stale)).toBeNull()
    expect(draftRefAlive(scene, stale)).toBe(false)
  })

  it('returns null for a non-draft ref', () => {
    expect(resolveDraft(scene, { kind: 'object', id: 1n })).toBeNull()
  })

  it('returns null when the ref carries no plane context', () => {
    expect(resolveDraft(scene, { kind: 'draft-island', id: 10n })).toBeNull()
  })
})

describe('isRectangle', () => {
  it('accepts a rectangle in any plane and orientation', () => {
    expect(isRectangle([[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]])).toBe(true)
    expect(isRectangle([[0, 0, 0], [0, 0, 2], [0, 1, 2], [0, 1, 0]])).toBe(true)
  })

  it('rejects a parallelogram, a wrong point count, and a degenerate loop', () => {
    expect(isRectangle([[0, 0, 0], [2, 0, 0], [3, 1, 0], [1, 1, 0]])).toBe(false)
    expect(isRectangle([[0, 0, 0], [1, 0, 0], [1, 1, 0]])).toBe(false)
    expect(isRectangle([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBe(false)
  })
})
