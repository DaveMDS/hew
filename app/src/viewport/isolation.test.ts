import { describe, expect, it } from 'vitest'
import { MAX_FADED_INSTANCES, effectiveHidden, sameView, isPickHidden, isolationBarText, isolationBaseline, resolveIsolation, sameTargets, type IsolationScene } from './isolation'

/**
 * Document: world objects 1, 2, 3, 4; group 50 holds objects 2, 3 and instance 20;
 * instances 21 and 22 are top level; instances 22 and 23 place definition members
 * 7 and 8.
 */
function makeScene(gone: { objects?: bigint[]; instances?: bigint[] } = {}): IsolationScene {
  const objects = [1n, 2n, 3n, 4n].filter((o) => !(gone.objects ?? []).includes(o))
  const instances = [20n, 21n, 22n, 23n].filter((i) => !(gone.instances ?? []).includes(i))
  const parents = new Map<string, bigint>([['0:2', 50n], ['0:3', 50n], ['2:20', 50n]])
  return {
    object_ids: () => BigUint64Array.from(objects),
    instance_ids: () => BigUint64Array.from(instances),
    group_ids: () => BigUint64Array.from([50n]),
    group_members: (g) =>
      g === 50n
        ? [
            ...[2n, 3n].filter((o) => objects.includes(o)).map((id) => ({ kind: 'object', id })),
            ...[20n].filter((i) => instances.includes(i)).map((id) => ({ kind: 'instance', id })),
          ]
        : [],
    node_parent: (kind, id) => parents.get(`${kind}:${id}`),
    instance_expanded_members: (i) => (i === 22n || i === 23n ? BigUint64Array.from([7n, 8n]) : new BigUint64Array()),
  }
}

describe('resolveIsolation', () => {
  it('a world object: everything else is hidden, the object is the only one shown', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'object', id: 1n }])!
    expect(view.count).toBe(1)
    expect(view.hiddenObjects.sort()).toEqual([2n, 3n, 4n])
    expect(view.hiddenInstances.sort()).toEqual([20n, 21n, 22n, 23n])
    expect(view.fade.objects.size).toBe(0)
    expect(view.fade.instances.size).toBe(0)
  })

  it('an object inside a group: the rest of that group is faded context, and hidden for picking', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'object', id: 2n }])!
    expect(view.count).toBe(1)
    expect([...view.fade.objects]).toEqual([3n])
    expect([...view.fade.instances.keys()]).toEqual([20n])
    expect(view.hiddenObjects).toContain(3n)
    expect(view.hiddenInstances).toContain(20n)
    expect(view.hiddenObjects).not.toContain(2n)
    // Objects outside the group are hidden and not faded.
    expect(view.hiddenObjects).toContain(1n)
    expect(view.fade.objects.has(1n)).toBe(false)
  })

  it('a definition member through one instance: the instance stays, its other members fade, other placements hide', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'member', object: 7n, instance: 22n }])!
    expect(view.count).toBe(1)
    expect(view.hiddenInstances).not.toContain(22n)
    expect(view.hiddenInstances).toContain(23n)
    expect(view.fade.instances.get(22n)).toEqual(new Set([7n]))
    // The member that is only context is hidden by object id (so it is unpickable).
    expect(view.hiddenObjects).toContain(8n)
    expect(view.hiddenObjects).not.toContain(7n)
    expect(view.fade.instances.has(23n)).toBe(false)
  })

  it('a group target shows all its leaves; an instance target shows the instance whole', () => {
    const g = resolveIsolation(makeScene(), [{ kind: 'group', id: 50n }])!
    expect(g.count).toBe(3)
    expect(g.hiddenObjects.sort()).toEqual([1n, 4n])
    expect(g.hiddenInstances).not.toContain(20n)
    const i = resolveIsolation(makeScene(), [{ kind: 'instance', id: 22n }])!
    expect(i.count).toBe(1)
    expect(i.fade.instances.size).toBe(0)
    expect(i.hiddenInstances).not.toContain(22n)
  })

  it('several targets add up ("Showing 2 objects")', () => {
    const view = resolveIsolation(makeScene(), [
      { kind: 'object', id: 1n },
      { kind: 'object', id: 4n },
    ])!
    expect(view.count).toBe(2)
    expect(isolationBarText(view.count)).toBe('Showing 2 objects')
  })

  it('drops targets that no longer exist, and is null when none are left', () => {
    const targets = [
      { kind: 'object' as const, id: 1n },
      { kind: 'object' as const, id: 4n },
    ]
    const some = resolveIsolation(makeScene({ objects: [4n] }), targets)!
    expect(some.targets).toEqual([{ kind: 'object', id: 1n }])
    expect(some.count).toBe(1)
    expect(resolveIsolation(makeScene({ objects: [1n, 4n] }), targets)).toBeNull()
    expect(resolveIsolation(makeScene({ instances: [22n] }), [{ kind: 'member', object: 7n, instance: 22n }])).toBeNull()
    // A member that left its instance's definition is stale too.
    expect(resolveIsolation(makeScene(), [{ kind: 'member', object: 99n, instance: 22n }])).toBeNull()
  })
})

