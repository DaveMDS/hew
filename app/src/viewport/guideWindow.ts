/**
 * guideWindow — which stretch of an (infinite) construction-guide line the
 * viewport actually draws.
 *
 * A guide is mathematically infinite, but a fixed ±50 m segment is a
 * rendering hazard at the scale people model at: its endpoints project
 * thousands of screen-heights away, and the rasterizer's depth interpolation
 * along that span is too noisy for the `polygonOffset` that is supposed to
 * keep a guide in front of the face it lies on (depthPolicy.ts spells out the
 * same precondition for the origin axes, whose companion is
 * `clampOriginAxes`). A guide in the plane of a 2 cm wall then vanishes and
 * returns as the camera orbits.
 *
 * So the drawn segment follows the view: centred on the point of the line
 * nearest the focus the camera is looking at, a couple of screen-widths each
 * way. Recomputing it every frame would rewrite the dash phase and buffers
 * constantly, so the window is quantised — its half-length snaps up to a power
 * of two with headroom, and the window only moves once the view would reach
 * past its end — `windowFor` returns the previous window while that holds.
 * Dash phase is the line parameter itself, so a recentre never shifts dashes.
 */

/** A drawn stretch of a guide line, as parameters along its unit direction
 *  measured from the guide's origin: the segment is `t0 … t1`. */
export interface GuideWindow {
  /** Centre parameter. */
  readonly center: number
  /** Half-length. */
  readonly half: number
}

/** Headroom the half-length keeps over what the view needs, so the window
 *  survives some focus drift and a small dolly before it must be rebuilt. */
const HEADROOM = 1.5

/** Smallest half-length ever drawn (metres): keeps a degenerate zoom from
 *  collapsing the segment to nothing. */
const MIN_HALF = 1e-3

/** Round up to a power of two, so the half-length is stable under the small
 *  zoom changes of an ordinary dolly. */
function ceilPow2(x: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(x, MIN_HALF))))
}

/**
 * The window to draw for a guide whose line is nearest the focus at
 * parameter `focusT`, given the half-length `needed` the view calls for
 * either side of the focus. Returns `prev` itself (same object) while it
 * still serves: it reaches `needed` past the focus on both sides and is not
 * more than twice the size a fresh window would be.
 */
export function windowFor(focusT: number, needed: number, prev: GuideWindow | null): GuideWindow {
  const want = ceilPow2(needed * HEADROOM)
  if (prev !== null && prev.half - Math.abs(focusT - prev.center) >= needed && prev.half <= want * 2) {
    return prev
  }
  return { center: focusT, half: want }
}

type V3 = readonly [number, number, number]

/** Floor on sin(angle between a guide and the view direction) when scaling its
 *  reach, so a guide pointing straight at the camera is capped at 10× rather
 *  than infinite. */
const MIN_VIEW_SIN = 0.1

/** Cap on the perspective depth scaling of a guide's reach. */
const MAX_DEPTH_SCALE = 20

/**
 * Half-length a guide needs either side of its point nearest the focus to
 * cross the screen. `base` is what a guide square-on to the view, at the
 * focus's depth, needs (a couple of viewport lengths). Two things stretch it:
 * a shallow angle to the view direction (`dir`, unit) — the line foreshortens
 * to `sin` of its length on screen — and, in perspective, lying deeper than
 * the focus, where one screen covers more world. `dirAlong` is the guide's
 * unit direction, `nearest` its point nearest the focus, `focusDepth` the
 * focus's distance along `dir` from `eye`.
 */
export function guideReach(
  base: number,
  dirAlong: V3,
  nearest: V3,
  view: { eye: V3; dir: V3; focusDepth: number; perspective: boolean },
): number {
  const [dx, dy, dz] = dirAlong
  const [vx, vy, vz] = view.dir
  const sin = Math.hypot(dy * vz - dz * vy, dz * vx - dx * vz, dx * vy - dy * vx)
  let reach = base / Math.max(sin, MIN_VIEW_SIN)
  if (view.perspective && view.focusDepth > 1e-9) {
    const depth =
      (nearest[0] - view.eye[0]) * vx + (nearest[1] - view.eye[1]) * vy + (nearest[2] - view.eye[2]) * vz
    reach *= Math.min(Math.max(depth / view.focusDepth, 1), MAX_DEPTH_SCALE)
  }
  return reach
}
