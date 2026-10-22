/**
 * Isolation — a view-only "show just these" mode (docs/design/import-health.md,
 * "Isolation"). Pure resolution: given the targets a caller asked to isolate
 * and the live document, work out which objects and instances stay shown,
 * which draw faded as context, and which are hidden (and so unpickable and
 * unsnappable — the viewport merges the hidden sets into the same ones the
 * Outliner's eye uses).
 *
 * Isolation is never a document change: nothing here touches the kernel's
 * undo history, the saved file or `docRev`.
 *
 * Context fade: when an isolated item is a member of a group, the rest of that
 * group's objects and instances stay drawn, faded; when it is a definition
 * member shown through one placing instance, that instance's other members
 * stay drawn, faded. A faded thing is still hidden for picking/snapping.
 */
import { plural } from '@lingui/core/macro'
import { collectLeafIds, nodeKindToNumber, nodeRefFromJs, type NodeRef } from '../panels/treeModel'

/** What can be isolated: a world object, a group, an instance (all `NodeRef`s),
 *  or one definition member shown through one placing instance. */
export type IsolationTarget = NodeRef | { kind: 'member'; object: bigint; instance: bigint }

/** The slice of the wasm `Scene` that resolution reads. */
export interface IsolationScene {
  object_ids(): BigUint64Array
  instance_ids(): BigUint64Array
  group_ids(): BigUint64Array
  group_members(group: bigint): unknown[]
  node_parent(kind: number, id: bigint): bigint | undefined
  instance_expanded_members(instance: bigint): BigUint64Array
}

/** What the renderer draws faded although it is hidden for interaction. */
export interface IsolationFade {
  /** World objects drawn faded. */
  objects: ReadonlySet<bigint>
  /** Instances drawn with only some members at full strength: instance id →
   *  the member object ids that stay full (empty = the whole instance fades). */
  instances: ReadonlyMap<bigint, ReadonlySet<bigint>>
}

export interface IsolationView {
  /** The targets that still exist. */
  targets: IsolationTarget[]
  /** How many things are shown at full strength ("Showing N objects"). */
  count: number
  /** Leaf ids hidden for rendering and interaction (everything not shown,
   *  including the faded context and the faded members of a shown instance). */
  hiddenObjects: bigint[]
  hiddenInstances: bigint[]
  /** Leaves the person named directly: shown even if the Outliner hides them. */
  explicitObjects: Set<bigint>
  explicitInstances: Set<bigint>
  fade: IsolationFade
}

const EMPTY_SET: ReadonlySet<bigint> = new Set()

/** The most context instances drawn faded. Each faded instance is
 *  materialized out of its batch for per-instance opacity, which defeats the
 *  batching that large imported models rely on, so past this many the rest of
 *  the context is hidden outright instead of faded. */
export const MAX_FADED_INSTANCES = 64

/** What existed when isolation started. Anything live that is not in here was
 *  created while isolating (drawn, split off by a repair) and stays shown, so
 *  new work never vanishes. */
export interface IsolationBaseline {
  objects: ReadonlySet<bigint>
  instances: ReadonlySet<bigint>
}

/** Snapshot the ids that exist now, as isolation starts. */
export function isolationBaseline(scene: Pick<IsolationScene, 'object_ids' | 'instance_ids'>): IsolationBaseline {
  return { objects: new Set(Array.from(scene.object_ids())), instances: new Set(Array.from(scene.instance_ids())) }
}

function memberKey(t: { object: bigint; instance: bigint }): string {
  return `${t.instance}:${t.object}`
}

/** Whether `target` still exists in the document. */
export function targetExists(
  target: IsolationTarget,
  live: { objects: ReadonlySet<bigint>; groups: ReadonlySet<bigint>; instances: ReadonlySet<bigint> },
  expandedMembers: (instance: bigint) => ReadonlySet<bigint>,
): boolean {
  if (target.kind === 'member') {
    return live.instances.has(target.instance) && expandedMembers(target.instance).has(target.object)
  }
  if (target.kind === 'object') return live.objects.has(target.id)
  if (target.kind === 'group') return live.groups.has(target.id)
  if (target.kind === 'instance') return live.instances.has(target.id)
  return false
}

/**
 * Resolve `targets` against `scene`. Targets that no longer exist are dropped;
 * null when none are left (isolation should end).
 */
