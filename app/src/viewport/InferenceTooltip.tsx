/**
 * InferenceTooltip — the cursor-anchored snap-kind chip (
 * `07_inference_feedback.md`). Net new: nothing like this existed before
 * this milestone (`Viewport.tsx` rendered no DOM overlay at all).
 *
 * Positioned via `InferenceInfo`'s container-relative `screenX`/`screenY`
 * (from `Viewport.tsx`'s `onInferenceChange`, fired at the same point the
 * existing `onStatusChange` status-bar text is derived).
 */
import { useEffect, useState } from 'react'
import { inferenceAxisName, inferenceCssColor } from './inferenceColor'
import type { InferenceInfo } from './Viewport'

const KIND_LABEL: Record<string, string> = {
  endpoint: 'Endpoint',
  center: 'Center',
  quadrant: 'Quadrant',
  tangent: 'Tangent',
  midpoint: 'Midpoint',
  intersection: 'Intersection',
  'on-edge': 'On Edge',
  'on-face': 'On Face',
  'on-guide': 'On Guide',
  'on-axis': 'On Axis',
  ground: 'Ground',
  plane: 'On Plane',
  /** `DimensionTool`'s dimension-row alignment snap (`have-b`'s
   *  `findAlignmentSnap`) — a tool-local cue kind, never emitted by
   *  SnapService itself (see `DimensionTool.lastSnap`'s doc). */
  aligned: 'Aligned',
  /** `LineTool`'s from-point closing inference (module doc,
   *  `_findFromPointCandidate`) — another tool-local cue kind, same
   *  `lastSnap` opt-in as `aligned` above, never emitted by SnapService. */
  'from-point': 'From Point',
}

/** The human-readable label for a snap `kind` (`'on-edge'` → `'On Edge'`,
 *  an unrecognized kind passed through verbatim) — exported so other
 *  DOM-owning callers that want the SAME vocabulary without the full
 *  positioned chip (the Tape Measure loupe overlay, `Viewport.tsx`'s own
 *  imperative DOM, round-3 playtest finding 4) don't invent a second
 *  kind→label map to drift out of sync with this one. */
export function inferenceKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/** How long the same object must sit under the cursor before the tip's
 *  second line (what it is, and what it is in) appears. */
export const HOVER_DETAIL_DWELL_MS = 400

/**
 * `detail` is the app-resolved second line for the hit object in
 * `info.object`/`info.instance` (docs/design/selection-path.md, "The hover
 * line"). It appears only after the same subject has stayed under the cursor
 * for `HOVER_DETAIL_DWELL_MS`; moving onto another object, or off geometry,
 * restarts the dwell. The first line is never delayed.
 */
export function InferenceTooltip({ info, detail = null }: { info: InferenceInfo | null; detail?: string | null }) {
  const subject = info !== null && info.object !== undefined ? `${info.object}/${info.instance ?? ''}` : null
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    setSettled(null)
    if (subject === null) return
    const t = setTimeout(() => setSettled(subject), HOVER_DETAIL_DWELL_MS)
    return () => clearTimeout(t)
  }, [subject])

  if (info === null) return null

  const label = KIND_LABEL[info.kind] ?? info.kind
  const axisName = inferenceAxisName(info)
  const chipColor = inferenceCssColor(info)
  const showDetail = detail !== null && subject !== null && settled === subject

  return (
    <div
      data-testid="inference-tip"
      style={{
        position: 'absolute',
        left: `${info.screenX + 16}px`,
        top: `${info.screenY + 16}px`,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '1px',
        padding: '4px 8px',
        background: 'var(--surface-overlay)',
        border: `1px solid ${chipColor}`,
        borderRadius: '7px',
        fontFamily: 'var(--font-family-ui)',
        fontSize: '12px',
        color: 'var(--text-primary)',
        whiteSpace: 'nowrap',
        zIndex: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span>{label}</span>
        {/* The point named above is a REFERENCE the gesture takes its x/y from,
            not where the geometry lands: a shape has to be planar on the plane
            it is drawn on, so a snap sitting above that plane has its height
            dropped. Saying so is the difference between an alignment aid and a
            chip claiming a snap the commit did not honour. */}
        {info.projected === true && (
          <span style={{ color: 'var(--text-secondary)' }}>projected</span>
        )}
        {axisName !== null && info.kind !== 'on-axis' && (
          <span style={{ color: `var(--axis-${axisName})` }}>on {axisName} axis</span>
        )}
      </div>
      {showDetail && (
        <div data-testid="inference-tip-detail" style={{ color: 'var(--text-secondary)' }}>
          {detail}
        </div>
      )}
    </div>
  )
}
