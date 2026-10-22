/**
 * Thicken… parsing and the session's remembered choice (docs/design/
 * import-health.md §5.4, R4): a length typed in the display units and which
 * side of the surface the thickness goes on.
 */
import { getLengthSystem, parseLengthToMeters } from '../settings/units'
import { THICKNESS } from './healthCopy'

export type ThickenSide = 'front' | 'behind' | 'centered'

/** Getters, so each read follows the active language (not frozen at import). */
export const THICKEN_SIDE_LABELS: Record<ThickenSide, string> = {
  get front() {
    return THICKNESS.inFront
  },
  get behind() {
    return THICKNESS.behind
  },
  get centered() {
    return THICKNESS.centered
  },
}

/** The thickness a person starts from, in their display units: 3 mm in
 *  metric, 1/8" in imperial. */
export function defaultThicknessText(): string {
  return getLengthSystem() === 'imperial' ? '1/8"' : '3 mm'
}

export interface ThickenChoice {
  text: string
  side: ThickenSide
}

/** The distance + `centered` flag `hew.solid.thicken` takes, or why not. */
export type ThickenParse =
  | { ok: true; distance: number; centered: boolean }
  | { ok: false; error: string }

/** Parse the typed thickness (the VCB's length grammar) and map the side:
 *  In front = `distance`, Behind = `-distance`, Centered = `centered: true`. */
export function parseThickness(text: string, side: ThickenSide): ThickenParse {
  const meters = parseLengthToMeters(text)
  if (meters === null || !Number.isFinite(meters)) return { ok: false, error: THICKNESS.needValue }
  if (meters <= 0) return { ok: false, error: THICKNESS.needPositive }
  return side === 'centered'
    ? { ok: true, distance: meters, centered: true }
    : { ok: true, distance: side === 'behind' ? -meters : meters, centered: false }
}

let last: ThickenChoice | null = null

/** The last thickness + side used this session (3 mm or 1/8" the first time). */
export function getThickenChoice(): ThickenChoice {
  return last ?? { text: defaultThicknessText(), side: 'front' }
}

export function rememberThickenChoice(choice: ThickenChoice): void {
  last = { ...choice }
}

/** Test hook. */
export function resetThickenChoice(): void {
  last = null
}