export function resolveIsolation(
  scene: IsolationScene,
  targets: readonly IsolationTarget[],
  baseline?: IsolationBaseline,
  baseHidden?: { objects: ReadonlySet<bigint> | readonly bigint[]; instances: ReadonlySet<bigint> | readonly bigint[] },
): IsolationView | null {
  const userHiddenObjects = new Set<bigint>(baseHidden?.objects ?? [])
  const userHiddenInstances = new Set<bigint>(baseHidden?.instances ?? [])
  const allObjects = Array.from(scene.object_ids())
  const allInstances = Array.from(scene.instance_ids())
  const live = {
    objects: new Set(allObjects),
    groups: new Set(Array.from(scene.group_ids())),
    instances: new Set(allInstances),
  }
  const memberCache = new Map<bigint, ReadonlySet<bigint>>()
  const expanded = (instance: bigint): ReadonlySet<bigint> => {
    let s = memberCache.get(instance)
    if (s === undefined) {
      s = new Set(Array.from(scene.instance_expanded_members(instance)))
      memberCache.set(instance, s)
    }
    return s
  }
  const kept = targets.filter((t) => targetExists(t, live, expanded))
  if (kept.length === 0) return null

  const groupMembers = (groupId: bigint): NodeRef[] => scene.group_members(groupId).map((m) => nodeRefFromJs(m as { kind: string; id: bigint }))

  const shownObjects = new Set<bigint>()
  const shownInstances = new Set<bigint>() // instances shown whole
  const explicitObjects = new Set<bigint>()
  const explicitInstances = new Set<bigint>()
  /** instance → member objects at full strength (the instance is drawn, partly faded). */
  const memberShown = new Map<bigint, Set<bigint>>()
  const counted = new Set<string>()
  const fadedObjects = new Set<bigint>()
  const fadedInstances = new Set<bigint>()
  /** A target's own parent group: its rest is the context. */
  const contextGroups = new Set<bigint>()

  for (const t of kept) {
    if (t.kind === 'member') {
      let s = memberShown.get(t.instance)
      if (s === undefined) memberShown.set(t.instance, (s = new Set()))
      s.add(t.object)
      explicitInstances.add(t.instance)
      explicitObjects.add(t.object)
      counted.add(`m:${memberKey(t)}`)
      const parent = scene.node_parent(nodeKindToNumber('instance'), t.instance)
      if (parent !== undefined) contextGroups.add(parent)
      continue
    }
    const { objectIds, instanceIds } = collectLeafIds(t, groupMembers)
    for (const o of objectIds) {
      shownObjects.add(o)
      counted.add(`o:${o}`)
    }
    for (const i of instanceIds) {
      shownInstances.add(i)
      counted.add(`i:${i}`)
    }
    if (t.kind === 'object') explicitObjects.add(t.id)
    if (t.kind === 'instance') explicitInstances.add(t.id)
    if (t.kind === 'group') {
      // Isolating a group shows all its leaves, whatever the eye says.
      for (const o of objectIds) explicitObjects.add(o)
      for (const i of instanceIds) explicitInstances.add(i)
    }
    const kindNum = nodeKindToNumber(t.kind)
    if (kindNum >= 0) {
      const parent = scene.node_parent(kindNum, t.id)
      if (parent !== undefined) contextGroups.add(parent)
    }
  }

  // Objects and instances that did not exist when isolation started stay shown.
  if (baseline !== undefined) {
    for (const o of allObjects) if (!baseline.objects.has(o)) shownObjects.add(o)
    for (const i of allInstances) if (!baseline.instances.has(i)) shownInstances.add(i)
  }

  // The rest of each containing group: faded, never full.
  for (const g of contextGroups) {
    const { objectIds, instanceIds } = collectLeafIds({ kind: 'group', id: g }, groupMembers)
    // The person's own hidden leaves (eye or tag) are never drawn as context.
    for (const o of objectIds) if (!shownObjects.has(o) && !userHiddenObjects.has(o)) fadedObjects.add(o)
    for (const i of instanceIds) {
      if (shownInstances.has(i) || memberShown.has(i) || userHiddenInstances.has(i)) continue
      if (fadedInstances.size < MAX_FADED_INSTANCES) fadedInstances.add(i)
    }
  }

  // A member's instance shown whole already wins over a partial show.
  for (const i of shownInstances) memberShown.delete(i)

  const hiddenObjects: bigint[] = []
  for (const o of allObjects) if (!shownObjects.has(o)) hiddenObjects.push(o)
  const hiddenInstances: bigint[] = []
  for (const i of allInstances) if (!shownInstances.has(i) && !memberShown.has(i)) hiddenInstances.push(i)

  // The rest of a partly shown instance: its other members are not pickable
  // (hidden by object id) and draw faded. Members another target shows
  // through any instance stay un-hidden.
  const shownMembers = new Set<bigint>()
  for (const s of memberShown.values()) for (const m of s) shownMembers.add(m)
  const hiddenSet = new Set(hiddenObjects)
  const fadeInstances = new Map<bigint, ReadonlySet<bigint>>()
  for (const [instance, shown] of memberShown) {
    fadeInstances.set(instance, shown)
    for (const m of expanded(instance)) {
      if (!shownMembers.has(m) && !hiddenSet.has(m)) {
        hiddenSet.add(m)
        hiddenObjects.push(m)
      }
    }
  }
  for (const i of fadedInstances) fadeInstances.set(i, EMPTY_SET)

  return {
    targets: kept,
    count: counted.size,
    hiddenObjects,
    hiddenInstances,
    explicitObjects,
    explicitInstances,
    fade: { objects: fadedObjects, instances: fadeInstances },
  }
}

