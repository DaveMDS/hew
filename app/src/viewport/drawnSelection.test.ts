import { describe, it, expect } from 'vitest'
import { draftRef, ctxOfPlane, ctxGround } from '../tools/planeUnits'
import { planeUnitsMock, ringUnit, hexKey } from '../tools/planeUnitsMock'
import { dedupeRefs, invertWithin, objectDrawingIslands } from './drawnSelection'
import { nodeKey, type NodeRef } from '../panels/treeModel'

const TOP = ctxOfPlane([0, 0, 0.5], [0, 0, 1])!
const GROUND = ctxGround()
const FACE_STORE = { kind: 'topology', object: 7 }

/** A box (object 7) with two shapes drawn on its top, a ground shape beside it. */
function scene() {
  const mock = planeUnitsMock({
    [TOP]: {
      units: [
        ringUnit(10, 100, [[0.5, 0.5, 0.5], [1, 0.5, 0.5], [1, 1, 0.5], [0.5, 1, 0.5]], FACE_STORE),
        ringUnit(11, 110, [[1.5, 0.5, 0.5], [2, 0.5, 0.5], [2, 1, 0.5], [1.5, 1, 0.5]], FACE_STORE),
        // Another object's drawing on the same plane is not ours.
        ringUnit(12, 120, [[2.2, 2.2, 0.5], [2.6, 2.2, 0.5], [2.6, 2.6, 0.5]], { kind: 'topology', object: 99 }),
      ],
    },
    [GROUND]: { units: [ringUnit(20, 200, [[5, 5, 0], [6, 5, 0], [6, 6, 0]])] },
  })
  return { ...mock, object_drawing_planes: (o: bigint) => (o === 7n ? [0, 0, 0.5, 0, 0, 1] : []) }
}

const island = (ctx: string, key: number): NodeRef => draftRef('draft-island', ctx, hexKey(key))

describe('objectDrawingIslands', () => {
  it('lists one island per drawn shape on the object\'s faces, only that object\'s', () => {
    const out: NodeRef[] = []
    objectDrawingIslands(scene(), [7n], null, null, new Set(), out)
    expect(out.map(nodeKey)).toEqual([nodeKey(island(TOP, 10)), nodeKey(island(TOP, 11))])
  })

  it('does not list a unit twice across calls sharing the seen set', () => {
    const seen = new Set<string>()
    const out: NodeRef[] = []
    objectDrawingIslands(scene(), [7n], null, null, seen, out)
    objectDrawingIslands(scene(), [7n], null, null, seen, out)
    expect(out).toHaveLength(2)
  })
})

describe('invertWithin', () => {
  const candidates = [island(TOP, 10), island(TOP, 11), island(GROUND, 20), { kind: 'object', id: 7n } as NodeRef]

  it('keeps face shapes and ground shapes at the same island granularity', () => {
    const out = invertWithin(scene(), candidates, [island(TOP, 10), island(GROUND, 20)])
    expect(out.map(nodeKey)).toEqual([nodeKey(island(TOP, 11)), nodeKey({ kind: 'object', id: 7n } as NodeRef)])
  })

  it('counts the island owning a selected face edge as selected', () => {
    const edge = draftRef('draft-edge', TOP, hexKey(100))
    const out = invertWithin(scene(), candidates, [edge])
    expect(out.map(nodeKey)).not.toContain(nodeKey(island(TOP, 10)))
    expect(out.map(nodeKey)).toContain(nodeKey(island(TOP, 11)))
  })
})

describe('dedupeRefs / duplicate islands', () => {
  it('keeps one ref per canonical identity, in first-seen order', () => {
    const a = island(TOP, 10)
    const b = island(TOP, 11)
    expect(dedupeRefs([a, b, island(TOP, 10), a]).map(nodeKey)).toEqual([nodeKey(a), nodeKey(b)])
  })

  it('invertWithin never returns the same island twice (a half-on-face island listed by both enumerations)', () => {
    const dup = [island(TOP, 10), island(TOP, 11), island(TOP, 10)]
    const out = invertWithin(scene(), dup, [])
    expect(out.map(nodeKey)).toEqual([nodeKey(island(TOP, 10)), nodeKey(island(TOP, 11))])
  })
})
