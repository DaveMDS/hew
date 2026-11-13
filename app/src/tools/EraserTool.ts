/**
 * EraserTool — SketchUp's Eraser: click an entity to erase it, or press and
 * drag across several. Everything the stroke touches is selected as it is
 * touched, so it shows in the selection highlight and in Entity Info, and
 * on release the stroke's entities are erased together, in one undo step.
 * Escape during a stroke abandons it: the selection is cleared, nothing is
 * erased, and nothing more is touched until the button comes up.
 *
 * What it touches is exactly what a Select click at that point resolves
 * (the host's `pickAt`): a guide, a dimension or leader text, a drawn line or
 * curve, or the Object, group, or component the click would select in the
 * current editing context. A face is never erased on its own: a drawn region
 * or shape under the cursor is skipped. Erasing goes through the same delete
 * as the Delete key.
 *
 * The tool works from canvas pixels (`onPointerRawDown`/
 * `onPointerScreenMove`); the host turns a pixel into Select's own pick.
 * Between two pointer events the stroke is sampled every few pixels, so a
 * fast drag still catches a guide it crossed between events.
 *
 * A selection made before the tool was chosen is left alone until the first
 * press, which clears it (SketchUp parity): the Eraser never erases a
 * selection it did not make, only what the stroke touches. The erase reads
 * the stroke's own list, never the host's selection, so it does not depend
 * on the selection having caught up with the last touch.
 */

import { t } from '@lingui/core/macro'
import type { Ray } from '../viewport/math'
import type { ClickAcquire, Snap, Tool } from './types'
import { nodeKey, type NodeRef } from '../panels/treeModel'

/** Something the Eraser can erase: a guide, an annotation, or what a Select
 * click would select (a node or a drawn line). */
export type EraseTarget =
  | { kind: 'guide'; id: bigint }
  | { kind: 'annotation'; id: bigint }
  | { kind: 'node'; ref: NodeRef }

/** What the tool needs from the viewport. */
export interface EraserHost {
  /** The erasable entity under canvas pixel (`xPx`, `yPx`), or null. */
  pickAt(xPx: number, yPx: number): EraseTarget | null
  /** Add `target` to the selection, leaving the rest of it as it is. */
  select(target: EraseTarget): void
  /** Drop the whole selection: nodes, guides, and annotations. */
  clearSelection(): void
  /** Erase `targets` (never empty) in one undo step. */
  erase(targets: readonly EraseTarget[]): void
}

/** Stroke sampling step between two pointer events, in CSS pixels — under
 * the guide/annotation pick radius, so a crossed entity is never skipped. */
const SAMPLE_STEP_PX = 4

function targetKey(target: EraseTarget): string {
  return target.kind === 'node' ? `node:${nodeKey(target.ref)}` : `${target.kind}:${target.id}`
}

export class EraserTool implements Tool {
  readonly name = 'Eraser'

  private readonly host: EraserHost
  /** A stroke is in progress: the button is down. */
  private pressed = false
  /** The current stroke was abandoned; ignore it until the release. */
  private aborted = false
  /** Everything the current stroke touched, in touch order, by key. */
  private marked = new Map<string, EraseTarget>()
  /** The previous stroke sample, for in-between sampling. */
  private last: { x: number; y: number } | null = null

  constructor(host: EraserHost) {
    this.host = host
  }

  statusHint(): string {
    return t`Click an object, line, guide, dimension, or text to erase it, or drag across several. Esc cancels the drag.`
  }

  /** A click takes what a Select click takes; the viewport highlights it
   * under the cursor while no stroke is in progress. */
  clickAcquire(): ClickAcquire | null {
    return { guides: false, nodes: false, select: true }
  }

  onPointerMove(_snap: Snap | null, _ray: Ray): void {
    // Picking runs on canvas pixels; see onPointerScreenMove.
  }

  onPointerDown(_snap: Snap | null, _ray: Ray): void {
    // The press is handled in onPointerRawDown, which carries the pixel.
  }

  onPointerRawDown(xPx: number, yPx: number): void {
    this.host.clearSelection()
    this.pressed = true
    this.aborted = false
    this.marked.clear()
    this.last = { x: xPx, y: yPx }
    this.markAt(xPx, yPx)
  }

  onPointerScreenMove(xPx: number, yPx: number): void {
    if (!this.pressed || this.aborted) return
    const from = this.last ?? { x: xPx, y: yPx }
    const steps = Math.max(1, Math.ceil(Math.hypot(xPx - from.x, yPx - from.y) / SAMPLE_STEP_PX))
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      this.markAt(from.x + (xPx - from.x) * f, from.y + (yPx - from.y) * f)
    }
    this.last = { x: xPx, y: yPx }
  }

  onPointerUp(_snap: Snap | null, _ray: Ray): void {
    if (!this.pressed) return
    const targets = this.aborted ? [] : [...this.marked.values()]
    this.endStroke()
    if (targets.length > 0) this.host.erase(targets)
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return
    if (this.pressed) this.abortStroke()
    else this.cancel()
  }

  /** Escape belongs to the tool only while a stroke is in progress. */
  hasArmedGesture(): boolean {
    return this.pressed && !this.aborted
  }

  onDocumentReset(): void {
    this.cancel()
  }

  onHistoryChanged(): void {
    // An undo or redo mid-stroke can take away what the stroke touched;
    // erasing the rest would not be what was drawn across, so the stroke
    // is abandoned.
    if (this.pressed) this.abortStroke()
  }

  cancel(): void {
    if (this.pressed) this.abortStroke()
    this.endStroke()
  }

  /** Abandon the stroke in progress: what it selected is deselected, and
   * nothing more is touched until the release. */
  private abortStroke(): void {
    if (this.aborted) return
    this.aborted = true
    if (this.marked.size > 0) this.host.clearSelection()
    this.marked.clear()
  }

  private endStroke(): void {
    this.pressed = false
    this.aborted = false
    this.marked.clear()
    this.last = null
  }

  private markAt(xPx: number, yPx: number): void {
    const hit = this.host.pickAt(xPx, yPx)
    if (hit === null) return
    const key = targetKey(hit)
    if (this.marked.has(key)) return
    this.marked.set(key, hit)
    this.host.select(hit)
  }
}
