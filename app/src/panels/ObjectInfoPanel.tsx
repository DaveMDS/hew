/**
 * ObjectInfoPanel — a closeable pane showing info for the currently selected node.
 *
 * Displays the selected node's:
 *   - Name (editable — commits on Enter/blur → scene.set_node_name; empty
 *     clears the kernel name and the field falls back to showing the same
 *     default label the Outliner shows, via resolveLabel — never "(unnamed)")
 *   - Type (read-only: "Object", "Group", "Component", or "Sketch")
 *   - Geometry (only for Objects; calls scene.object_solid): "Solid", or for
 *     a non-solid object its Model Health state ("Flat panel", "Open: 3
 *     openings", "Open edges branch", ...) with a Show link into the Model
 *     Health panel
 *   - Bounding Box (world axis-aligned bounding-box extents, X × Y × Z, in the
 *     active length format — objectBounds.worldBoundsForSelection computes
 *     it client-side from the render meshes the app already holds; shown for
 *     Object/Group/Component/multi-selection, hidden when the selection has
 *     no mesh, e.g. only Sketches)
 *   - Tags (removable chips + a "+" affordance that reveals the add field)
 *
 * A component instance gets the component treatment instead of the plain
 * Name field:
 *   - Definition Name (editable → scene.set_component_name) — the shared
 *     label; renaming it renames every instance of the component.
 *   - Instance Name (editable → scene.set_node_name) — this placement's own
 *     override; the Outliner then shows "Instance Name (Definition Name)".
 *   - Type reads "Component (N instances)", and the count is a button that
 *     selects every instance of the definition — in the viewport and the
 *     Outliner at once (both render from the same selection state).
 *
 * Empty states are quiet: nothing selected renders nothing at all; a
 * multi-selection shows only the count ("3 selected").
 *
 * StrictMode notes:
 *   - No impure setState updaters (all updaters are either functional or derive
 *     from explicit current state, not captured stale closures).
 *   - The useMemo for node info re-derives from scene + docRev on every doc change.
 *   - useEffect for name input sync derives only from the stable nameFromScene value
 *     computed inside the memo; the effect is idempotent (setting the same string
 *     twice is a no-op for the controlled input). StrictMode double-invocation is
 *     safe: the only mutation is `setLocalName(...)`.
 *   - No async listeners or cleanup races introduced here.
 */

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import type { Scene as WasmScene } from '../wasm/loader'
import { entityLabel, resolveLabel, nodeKindToNumber, nodeKey, nodeRefFromJs, buildTreeIndexMap, isDraftKind, type NodeRef } from './treeModel'
import {
  runsOfCurve,
  draftKindLabel,
  draftRef,
  keyToId,
  planeOfCtx,
  readPlaneUnits,
  resolveDraft,
  type PlaneUnitsScene,
} from '../tools/planeUnits'
import { runDraft } from '../tools/draftCommit'
import {
  canCloseRow,
  classifyRow,
  openReason,
  readHealthReport,
  rowPlacements,
  type HealthRow,
} from '../health/healthReport'
import { ACTION, TOOLTIP, geometryLine } from '../health/healthCopy'
import { batchLabel, failureLine, runBatch, thickenOp } from '../health/healthBatch'
import { ThickenDialog } from './ThickenDialog'
import { worldBoundsForSelection, boundsExtents, type Bounds } from './objectBounds'
import { formatLength } from '../settings/units'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'
import { MIN_SEGMENTS_PER_TURN } from '../tools/arcMath'

/**
 * The fewest facets a circle may have. Mirrors the kernel's
 * `MIN_CIRCLE_SEGMENTS` — the density floor below which a chord ring is
 * deliberately not stamped as a circle at all — via the draw tools' own copy
 * of it in `arcMath`, so this file introduces no third source of truth. The
 * kernel refuses anything below it (`SegmentsBelowFloor`); the panel says so
 * before the round trip.
 */
const MIN_CIRCLE_SEGMENTS = MIN_SEGMENTS_PER_TURN

interface Props {
  scene: WasmScene
  /** Bumped on any document change to trigger re-query. */
  docRev: number
  /** The currently selected nodes (ordered; index 0 = primary). */
  selectedIds: NodeRef[]
  /**
   * Called after a rename — the docRev/dirty/selection bookkeeping every
   * mutation needs, plus the open session's breadcrumb label; nothing drawn
   * changes, so no re-tessellation.
   */
  onNameChanged: () => void
  /**
   * Called after a mutation that changes drawn geometry (Segments rebuilds
   * a circle's chords): the bookkeeping above plus a re-tessellation, or
   * the viewport keeps drawing the old shape until something else repaints.
   */
  onGeometryChanged: () => void
  /**
   * Called after a tag is added or removed: the bookkeeping above plus a
   * re-push of tag visibility, since the node may have just gained or lost
   * a hidden tag.
   */
  onTagsChanged: () => void
  /**
   * Replace the selection with `nodes` — the "(N instances)" click, and the
   * re-point a re-facet needs once it has replaced the selected curve's
   * edges. Routed to the same selection state the viewport and Outliner
   * render from.
   */
  onSelectMany: (nodes: NodeRef[]) => void
  /**
   * Surface a refusal. Segments is the panel's first control the kernel can
   * refuse, and a refusal has to be visible — never a field that silently
   * springs back. Same signature every tool's toast uses.
   */
  onToast?: (message: string, code?: string) => void
  /**
   * The Geometry row's "Show" link for a non-solid object: open Model Health
   * filtered to this object. The link renders only when this is supplied.
   */
  onShowHealth?: (objectId: bigint) => void
  /**
   * The selected dimension or leader text, if any. Annotations are not
   * nodes, so they never appear in `selectedIds`; when nothing else is
   * selected the panel shows a read-only entry for it.
   */
  selectedAnnotation?: bigint | null
  /**
   * The selected construction guide (line or point), if any. Guides are not
   * nodes, so they never appear in `selectedIds`; when nothing else is
   * selected the panel shows a read-only entry for it.
   */
  selectedGuide?: bigint | null
}