describe('objects created while isolated', () => {
  it('stay shown (not hidden, not faded); the old ones stay hidden', () => {
    const before = makeScene()
    const baseline = isolationBaseline(before)
    // Object 9 (world), object 10 inside group 50, and instance 24 appear afterwards.
    const base = makeScene()
    const scene: IsolationScene = {
      ...base,
      object_ids: () => BigUint64Array.from([1n, 2n, 3n, 4n, 9n, 10n]),
      instance_ids: () => BigUint64Array.from([20n, 21n, 22n, 23n, 24n]),
      group_members: (g) => (g === 50n ? [...base.group_members(g), { kind: 'object', id: 10n }] : []),
    }
    const view = resolveIsolation(scene, [{ kind: 'object', id: 2n }], baseline)!
    expect(view.hiddenObjects).not.toContain(9n)
    expect(view.hiddenObjects).not.toContain(10n)
    expect(view.hiddenInstances).not.toContain(24n)
    expect(view.fade.objects.has(10n)).toBe(false)
    expect(view.hiddenObjects).toContain(1n)
    expect(view.hiddenObjects).toContain(3n)
    // Without a baseline they would have been hidden.
    expect(resolveIsolation(scene, [{ kind: 'object', id: 2n }])!.hiddenObjects).toContain(9n)
  })
})

describe('effectiveHidden', () => {
  it('is the user hidden set when nothing is isolated', () => {
    expect(effectiveHidden({ objects: [3n], instances: [] }, null)).toEqual({ objects: [3n], instances: [] })
  })

  it('adds what isolation hides, but a directly named object shows even if the eye hides it', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'object', id: 1n }])!
    const eff = effectiveHidden({ objects: [1n, 4n], instances: [] }, view)
    expect(eff.objects.sort()).toEqual([2n, 3n, 4n])
    expect(eff.instances.sort()).toEqual([20n, 21n, 22n, 23n])
  })
})

describe('pick exclusion', () => {
  it('objects and instances outside the isolated set cannot be picked; the isolated one can', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'object', id: 1n }])!
    const eff = effectiveHidden({ objects: [], instances: [] }, view)
    const objects = new Set(eff.objects)
    const instances = new Set(eff.instances)
    expect(isPickHidden(objects, instances, 1n, undefined)).toBe(false)
    expect(isPickHidden(objects, instances, 2n, undefined)).toBe(true) // faded context: still unpickable
    expect(isPickHidden(objects, instances, 4n, undefined)).toBe(true)
    expect(isPickHidden(objects, instances, 7n, 22n)).toBe(true) // through a hidden instance
  })

  it('a faded member of the isolated instance is unpickable, the isolated member is not', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'member', object: 7n, instance: 22n }])!
    const eff = effectiveHidden({ objects: [], instances: [] }, view)
    const objects = new Set(eff.objects)
    const instances = new Set(eff.instances)
    expect(isPickHidden(objects, instances, 7n, 22n)).toBe(false)
    expect(isPickHidden(objects, instances, 8n, 22n)).toBe(true)
    expect(isPickHidden(objects, instances, 7n, 23n)).toBe(true) // the other placement
  })
})

describe('isolation bar text and target comparison', () => {
  it('uses the exact singular and plural wording', () => {
    expect(isolationBarText(1)).toBe('Showing 1 object')
    expect(isolationBarText(6)).toBe('Showing 6 objects')
  })

  it('compares targets by identity', () => {
    expect(sameTargets([{ kind: 'object', id: 1n }], [{ kind: 'object', id: 1n }])).toBe(true)
    expect(sameTargets([{ kind: 'object', id: 1n }], [{ kind: 'object', id: 2n }])).toBe(false)
    expect(
      sameTargets([{ kind: 'member', object: 7n, instance: 22n }], [{ kind: 'member', object: 7n, instance: 23n }]),
    ).toBe(false)
  })
})

describe('resolveIsolation — review fixes', () => {
  it('leaves the person hid are never faded context', () => {
    const view = resolveIsolation(makeScene(), [{ kind: 'object', id: 2n }], undefined, {
      objects: new Set([3n]),
      instances: new Set([20n]),
    })!
    expect(view.fade.objects.has(3n)).toBe(false)
    expect(view.fade.instances.has(20n)).toBe(false)
    expect(view.hiddenObjects).toContain(3n)
    expect(view.hiddenInstances).toContain(20n)
  })

  it('isolating a group the person hid shows all its leaves', () => {
    const base = { objects: [2n, 3n], instances: [20n] }
    const view = resolveIsolation(makeScene(), [{ kind: 'group', id: 50n }], undefined, base)!
    const eff = effectiveHidden(base, view)
    expect(eff.objects).not.toContain(2n)
    expect(eff.objects).not.toContain(3n)
    expect(eff.instances).not.toContain(20n)
    expect(eff.objects).toContain(1n)
  })

  it('caps the faded context instances; the rest are hidden outright', () => {
    const many = MAX_FADED_INSTANCES + 40
    const ids = Array.from({ length: many }, (_, i) => BigInt(1000 + i))
    const scene: IsolationScene = {
      ...makeScene(),
      instance_ids: () => BigUint64Array.from(ids),
      group_members: () => [{ kind: 'object', id: 2n }, ...ids.map((id) => ({ kind: 'instance', id }))],
      node_parent: (kind, id) => (kind === 0 && id === 2n ? 50n : undefined),
    }
    const view = resolveIsolation(scene, [{ kind: 'object', id: 2n }])!
    expect(view.fade.instances.size).toBe(MAX_FADED_INSTANCES)
    expect(view.hiddenInstances.length).toBe(many)
  })

  it('sameView tells an unchanged resolution from a changed one', () => {
    const t = [{ kind: 'object', id: 2n }] as const
    const a = resolveIsolation(makeScene(), t)!
    expect(sameView(a, resolveIsolation(makeScene(), t)!)).toBe(true)
    expect(sameView(a, resolveIsolation(makeScene({ objects: [4n] }), t)!)).toBe(false)
  })
})