/** Whether two resolved views would draw and hide exactly the same things. */
export function sameView(a: IsolationView, b: IsolationView): boolean {
  if (a.count !== b.count || !sameTargets(a.targets, b.targets)) return false
  const sameSet = (x: ReadonlySet<bigint>, y: ReadonlySet<bigint>): boolean => {
    if (x.size !== y.size) return false
    for (const v of x) if (!y.has(v)) return false
    return true
  }
  const sameList = (x: readonly bigint[], y: readonly bigint[]): boolean => x.length === y.length && sameSet(new Set(x), new Set(y))
  if (!sameList(a.hiddenObjects, b.hiddenObjects) || !sameList(a.hiddenInstances, b.hiddenInstances)) return false
  if (!sameSet(a.explicitObjects, b.explicitObjects) || !sameSet(a.explicitInstances, b.explicitInstances)) return false
  if (!sameSet(a.fade.objects, b.fade.objects)) return false
  if (a.fade.instances.size !== b.fade.instances.size) return false
  for (const [id, shown] of a.fade.instances) {
    const other = b.fade.instances.get(id)
    if (other === undefined || !sameSet(shown, other)) return false
  }
  return true
}

/** The hidden sets the viewport applies while isolated: the user's own hidden
 *  leaves plus everything outside the isolated set, minus the leaves the
 *  person named directly (isolating something shows it, whatever the eye says). */
export function effectiveHidden(
  base: { objects: readonly bigint[]; instances: readonly bigint[] },
  view: IsolationView | null,
): { objects: bigint[]; instances: bigint[] } {
  if (view === null) return { objects: [...base.objects], instances: [...base.instances] }
  const objects = new Set<bigint>([...base.objects, ...view.hiddenObjects])
  const instances = new Set<bigint>([...base.instances, ...view.hiddenInstances])
  for (const o of view.explicitObjects) objects.delete(o)
  for (const i of view.explicitInstances) instances.delete(i)
  return { objects: [...objects], instances: [...instances] }
}

/** The pick filter the viewport applies to a hit (kernel or three.js): a
 *  pick of a hidden object, or through a hidden instance, resolves to nothing.
 *  Isolation puts everything outside its set into these sets. */
export function isPickHidden(
  hiddenObjects: ReadonlySet<bigint>,
  hiddenInstances: ReadonlySet<bigint>,
  objectId: bigint,
  instanceId: bigint | undefined,
): boolean {
  if (instanceId !== undefined && hiddenInstances.has(instanceId)) return true
  return hiddenObjects.has(objectId)
}

/** Same targets, same order? */
export function sameTargets(a: readonly IsolationTarget[], b: readonly IsolationTarget[]): boolean {
  if (a.length !== b.length) return false
  const key = (t: IsolationTarget): string => (t.kind === 'member' ? `m:${memberKey(t)}` : `${t.kind}:${t.id}`)
  return a.every((t, i) => key(t) === key(b[i]))
}

/** "Showing 1 object" / "Showing 6 objects". */
export function isolationBarText(count: number): string {
  return plural(count, { one: 'Showing # object', other: 'Showing # objects' })
}
