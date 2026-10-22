/**
 * dragCommit — click-drag-release for two-point tools (GitHub #52b).
 *
 * SketchUp accepts two gestures for anything with a start point and an end
 * point: click, move, click; or press, drag, release. Hew's tools are all
 * written for the first. This module adds the second WITHOUT touching any
 * tool's own logic: a release that ends a real drag is handed to the tool as
 * its second click, through the very same `onPointerDown` a click would
 * use, so commits, typed values and inference behave identically.
 *
 * The rules (docs/design/v13-playtest1-briefs.md, P5):
 *
 * - Only a tool that declares `Tool.dragCommits` takes part. Every other
 *   tool's press and release keep exactly the meaning they have today.
 * - Only the press that STARTED the gesture arms a drag: the tool was idle
 *   before the press (`gestureInFlight` false) and mid-gesture after it
 *   (true). A press in a later stage — Arc's bulge, a Line chain's third
 *   point, Rotate's angle — never arms, so a drag there stays inert.
 * - A release inside the drag threshold (`exceedsDragThreshold`, the same
 *   pixel distance Select's drag-move uses) is a plain click: the gesture
 *   continues click-click, unchanged.
 * - A release past the threshold, while the SAME tool is still mid-gesture
 *   (Escape, a typed Enter or a tool switch during the drag all end it
 *   first), is the second click. The tool's optional `onDragCommitted` then
 *   runs, for a tool whose second click alone would not end the gesture the
 *   way a drag should (Line: one segment, then the chain ends).
 *
 * Pure decision logic: the Viewport owns the DOM, snapping and camera; it
 * calls `press` around its ordinary press delivery, `move` on every pointer
 * move and `release` on the pointerup, passing a callback that resolves the
 * release snap and delivers it.
 */

import type { Tool } from '../tools/types'
import { exceedsDragThreshold } from './dragMove'

/** Whether `tool` takes part in click-drag-release at all. */
export function dragCommits(tool: Tool): boolean {
  return tool.dragCommits === true
}

/**
 * Is `tool` between the first point of a gesture and its last? The tool's
 * own `gestureInFlight` when it has one (a tool whose `capturingInput` is
 * also true for a post-commit typing window, like Move's array copies),
 * else `capturingInput` — which, for every other participating tool, is
 * exactly "a gesture is anchored".
 */
export function gestureInFlight(tool: Tool): boolean {
  if (tool.gestureInFlight !== undefined) return tool.gestureInFlight()
  return tool.capturingInput?.() ?? false
}

interface Armed {
  tool: Tool
  pointerId: number
  startX: number
  startY: number
  /** Sticky: once past the threshold the gesture is a drag even if the
   *  pointer comes back (the same rule as Select's drag-move). */
  dragged: boolean
  /** The gesture this press started was committed or ended by other means
   *  mid-drag (a typed Enter, Escape): the release must deliver nothing,
   *  though the pointer stays this gate's until it lifts. */
  spent: boolean
}

export class DragCommitGate {
  private armed: Armed | null = null

  /** True while a starting press waits for its release. */
  get isArmed(): boolean {
    return this.armed !== null
  }

  /** True once the armed press has travelled past the drag threshold. */
  get isDragging(): boolean {
    return this.armed?.dragged === true
  }

  /** The pointer that armed the gesture, or null. */
  get pointerId(): number | null {
    return this.armed?.pointerId ?? null
  }

  /**
   * A left press about to reach `tool`. `deliver` hands it to the tool (the
   * Viewport's ordinary press path); the gate reads the tool's stage on
   * either side of it. Returns whether the press armed a drag.
   */
  press(tool: Tool, pointerId: number, x: number, y: number, deliver: () => void): boolean {
    this.armed = null
    const eligible = dragCommits(tool) && !gestureInFlight(tool)
    deliver()
    if (eligible && gestureInFlight(tool)) {
      this.armed = { tool, pointerId, startX: x, startY: y, dragged: false, spent: false }
      return true
    }
    return false
  }

  /** A pointer move (canvas pixels). Only the arming pointer counts. */
  move(pointerId: number, x: number, y: number): void {
    const a = this.armed
    if (a === null || a.pointerId !== pointerId || a.dragged) return
    if (exceedsDragThreshold(a.startX, a.startY, x, y)) a.dragged = true
  }

  /**
   * The release of `pointerId` at (`x`, `y`) with `tool` active. When it
   * ends a drag of a gesture still in flight on the same tool, `deliver`
   * hands the second click to the tool and `onDragCommitted` follows.
   * Returns whether the release was delivered as a click.
   */
  release(tool: Tool, pointerId: number, x: number, y: number, deliver: () => void): boolean {
    const a = this.armed
    if (a === null || a.pointerId !== pointerId) return false
    this.armed = null
    if (!a.dragged && exceedsDragThreshold(a.startX, a.startY, x, y)) a.dragged = true
    if (a.spent || !a.dragged || a.tool !== tool || !gestureInFlight(tool)) return false
    deliver()
    tool.onDragCommitted?.()
    return true
  }

  /**
   * The tool consumed a key that commits or ends the armed gesture (Enter,
   * Escape) mid-drag. Its release must not become another click — a Line
   * whose first segment a typed Enter committed is still anchored, and the
   * release would draw a second one — but the pointer keeps belonging to
   * the gate until it lifts (other pointers stay ignored, a touch press's
   * camera stays off).
   */
  spend(): void {
    if (this.armed !== null) this.armed.spent = true
  }

  /** Drop the armed press without delivering anything (pointercancel, blur,
   *  tool switch, a release the Viewport never saw). */
  cancel(): void {
    this.armed = null
  }
}