/** The guide accessor the panel reads. */
interface GuideScene {
  guide_kind(id: bigint): string | undefined
  guide_tags(id: bigint): string[]
}

/**
 * The annotation accessors the panel reads. `annotation_tags` is optional
 * because older generated typings predate it.
 */
interface AnnotationScene {
  annotation_kind(id: bigint): string | undefined
  annotation_text(id: bigint): string | undefined
  annotation_tags?(id: bigint): string[]
}

/** Human-readable type label for each node kind. */
function kindLabel(kind: NodeRef['kind']): string {
  if (kind === 'object') return 'Object'
  if (kind === 'group') return 'Group'
  if (kind === 'sketch') return 'Sketch'
  if (isDraftKind(kind)) return draftKindLabel(kind)
  return 'Component'
}

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
}

const HEALTH_ACTION_STYLE: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border-strong)',
  borderRadius: '3px',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '11px',
  fontWeight: 'normal',
  padding: '0 6px',
  whiteSpace: 'nowrap',
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-faint, #888)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '2px',
}

const VALUE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary, #ccc)',
  fontFamily: 'var(--font-family-ui)',
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--surface-input, #1e1e1e)',
  border: '1px solid var(--border-strong, #444)',
  borderRadius: '3px',
  color: 'var(--text-primary, #eee)',
  fontFamily: 'var(--font-family-ui)',
  fontSize: '12px',
  padding: '3px 6px',
  outline: 'none',
}

const ADD_TAG_BUTTON_STYLE: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border-strong, #444)',
  color: 'var(--text-muted, #999)',
  cursor: 'pointer',
  borderRadius: '3px',
  width: '16px',
  height: '16px',
  fontSize: '11px',
  lineHeight: 1,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

