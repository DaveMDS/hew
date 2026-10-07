/**
 * Imprint helpers. Every drawing on a plane — face topology, object-owned
 * sketches, free sketches — is one set of plane units (`planeUnits.ts`); the
 * legacy per-face imprint readers are gone. What remains is the rectangle
 * test the shape naming uses.
 */

import type { V3 } from '../viewport/geoHelpers'

/** Whether four points form a rectangle: consecutive sides perpendicular
 *  and opposite sides equal, within a relative tolerance. */
export function isRectangle(pts: readonly V3[]): boolean {
  if (pts.length !== 4) return false
  const side = (i: number): V3 => {
    const a = pts[i], b = pts[(i + 1) % 4]
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  }
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const len = (u: V3) => Math.sqrt(dot(u, u))
  const s = [side(0), side(1), side(2), side(3)]
  const scale = Math.max(len(s[0]), len(s[1]))
  if (scale <= 0) return false
  const tol = 1e-6 * scale
  for (let i = 0; i < 4; i++) {
    if (Math.abs(dot(s[i], s[(i + 1) % 4])) > tol * scale) return false
  }
  return Math.abs(len(s[0]) - len(s[2])) <= tol && Math.abs(len(s[1]) - len(s[3])) <= tol
}