export function ObjectInfoPanel({ scene, docRev, selectedIds, onNameChanged, onGeometryChanged, onTagsChanged, onSelectMany, onToast, onShowHealth, selectedAnnotation = null, selectedGuide = null }: Props) {
  // --------------------------------------------------------------------------
  // Derive the node info from the scene whenever docRev or selectedIds changes.
  // --------------------------------------------------------------------------
  const nodeInfo = useMemo(() => {
    if (selectedIds.length !== 1) return null
    const node = selectedIds[0]
    const kind = node.kind
    const id = node.id

    // A drawn thing — a shape, curve, line, or region on a plane, whichever
    // store each of its edges lives in (planeUnits.ts) — has no kernel
    // NodeId, name, tags, or solid state: one kind word ("Shape", "Curve",
    // "Line", "Region") with a subtitle for where it is drawn ("on Box 3",
    // "on the ground", "drawing"). A stale ref (erased, re-keyed by an edit)
    // shows just the kind label — the same "minimal entry" the whole-sketch
    // branch below shows for its own stale cases.
    if (isDraftKind(kind)) {
      const r = resolveDraft(scene as unknown as PlaneUnitsScene, node)
      let store: string | null = null
      let points: number | null = null
      let curveKey: string | null = null
      let length: number | null = null
      if (r !== null) {
        const objects: bigint[] = []
        let anyFree = false
        for (const e of r.edges) {
          if (e.store.kind === 'free') anyFree = true
          else if (!objects.includes(e.store.object)) objects.push(e.store.object)
        }
        if (objects.length > 0) {
          const treeIndex = buildTreeIndexMap(
            scene.top_level_nodes().map(nodeRefFromJs),
            (groupId) => scene.group_members(groupId).map(nodeRefFromJs),
          )
          store = 'on ' + objects.map((o) => {
            const idx = treeIndex.get(nodeKey({ kind: 'object', id: o })) ?? 0
            return resolveLabel(scene.object_name(o), undefined, 'object', idx)
          }).join(', ')
        } else if (anyFree) {
          // The ground is the z = 0 plane, whichever way its normal points.
          const pl = node.ctx !== undefined ? planeOfCtx(node.ctx) : null
          const onGround = pl !== null && Math.abs(Math.abs(pl.normal[2]) - 1) < 1e-9 && Math.abs(pl.point[2]) < 1e-9 && pl.instance === null
          store = onGround ? 'on the ground' : 'drawing'
        }
        const ends = new Set<string>()
        const q = (v: number) => (Math.round(v * 1e6) / 1e6).toString()
        for (const e of r.edges) {
          ends.add(`${q(e.a[0])},${q(e.a[1])},${q(e.a[2])}`)
          ends.add(`${q(e.b[0])},${q(e.b[1])},${q(e.b[2])}`)
        }
        points = ends.size
        // Length: one drawn line, or a curve (run or whole) as the sum of
        // its edges. Shapes and regions show none.
        if ((kind === 'draft-edge' || kind === 'draft-curve') && r.edges.length > 0) {
          length = r.edges.reduce((n, e) => n + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]), 0)
        }
        // Segments: only a drawn CIRCLE has facets to re-count — the
        // selection is exactly that circle's own run(s), or a shape made of
        // nothing else.
        const runKeys = new Set<string>()
        let covered = r.edges.length > 0
        for (const e of r.edges) {
          const run = r.pu.runOfEdge.get(e.key)
          if (run === undefined || run.kind !== 'circle' || run.radius === null) covered = false
          else runKeys.add(run.curveKey)
        }
        if (covered && runKeys.size === 1) curveKey = [...runKeys][0]
      }
      let segments: number | null = null
      if (r !== null && curveKey !== null) {
        segments = runsOfCurve(r.pu, curveKey).reduce((n, run) => n + run.edges.length, 0)
      }
      const label = kindLabel(kind)
      return {
        ctx: node.ctx as string | undefined,
        curveKey,
        segments,
        node,
        kind,
        id,
        kindNum: null as number | null,
        nameFromScene: undefined as string | undefined,
        defaultLabel: store === null ? label : `${label} ${store}`,
        store,
        tags: [] as string[][],
        solid: null as boolean | null,
        health: null as HealthRow | null,
        defId: null as bigint | null,
        defName: undefined as string | undefined,
        instanceIds: [] as bigint[],
        points,
        length,
      }
    }

    // A whole sketch is a thin selectable with no kernel NodeId, name, tags,
    // or solid state — show a minimal read-only entry and never call the
    // object/group/instance APIs (`nodeKindToNumber` yields the -1 sentinel,
    // which no node_id-keyed wasm call accepts). Its "name" is the same
    // positional label the tree/canvas show ("Sketch 2"), derived from
    // `all_sketch_ids()` order (every live sketch, shown or not, so a
    // hidden group does not renumber the rest) since sketches can't be
    // renamed yet.
    if (kind !== 'object' && kind !== 'group' && kind !== 'instance') {
      const sketchId = id
      const islands = Array.from(scene.sketch_island_ids(sketchId))
      const listed = scene.all_sketch_ids !== undefined ? scene.all_sketch_ids() : scene.sketch_ids()
      const flat = Array.from(listed).flatMap((sid) =>
        Array.from(scene.sketch_island_ids(sid)).map((island) => ({ sid, island })),
      )
      const idx = flat.findIndex((f) => f.sid === sketchId && f.island === islands[0])
      const sketchLabel = entityLabel('sketch', idx >= 0 ? idx : 0)
      return {
        ctx: undefined as string | undefined,
        curveKey: null as string | null,
        segments: null as number | null,
        node,
        kind,
        id,
        kindNum: null as number | null,
        nameFromScene: undefined as string | undefined,
        defaultLabel: sketchLabel,
        store: null as string | null,
        tags: [] as string[][],
        solid: null as boolean | null,
        health: null as HealthRow | null,
        defId: null as bigint | null,
        defName: undefined as string | undefined,
        instanceIds: [] as bigint[],
        points: null as number | null,
      }
    }

    const kindNum = nodeKindToNumber(kind)

    let nameFromScene: string | undefined
    let defName: string | undefined
    let defId: bigint | null = null
    let instanceIds: bigint[] = []
    if (kind === 'object') {
      nameFromScene = scene.object_name(id)
    } else if (kind === 'group') {
      nameFromScene = scene.group_name(id)
    } else {
      nameFromScene = scene.instance_name(id)
      const def = scene.instance_def(id)
      if (def !== undefined) {
        defId = def
        defName = scene.component_name(def)
        // Every visible sibling placing the same definition, this one included
        // — the "(N instances)" count and the click-to-select set.
        instanceIds = Array.from(scene.instances_of(def))
      }
    }

    // The label the Outliner would show for this node when it carries no
    // kernel name — the panel falls back to exactly this, never "(unnamed)".
    // The positional index is the node's position within its parent container
    // (buildTreeIndexMap), NOT its position in the flat per-kind id list —
    // the Outliner numbers per container, and the two disagree once an
    // unnamed node sits inside a group.
    const treeIndex = buildTreeIndexMap(
      scene.top_level_nodes().map(nodeRefFromJs),
      (groupId) => scene.group_members(groupId).map(nodeRefFromJs),
    )
    const idx = treeIndex.get(nodeKey(node)) ?? 0
    const defaultLabel = resolveLabel(undefined, defName, kind, idx)

    // Tags: array of "Seg1/Seg2" strings from the kernel, split to string[][]
    const rawTags = scene.node_tags(kindNum, id)
    const tags: string[][] = rawTags.map((t) =>
      t.split('/').map((s) => s.trim()).filter((s) => s.length > 0)
    )

    // Solid / verdict only for objects: a non-solid object reads its Model
    // Health verdict (the kernel diagnosis, also for a definition member).
    let solid: boolean | null = null
    let health: HealthRow | null = null
    if (kind === 'object') {
      solid = scene.object_solid(id)
      if (!solid) health = readHealthReport(scene, docRev, [id]).rows[0] ?? null
    }

    return {
      // Curve-only fields: an Object/Group/Instance never has a Segments row.
      ctx: undefined as string | undefined,
      curveKey: null as string | null,
      store: null as string | null,
      segments: null as number | null,
      node,
      kind,
      kindNum,
      id,
      nameFromScene,
      defaultLabel,
      tags,
      solid,
      health,
      defId,
      defName,
      instanceIds,
      points: null as number | null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, docRev, selectedIds])

  // --------------------------------------------------------------------------
  // World bounding-box (Bounding Box row). Computed for ANY selection — single
  // node OR multi-selection — unlike nodeInfo above, which is single-node
  // only; this is why it's a separate memo rather than a field on nodeInfo.
  // Client-side (objectBounds.worldBoundsForSelection): unions the world AABB
  // of every leaf mesh reachable from the selection. Null for an empty
  // selection or one with no mesh (e.g. only Sketches) — the Bounding Box row
  // just doesn't render in that case.
  // --------------------------------------------------------------------------
  const bounds = useMemo(
    () => worldBoundsForSelection(scene, selectedIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, docRev, selectedIds],
  )

  // --------------------------------------------------------------------------
  // Local controlled state for the name input.
  // Sync with the kernel-derived name whenever nodeInfo changes (new selection
  // or doc mutation). This effect is idempotent — calling setLocalName with the
  // same value twice is harmless, so StrictMode double-invoke is safe.
  //
  // The reset is keyed on the selected node's IDENTITY as well as the value:
  // resetting only when the value changes would carry uncommitted typed text
  // across a selection change between two nodes whose kernel names happen to
  // be equal (e.g. both unnamed), and the next blur would silently commit
  // node A's typed name to node B.
  // --------------------------------------------------------------------------
  const syncKey = nodeInfo !== null ? nodeKey(nodeInfo.node) : null
  const [localName, setLocalName] = useState(nodeInfo?.nameFromScene ?? '')
  const prevNameSyncRef = useRef<{ key: string | null; name: string | undefined }>({
    key: null,
    name: undefined,
  })
  useEffect(() => {
    const next = nodeInfo?.nameFromScene
    const prev = prevNameSyncRef.current
    if (syncKey !== prev.key || next !== prev.name) {
      prevNameSyncRef.current = { key: syncKey, name: next }
      setLocalName(next ?? '')
    }
  }, [nodeInfo?.nameFromScene, syncKey])

  // --------------------------------------------------------------------------
  // Name commit: called on Enter or blur.
  // --------------------------------------------------------------------------
  const commitName = useCallback(() => {
    if (nodeInfo === null || nodeInfo.kindNum === null) return
    const trimmed = localName.trim()
    // Pass undefined to clear; pass the string to set. Clearing makes the
    // field fall back to the placeholder default label (Outliner parity).
    scene.set_node_name(nodeInfo.kindNum, nodeInfo.id, trimmed === '' ? undefined : trimmed)
    onNameChanged()
  }, [nodeInfo, localName, scene, onNameChanged])

  // --------------------------------------------------------------------------
  // Definition Name (instances only) — local controlled state + commit,
  // mirroring the name field's identity-keyed reset, but keyed on the
  // DEFINITION's identity, not the instance's: this field edits the shared
  // definition, so cycling between two instances of the same definition
  // keeps an in-progress edit alive (it commits to that one definition
  // either way), while moving to an instance of a different — possibly
  // same-valued — definition resets it, so typed text never leaks onto
  // another component.
  // --------------------------------------------------------------------------
  const [localDefName, setLocalDefName] = useState(nodeInfo?.defName ?? '')
  const defSyncKey = nodeInfo !== null && nodeInfo.defId !== null ? String(nodeInfo.defId) : null
  const prevDefSyncRef = useRef<{ key: string | null; name: string | undefined }>({
    key: null,
    name: undefined,
  })
  useEffect(() => {
    const next = nodeInfo?.defName
    const prev = prevDefSyncRef.current
    if (defSyncKey !== prev.key || next !== prev.name) {
      prevDefSyncRef.current = { key: defSyncKey, name: next }
      setLocalDefName(next ?? '')
    }
  }, [nodeInfo?.defName, defSyncKey])

  const commitDefName = useCallback(() => {
    if (nodeInfo === null || nodeInfo.defId === null) return
    const trimmed = localDefName.trim()
    scene.set_component_name(nodeInfo.defId, trimmed === '' ? undefined : trimmed)
    onNameChanged()
  }, [nodeInfo, localDefName, scene, onNameChanged])

  // --------------------------------------------------------------------------
  // "(N instances)" click: select every instance of the definition. The
  // viewport and the Outliner both render from this one selection state.
  // --------------------------------------------------------------------------
  const selectAllInstances = useCallback(() => {
    if (nodeInfo === null || nodeInfo.instanceIds.length === 0) return
    onSelectMany(nodeInfo.instanceIds.map((id) => ({ kind: 'instance' as const, id })))
  }, [nodeInfo, onSelectMany])

  // --------------------------------------------------------------------------
  // Segments (drawn circles only) — SketchUp's Entity Info "Segments".
  //
  // Editing it RE-FACETS the existing circle: its exact centre and radius are
  // kept and its chords are rebuilt at the new density, as ONE draft on the
  // circle's plane — so a circle drawn on a face, over the void, or half and
  // half re-facets the same way (`draft_refacet_curve`). It is not a setting
  // for the next circle drawn.
  //
  // The commit has to get the selection right: the circle's curve key hashes
  // only its centre and radius, so a selected curve keeps its key through the
  // rebuild, but a selected SHAPE's key is its smallest edge key and is
  // replaced with the facets — so the selection is re-pointed at the rebuilt
  // circle before the panel re-renders, or it would go blank on a stale key.
  // --------------------------------------------------------------------------
  const [localSegments, setLocalSegments] = useState('')
  // Keyed on plane context + curve key: the same circle reached any other
  // way is the same circle, and a different circle never shares the key, so
  // uncommitted text cannot carry from one circle to another.
  const segSyncKey =
    nodeInfo !== null && nodeInfo.curveKey !== null
      ? `${nodeInfo.ctx}:${nodeInfo.curveKey}`
      : null
  const prevSegSyncRef = useRef<{ key: string | null; value: number | null }>({
    key: null,
    value: null,
  })
  useEffect(() => {
    const next = nodeInfo?.segments ?? null
    const prev = prevSegSyncRef.current
    if (segSyncKey !== prev.key || next !== prev.value) {
      prevSegSyncRef.current = { key: segSyncKey, value: next }
      setLocalSegments(next === null ? '' : String(next))
    }
  }, [nodeInfo?.segments, segSyncKey])

  const commitSegments = useCallback(() => {
    if (
      nodeInfo === null ||
      nodeInfo.curveKey === null ||
      nodeInfo.ctx === undefined ||
      nodeInfo.segments === null
    ) {
      return
    }
    const ctx = nodeInfo.ctx
    const curveKey = nodeInfo.curveKey
    const parsed = Number.parseInt(localSegments.trim(), 10)
    if (!Number.isFinite(parsed)) {
      setLocalSegments(String(nodeInfo.segments))
      return
    }
    if (parsed === nodeInfo.segments) return // nothing to do
    if (parsed < MIN_CIRCLE_SEGMENTS) {
      // Refused HERE rather than clamped silently: substituting 24 for what
      // was typed would build a different circle than the one asked for. The
      // kernel refuses this too (`SegmentsBelowFloor`) — this is the same
      // refusal, said before the round trip.
      onToast?.(kernelErrorMessage('SegmentsBelowFloor', ''), 'SegmentsBelowFloor')
      setLocalSegments(String(nodeInfo.segments))
      return
    }

    try {
      runDraft(scene, { kind: 'ctx', ctx }, 'Segments', (d) => {
        scene.draft_refacet_curve(d, keyToId(curveKey), parsed)
      })
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const raw = err instanceof Error ? err.message : String(err)
      onToast?.(kernelErrorMessage(code ?? 'Unknown', raw), code ?? undefined)
      setLocalSegments(String(nodeInfo.segments))
      return
    }

    // Re-point the selection at the rebuilt circle. The facets (and so the
    // run, edge, and shape keys) were replaced; the circle's own curve key
    // (centre and radius) survives, and names the whole circle.
    const pu = readPlaneUnits(scene as unknown as PlaneUnitsScene, ctx)
    let repointTo: NodeRef | null = null
    if (pu !== null) {
      if (nodeInfo.kind === 'draft-curve') {
        repointTo = draftRef('draft-curve', ctx, curveKey)
      } else {
        const unit = pu.units.find((u) => u.curves.some((c) => c.curveKey === curveKey))
        if (unit !== undefined) {
          repointTo = nodeInfo.kind === 'draft-island'
            ? draftRef('draft-island', ctx, unit.key)
            : draftRef('draft-curve', ctx, curveKey)
        }
      }
    }
    if (repointTo !== null) onSelectMany([repointTo])
    onGeometryChanged()
  }, [nodeInfo, localSegments, scene, onGeometryChanged, onSelectMany, onToast])

  // Model Health repairs for an open object (a definition member repairs the
  // shared definition). A refusal toasts the kernel's copy; success goes
  // through the same refresh as any panel edit.
  const runHealthRepair = useCallback(
    (call: () => unknown) => {
      try {
        call()
      } catch (err) {
        const code = parseKernelErrorCode(err)
        const raw = err instanceof Error ? err.message : String(err)
        onToast?.(kernelErrorMessage(code ?? 'Unknown', raw), code ?? undefined)
        return
      }
      onGeometryChanged()
    },
    [onToast, onGeometryChanged],
  )

  // Thicken… on a flat surface: one `hew.solid.thicken` through the API's
  // transaction path (the same one the panel's batches use), refusals toasted.
  const [thickenOpen, setThickenOpen] = useState(false)
  const runThicken = useCallback(
    (row: HealthRow, distance: number, centered: boolean) => {
      setThickenOpen(false)
      try {
        const result = runBatch(scene, (n) => batchLabel('thicken', n), [thickenOp(row, distance, centered)])
        if (result.failed.length > 0) {
          onToast?.(failureLine('thicken', result.failed[0].explanation))
          return
        }
      } catch (err) {
        const code = parseKernelErrorCode(err)
        const raw = err instanceof Error ? err.message : String(err)
        onToast?.(code !== null ? kernelErrorMessage(code, raw) : raw, code ?? undefined)
        return
      }
      onGeometryChanged()
    },
    [scene, onToast, onGeometryChanged],
  )

  // --------------------------------------------------------------------------
  // Tag add state — hidden behind a "+" affordance (HIG-style disclosure).
  // The field auto-focuses when revealed; Enter commits, Esc cancels, blurring
  // with an empty field closes it again.
  // --------------------------------------------------------------------------
  const [addingTag, setAddingTag] = useState(false)
  const [tagInput, setTagInput] = useState('')

  // Close the add-tag field whenever the selection changes (single node or
  // the whole multi-selection).
  const selectedKeyForReset = nodeInfo !== null ? nodeKey(nodeInfo.node) : selectedIds.map(nodeKey).join('|')
  const prevSelectedKeyRef = useRef<string | null>(selectedKeyForReset)
  useEffect(() => {
    if (prevSelectedKeyRef.current !== selectedKeyForReset) {
      prevSelectedKeyRef.current = selectedKeyForReset
      setAddingTag(false)
      setTagInput('')
    }
  }, [selectedKeyForReset])

  // ---- Multi-selection tags ------------------------------------------
  // Every taggable node in the selection (objects/groups/instances; sketch
  // entities carry no tags), as the parallel kind/id lists the kernel's
  // `*_many` calls take, plus the tags carried by EVERY one of them — the
  // intersection. A tag only some of the selection carries is not shown:
  // this section answers "what is true of the whole selection", so + adds
  // a tag to all (and it appears at once) and × removes it from all
  // (playtest round 2: a union-with-counts view read as noise).
  const multi = useMemo(() => {
    if (selectedIds.length < 2) return null
    const kinds: number[] = []
    const ids: bigint[] = []
    let common: Map<string, string[]> | null = null
    for (const node of selectedIds) {
      const kindNum = nodeKindToNumber(node.kind)
      if (kindNum < 0) continue
      kinds.push(kindNum)
      ids.push(node.id)
      const own = new Map<string, string[]>()
      for (const raw of scene.node_tags(kindNum, node.id)) {
        const path = raw.split('/').map((seg) => seg.trim()).filter((seg) => seg.length > 0)
        if (path.length > 0) own.set(path.join('/'), path)
      }
      if (common === null) {
        common = own
      } else {
        for (const key of [...common.keys()]) {
          if (!own.has(key)) common.delete(key)
        }
      }
    }
    if (kinds.length === 0) return null
    const tags = [...(common ?? new Map<string, string[]>()).values()].sort((a, b) => a.join('/').localeCompare(b.join('/')))
    return { kinds, ids, tags }
    // docRev: tags change on every mutation without changing identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, scene, docRev])

  const handleAddTag = useCallback(() => {
    const segments = tagInput.split('/').map((s) => s.trim()).filter((s) => s.length > 0)
    if (segments.length === 0) return
    if (nodeInfo !== null && nodeInfo.kindNum !== null) {
      scene.add_node_tag(nodeInfo.kindNum, nodeInfo.id, segments)
    } else if (multi !== null) {
      // One undo step across the whole selection (kernel compound).
      try {
        scene.add_node_tag_many(new Uint8Array(multi.kinds), new BigUint64Array(multi.ids), segments)
      } catch (err) {
        onToast?.(`Add tag failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    } else {
      return
    }
    setTagInput('')
    setAddingTag(false)
    onTagsChanged()
  }, [nodeInfo, multi, tagInput, scene, onTagsChanged, onToast])

  const handleRemoveTagFromAll = useCallback((path: string[]) => {
    if (multi === null) return
    try {
      scene.remove_node_tag_many(new Uint8Array(multi.kinds), new BigUint64Array(multi.ids), path)
    } catch (err) {
      onToast?.(`Remove tag failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    onTagsChanged()
  }, [multi, scene, onTagsChanged, onToast])

  const handleRemoveTag = useCallback((path: string[]) => {
    if (nodeInfo === null || nodeInfo.kindNum === null) return
    scene.remove_node_tag(nodeInfo.kindNum, nodeInfo.id, path)
    onTagsChanged()
  }, [nodeInfo, scene, onTagsChanged])

  // A selected dimension or leader text (read-only). Re-derived on every
  // document change, since the text and tags can change without the id doing so.
  const annotationInfo = useMemo(() => {
    if (selectedIds.length !== 0 || selectedAnnotation === null) return null
    const ann = scene as unknown as AnnotationScene
    const kind = ann.annotation_kind(selectedAnnotation)
    if (kind === undefined) return null
    const type = kind === 'leader' ? 'Text' : kind === 'radial' ? 'Radial dimension' : 'Dimension'
    const name = kind === 'leader' ? ann.annotation_text(selectedAnnotation) || type : type
    const tags = (ann.annotation_tags?.(selectedAnnotation) ?? []).map((t) => t.split('/'))
    return { name, type, tags }
    // docRev: text and tags change on every mutation without changing identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, selectedIds, selectedAnnotation, docRev])

  // A selected construction guide (read-only).
  const guideInfo = useMemo(() => {
    if (selectedIds.length !== 0 || selectedAnnotation !== null || selectedGuide === null) return null
    const guides = scene as unknown as GuideScene
    const kind = guides.guide_kind(selectedGuide)
    if (kind === undefined) return null
    const tags = guides.guide_tags(selectedGuide).map((t) => t.split('/'))
    return { name: kind === 'point' ? 'Guide point' : 'Guide line', type: 'Guide', tags }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, selectedIds, selectedAnnotation, selectedGuide, docRev])

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (annotationInfo !== null) {
    return (
      <div style={PANEL_STYLE}>
        <div>
          <div style={LABEL_STYLE}>Name</div>
          <div style={VALUE_STYLE}>{annotationInfo.name}</div>
        </div>
        <div>
          <div style={LABEL_STYLE}>Type</div>
          <div style={VALUE_STYLE}>{annotationInfo.type}</div>
        </div>
        {annotationInfo.tags.length > 0 && (
          <div>
            <div style={LABEL_STYLE}>Tags</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {annotationInfo.tags.map((path) => (
                <div key={path.join('/')} style={VALUE_STYLE}>
                  {path.join(' / ')}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (guideInfo !== null) {
    return (
      <div style={PANEL_STYLE}>
        <div>
          <div style={LABEL_STYLE}>Name</div>
          <div style={VALUE_STYLE}>{guideInfo.name}</div>
        </div>
        <div>
          <div style={LABEL_STYLE}>Type</div>
          <div style={VALUE_STYLE}>{guideInfo.type}</div>
        </div>
        {guideInfo.tags.length > 0 && (
          <div>
            <div style={LABEL_STYLE}>Tags</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {guideInfo.tags.map((path) => (
                <div key={path.join('/')} style={VALUE_STYLE}>
                  {path.join(' / ')}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Nothing selected → an empty panel, no boilerplate.
  if (nodeInfo === null && selectedIds.length === 0) {
    return <div style={PANEL_STYLE} />
  }

  // Multi-selection → a quiet count line, the union Bounding Box of every
  // selected node's mesh (if any), and a Tags section for the whole
  // selection: a chip per tag EVERY selected node carries, × removes it from
  // every selected node, + adds one to every selected node — each as ONE
  // undo step (playtest: "apply a tag to multiple selected objects").
  if (nodeInfo === null) {
    return (
      <div style={PANEL_STYLE}>
        <div style={{ fontSize: '11px', color: 'var(--text-faint, #666)', padding: '4px 8px' }}>
          {selectedIds.length} selected
        </div>
        {bounds !== null && <BoundingBoxRow bounds={bounds} />}
        {multi !== null && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>Tags</div>
              {!addingTag && (
                <button
                  onClick={() => setAddingTag(true)}
                  title="Add tag to all selected"
                  aria-label="Add tag to all selected"
                  style={ADD_TAG_BUTTON_STYLE}
                >
                  +
                </button>
              )}
            </div>
            {multi.tags.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {multi.tags.map((path) => (
                  <TagChip
                    key={path.join('/')}
                    path={path}
                    onRemove={() => handleRemoveTagFromAll(path)}
                    removeLabel={`Remove tag ${path.join(' / ')} from all selected`}
                  />
                ))}
              </div>
            )}
            {addingTag && (
              <input
                style={{ ...INPUT_STYLE, marginTop: multi.tags.length > 0 ? '6px' : '2px' }}
                autoFocus
                aria-label="New tag for all selected"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddTag()
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setTagInput('')
                    setAddingTag(false)
                  }
                }}
                onBlur={() => {
                  if (tagInput.trim() === '') {
                    setTagInput('')
                    setAddingTag(false)
                  } else {
                    handleAddTag()
                  }
                }}
                placeholder="Structure/Roof"
                spellCheck={false}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  const drawnLength = (nodeInfo as { length?: number | null }).length ?? null

  return (
    <div style={PANEL_STYLE}>
      {/* Name — sketches can't be named yet; show the read-only default label
       * instead. A component instance splits into Definition Name (the shared
       * label — renames every instance) and Instance Name (this placement's
       * own override; the Outliner then shows "Instance (Definition)"). */}
      {nodeInfo.kind !== 'object' && nodeInfo.kind !== 'group' && nodeInfo.kind !== 'instance' ? (
        <div>
          <div style={LABEL_STYLE}>Name</div>
          <div style={VALUE_STYLE}>{nodeInfo.defaultLabel}</div>
        </div>
      ) : nodeInfo.kind === 'instance' ? (
        <>
          <div>
            <div style={LABEL_STYLE}>Definition Name</div>
            <input
              style={INPUT_STYLE}
              aria-label="Definition Name"
              value={localDefName}
              onChange={(e) => setLocalDefName(e.target.value)}
              onBlur={commitDefName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              title="Shared by every instance of this component"
              spellCheck={false}
            />
          </div>
          <div>
            <div style={LABEL_STYLE}>Instance Name</div>
            <input
              style={INPUT_STYLE}
              aria-label="Instance Name"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              placeholder={nodeInfo.defaultLabel}
              title="This instance only — leave empty to show the definition name"
              spellCheck={false}
            />
          </div>
        </>
      ) : (
        <div>
          <div style={LABEL_STYLE}>Name</div>
          <input
            style={INPUT_STYLE}
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            placeholder={nodeInfo.defaultLabel}
            spellCheck={false}
          />
        </div>
      )}

      {/* Type — an instance also shows how many placements share its
       * definition; the count selects them all (viewport + Outliner). */}
      <div>
        <div style={LABEL_STYLE}>Type</div>
        <div style={VALUE_STYLE}>
          <span>{kindLabel(nodeInfo.kind)}</span>
          {nodeInfo.store !== null && (
            <div data-testid="object-info-store" style={{ ...VALUE_STYLE, color: 'var(--text-faint, #888)' }}>
              {nodeInfo.store}
            </div>
          )}
          {nodeInfo.kind === 'instance' && nodeInfo.instanceIds.length > 0 && (
            <>
              {' '}
              <button
                onClick={selectAllInstances}
                title="Select every instance of this component"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  font: 'inherit',
                  fontFamily: 'var(--font-family-ui)',
                  color: 'var(--accent-base, #7aa7e0)',
                  cursor: 'pointer',
                }}
              >
                ({nodeInfo.instanceIds.length}{' '}
                {nodeInfo.instanceIds.length === 1 ? 'instance' : 'instances'})
              </button>
            </>
          )}
        </div>
      </div>

      {/* Length — a drawn line, or a curve (the sum of its edges). */}
      {drawnLength !== null && (
        <div>
          <div style={LABEL_STYLE}>Length</div>
          <div style={VALUE_STYLE} data-testid="object-info-length">{formatLength(drawnLength)}</div>
        </div>
      )}

      {/* Points — a drawn thing only: how many distinct vertices its line
       * work has. Read-only, unlike Segments below — only a circle has a
       * facet density to edit, the rest is the shape as drawn. */}
      {nodeInfo.points !== null && (
        <div>
          <div style={LABEL_STYLE}>Points</div>
          <div style={VALUE_STYLE}>{nodeInfo.points}</div>
        </div>
      )}

      {/* Segments — a drawn circle only, on a face or over the void. Editing it
       * re-facets that circle in place (one undo step); the circle itself,
       * its centre and its radius are unchanged. Commits on Enter or blur, like the name fields. */}
      {nodeInfo.segments !== null && (
        <div>
          <div style={LABEL_STYLE}>Segments</div>
          <input
            style={INPUT_STYLE}
            aria-label="Segments"
            type="number"
            min={MIN_CIRCLE_SEGMENTS}
            step={1}
            value={localSegments}
            onChange={(e) => setLocalSegments(e.target.value)}
            onBlur={commitSegments}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                // A focused input's own Escape-revert must not ALSO pop the
                // enclosing group/component edit context — same class as the
                // dialogs' Escape dismiss (see dialogs.test.tsx). Stopping
                // propagation here doesn't change the revert contract itself.
                e.stopPropagation()
                setLocalSegments(String(nodeInfo.segments))
                e.currentTarget.blur()
              }
            }}
            title={`How many straight facets this circle is drawn with (minimum ${MIN_CIRCLE_SEGMENTS}). Changing it rebuilds the circle.`}
            spellCheck={false}
          />
        </div>
      )}

      {/* Geometry — only for objects: Solid, or the Model Health verdict
       * ("Surface" is a sheet drawn on purpose, never styled as a problem)
       * with a Show link into the Model Health panel. */}
      {nodeInfo.solid !== null && (
        <div>
          <div style={LABEL_STYLE}>Geometry</div>
          <div
            style={{
              ...VALUE_STYLE,
              color: nodeInfo.solid
                ? 'var(--status-solid)'
                : 'var(--text-secondary)',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'baseline',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <span data-object-verdict>
              {nodeInfo.solid ? 'Solid' : geometryLine(nodeInfo.health === null ? 'closerLook' : classifyRow(nodeInfo.health), nodeInfo.health?.rims.length ?? 0, nodeInfo.health?.accepted ?? false, nodeInfo.health === null ? undefined : openReason(nodeInfo.health))}
            </span>
            {nodeInfo.health !== null && !nodeInfo.solid && (
              <>
                {canCloseRow(nodeInfo.health) && (
                  <button
                    type="button"
                    title={TOOLTIP.close(rowPlacements(nodeInfo.health))}
                    style={HEALTH_ACTION_STYLE}
                    onClick={() => runHealthRepair(() => scene.cap_rims(nodeInfo.id, null))}
                  >
                    {ACTION.close}
                  </button>
                )}
                {classifyRow(nodeInfo.health) === 'flatPanels' && (
                  <button
                    type="button"
                    title={TOOLTIP.addThickness}
                    style={HEALTH_ACTION_STYLE}
                    onClick={() => setThickenOpen(true)}
                  >
                    {ACTION.addThickness}
                  </button>
                )}
                <button
                  type="button"
                  title={nodeInfo.health.accepted ? TOOLTIP.unkeep(rowPlacements(nodeInfo.health)) : TOOLTIP.keep(rowPlacements(nodeInfo.health))}
                  style={HEALTH_ACTION_STYLE}
                  onClick={() => runHealthRepair(() => scene.set_accepted_surface(nodeInfo.id, !nodeInfo.health!.accepted))}
                >
                  {nodeInfo.health.accepted ? ACTION.unkeep : ACTION.keep}
                </button>
              </>
            )}
            {thickenOpen && nodeInfo.health !== null && (
              <ThickenDialog
                count={1}
                onCancel={() => setThickenOpen(false)}
                onConfirm={(distance, centered) => runThicken(nodeInfo.health!, distance, centered)}
              />
            )}
            {!nodeInfo.solid && onShowHealth !== undefined && (
              <button
                type="button"
                aria-label={ACTION.showInList}
                onClick={() => onShowHealth(nodeInfo.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--accent-base)',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  fontWeight: 'normal',
                  textDecoration: 'underline',
                }}
              >
                {ACTION.showInList}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bounding Box — world AABB extents; hidden for a mesh-less selection
       * (e.g. a Sketch, or a stale instance). */}
      {bounds !== null && <BoundingBoxRow bounds={bounds} />}

      {/* Tags — sketches can't be tagged yet. Empty state is just the "+"
       * button next to the label: no chips, no "No tags" text. */}
      {(nodeInfo.kind === 'object' || nodeInfo.kind === 'group' || nodeInfo.kind === 'instance') && (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>Tags</div>
          {!addingTag && (
            <button
              onClick={() => setAddingTag(true)}
              title="Add tag"
              aria-label="Add tag"
              style={ADD_TAG_BUTTON_STYLE}
            >
              +
            </button>
          )}
        </div>

        {nodeInfo.tags.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {nodeInfo.tags.map((path) => (
              <TagChip
                key={path.join('/')}
                path={path}
                onRemove={() => handleRemoveTag(path)}
              />
            ))}
          </div>
        )}

        {/* Add-tag field — revealed by the "+" button. Auto-focused; Enter
         * commits, Esc cancels, blur with an empty field closes. */}
        {addingTag && (
          <input
            style={{ ...INPUT_STYLE, marginTop: nodeInfo.tags.length > 0 ? '6px' : '2px' }}
            autoFocus
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleAddTag()
              } else if (e.key === 'Escape') {
                // Same reasoning as the Segments field above: dismissing the
                // transient add-tag input on Escape must not also pop the
                // group/component edit context underneath it.
                e.stopPropagation()
                setTagInput('')
                setAddingTag(false)
              }
            }}
            onBlur={() => {
              if (tagInput.trim() === '') {
                setTagInput('')
                setAddingTag(false)
              } else {
                handleAddTag()
              }
            }}
            placeholder="Structure/Roof"
            spellCheck={false}
          />
        )}
      </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BoundingBoxRow — world AABB extents as "X 12mm × Y 34mm × Z 56mm", each
// axis letter colored to match the viewport's axis colors (X=red, Y=green,
// Z=blue — Z is height) and each extent formatted with the same length
// formatter Tape Measure / typed entry use, so it always reads in the
// active length format (docs/dev/DEVELOPMENT.md rule 6 — display-layer
// formatting only, kernel lengths stay f64 meters throughout). Labeled
// "Bounding Box" (not "Dimensions") so it's clear the three numbers are the
// selection's axis-aligned extents, not e.g. a single object property.
// ---------------------------------------------------------------------------

function BoundingBoxRow({ bounds }: { bounds: Bounds }) {
  const [ex, ey, ez] = boundsExtents(bounds)
  return (
    <div>
      <div style={LABEL_STYLE}>Bounding Box</div>
      <div style={VALUE_STYLE}>
        <span style={{ color: 'var(--axis-red)' }}>X</span> {formatLength(ex)}
        <span style={{ color: 'var(--text-faint, #888)' }}> × </span>
        <span style={{ color: 'var(--axis-green)' }}>Y</span> {formatLength(ey)}
        <span style={{ color: 'var(--text-faint, #888)' }}> × </span>
        <span style={{ color: 'var(--axis-blue)' }}>Z</span> {formatLength(ez)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TagChip — a single removable tag chip
// ---------------------------------------------------------------------------

function TagChip({
  path,
  onRemove,
  removeLabel,
}: {
  path: string[]
  onRemove: () => void
  removeLabel?: string
}) {
  const display = path.join(' / ')
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        background: 'var(--accent-tint-18, #1e3a5e)',
        borderRadius: '3px',
        padding: '2px 6px',
        fontSize: '11px',
        color: 'var(--accent-text-on-tint, #aaccee)',
        fontFamily: 'var(--font-family-ui)',
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {display}
      </span>
      <button
        onClick={onRemove}
        aria-label={removeLabel ?? `Remove tag ${display}`}
        title={removeLabel ?? 'Remove tag'}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent-text-on-tint, #7799bb)',
          cursor: 'pointer',
          fontSize: '12px',
          lineHeight: 1,
          padding: '0 1px',
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  )
}
