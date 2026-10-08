/**
 * flyNavigation — the pure integrator behind Fly (docs/design/fly-navigation.md
 * §3–§6): WASD/QE flight through a model in perspective, engaged by holding
 * the right mouse button under any tool (§3.1) or latched on from
 * Camera ▸ Fly for trackpads (§10). No three.js or DOM imports — fully
 * testable in Node/vitest, mirroring `cameraWalkMath.ts`'s split between
 * pure math and the thin Viewport wiring that drives it.
 *
 * Conventions match `cameraWalkMath.ts`: +Z is up, yaw is the compass angle
 * in the XY plane from +X (counterclockwise from above), pitch is the angle
 * above horizontal. Speeds are meters per second; times are milliseconds.
 *
 * The feel (§3.4) is the Counter-Strike spectator's: the velocity approaches
 * the target velocity exponentially — a short time constant to accelerate, a
 * slightly longer one to stop — so a tap nudges, a hold glides, and a release
 * settles instead of snapping. Motion is integrated per frame by wall-clock
 * delta time, clamped so a stalled frame never teleports the camera.
 */

import { forwardFromYawPitch, horizontalBasis, type V3 } from '../tools/cameraWalkMath'

/** The six movement intents. Arrow keys alias the WASD cluster (§3.3). */
export type FlyKey = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'

/** Default base speed (§6): a brisk walk — a room crosses in a couple of
 * seconds. A session value, never saved with the document. */
export const FLY_DEFAULT_SPEED_MPS = 2
/** Base-speed clamp (§6): a drawer interior to a site plan. */
export const FLY_MIN_SPEED_MPS = 0.05
export const FLY_MAX_SPEED_MPS = 200
/** Each wheel notch scales the base speed by this (§6): eight notches for a
 * 6× change, fine enough to tune. */
export const FLY_WHEEL_STEP = 1.25
/** Wheel pixels per notch. Chrome reports 100 px for one mouse-wheel click;
 * OrbitControls' own dolly uses the same 0.01/px normalization, so a notch
 * of speed and a notch of zoom read the same wheel the same way. Trackpad
 * pinches arrive as a stream of small ctrl+wheel deltas in Chromium and
 * Firefox (`speedAfterWheel`) and as WebKit gesture `scale` ratios
 * (`speedAfterScale`); both land on the same ladder continuously. */
export const FLY_WHEEL_PX_PER_NOTCH = 100
/** A single wheel event never jumps more than this many notches — a page-
 * mode or runaway-momentum delta can't fling the speed across the ladder. */
export const FLY_WHEEL_MAX_NOTCHES_PER_EVENT = 3
/** Latched flight on a trackpad (§10): a two-finger scroll looks around at
 * this multiple of the mouse-look sensitivity (`LOOK_AROUND_RAD_PER_PIXEL`).
 * Scroll deltas arrive in roughly finger-travel pixels, so 1 makes a swipe
 * across the trackpad turn about as far as the same drag with a mouse. */
export const FLY_SCROLL_LOOK_GAIN = 1
/** Sprint multiplier while Shift is held (§6). */
export const FLY_SPRINT_FACTOR = 4
/** Exponential approach time constants (§6): accelerate / decelerate. */
export const FLY_ACCEL_TAU_MS = 80
export const FLY_DECEL_TAU_MS = 120
/** Delta-time clamp (§6, amended in §10): a hitch moves the eye by at most a
 * tenth of a second of flight. 100 ms rather than the §6 table's 50 ms so a
 * heavy model rendering at 10–20 fps still flies at full speed — with the
 * clamp below the frame time, every frame is treated as a hitch and flight
 * slows in proportion. */
export const FLY_MAX_DT_MS = 100
/** Below this speed with no key held the glide is over — snap to rest so
 * the frame loop can stop instead of chasing an asymptote forever. */
export const FLY_REST_SPEED_MPS = 1e-3

/**
 * Physical-position key mapping (§3.3): `KeyboardEvent.code`, not the
 * letter, so AZERTY and Dvorak users get the same cluster under the left
 * hand. Arrows alias WASD. Anything else is not a fly key.
 */
export function flyKeyForCode(code: string): FlyKey | null {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      return 'forward'
    case 'KeyS':
    case 'ArrowDown':
      return 'back'
    case 'KeyA':
    case 'ArrowLeft':
      return 'left'
    case 'KeyD':
    case 'ArrowRight':
      return 'right'
    case 'KeyE':
      return 'up'
    case 'KeyQ':
      return 'down'
    default:
      return null
  }
}

/**
 * The world-space velocity the held keys ask for (§3.3): W/S along the
 * VIEW direction (pitch included), A/D along the horizontal right vector,
 * E/Q along world Z regardless of pitch. Opposing keys cancel; the summed
 * direction is normalized so W+D is no faster than W. Returns zero when
 * nothing is held or everything cancels.
 */
export function targetVelocity(
  held: ReadonlySet<FlyKey>,
  sprint: boolean,
  baseSpeedMps: number,
  yawRad: number,
  pitchRad: number,
): V3 {
  if (held.size === 0) return [0, 0, 0]
  const fwd = forwardFromYawPitch(yawRad, pitchRad)
  const { right } = horizontalBasis(yawRad)
  const f = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0)
  const r = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)
  const u = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0)
  const dir: V3 = [
    f * fwd[0] + r * right[0],
    f * fwd[1] + r * right[1],
    f * fwd[2] + r * right[2] + u,
  ]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-9) return [0, 0, 0]
  const speed = baseSpeedMps * (sprint ? FLY_SPRINT_FACTOR : 1)
  return [(dir[0] / len) * speed, (dir[1] / len) * speed, (dir[2] / len) * speed]
}

/**
 * One exponential step of `velocity` toward `target` over `dtMs` (§3.4):
 * `v += (target − v)·(1 − e^(−dt/τ))`, with τ = `FLY_ACCEL_TAU_MS` while the
 * target is faster than the current speed and `FLY_DECEL_TAU_MS` otherwise
 * (so letting go of a key coasts a touch longer than pressing one ramps
 * up). Pure; the caller clamps `dtMs` first.
 */
export function approachVelocity(velocity: V3, target: V3, dtMs: number): V3 {
  const vLen = Math.hypot(velocity[0], velocity[1], velocity[2])
  const tLen = Math.hypot(target[0], target[1], target[2])
  const tau = tLen > vLen ? FLY_ACCEL_TAU_MS : FLY_DECEL_TAU_MS
  const k = 1 - Math.exp(-dtMs / tau)
  return [
    velocity[0] + (target[0] - velocity[0]) * k,
    velocity[1] + (target[1] - velocity[1]) * k,
    velocity[2] + (target[2] - velocity[2]) * k,
  ]
}

/**
 * The base speed after one wheel event (§3.3, §6): wheel UP (`deltaY < 0`,
 * Unreal's "faster" direction) multiplies by `FLY_WHEEL_STEP` per notch,
 * wheel down divides, continuously by pixel distance so a trackpad's
 * fine-grained stream lands on the same ladder as a clicky mouse wheel.
 * `deltaMode` 1 (lines) and 2 (pages) are normalized to pixels the way
 * OrbitControls does. Clamped to `[FLY_MIN_SPEED_MPS, FLY_MAX_SPEED_MPS]`.
 */
export function speedAfterWheel(baseSpeedMps: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
  const raw = -px / FLY_WHEEL_PX_PER_NOTCH
  const notches = Math.max(-FLY_WHEEL_MAX_NOTCHES_PER_EVENT, Math.min(FLY_WHEEL_MAX_NOTCHES_PER_EVENT, raw))
  const next = baseSpeedMps * Math.pow(FLY_WHEEL_STEP, notches)
  return Math.min(FLY_MAX_SPEED_MPS, Math.max(FLY_MIN_SPEED_MPS, next))
}

/**
 * The base speed after one WebKit pinch step (§10): `scaleRatio` is this
 * gesturechange event's cumulative `scale` divided by the previous one, so
 * spreading the fingers 2× over a gesture doubles the speed, pinching to
 * half halves it — the ladder reads the same as the wheel's. Non-finite or
 * non-positive ratios are ignored. Clamped like the wheel.
 */
export function speedAfterScale(baseSpeedMps: number, scaleRatio: number): number {
  if (!Number.isFinite(scaleRatio) || scaleRatio <= 0) return baseSpeedMps
  const capped = Math.max(1 / 4, Math.min(4, scaleRatio))
  return Math.min(FLY_MAX_SPEED_MPS, Math.max(FLY_MIN_SPEED_MPS, baseSpeedMps * capped))
}

/**
 * The Measurements-box readout while flying (§3.4): the speed in the
 * session's length system — `2 m/s` / `6.6 ft/s`. Display-only; typing a
 * speed is deferred (§9).
 */
export function formatFlySpeed(mps: number, system: 'metric' | 'imperial'): string {
  if (system === 'imperial') {
    return `${trimDecimals((mps / 0.3048).toFixed(1))} ft/s`
  }
  return `${trimDecimals(mps.toFixed(2))} m/s`
}

function trimDecimals(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/**
 * The held-key set, base speed, and velocity state of one flight (§5). The
 * Viewport owns exactly one for its lifetime: `baseSpeed` is the session
 * value the wheel adjusts and persists across engagements; keys and
 * velocity are cleared on every release, blur, or latch-off so nothing can
 * stick.
 */
export class FlyIntegrator {
  private readonly held = new Set<FlyKey>()
  private velocity: V3 = [0, 0, 0]
  private sprint = false
  baseSpeedMps = FLY_DEFAULT_SPEED_MPS

  press(key: FlyKey): void {
    this.held.add(key)
  }

  release(key: FlyKey): void {
    this.held.delete(key)
  }

  setSprint(on: boolean): void {
    this.sprint = on
  }

  isHeld(key: FlyKey): boolean {
    return this.held.has(key)
  }

  /** Drop every held key and the sprint (a blur, a release) — the glide
   * finishes on its own through `step` until the velocity rests. */
  clearKeys(): void {
    this.held.clear()
    this.sprint = false
  }

  /** Full stop: keys, sprint, AND velocity. */
  stop(): void {
    this.clearKeys()
    this.velocity = [0, 0, 0]
  }

  /** Whether the next `step` would still move the eye — the frame loop's
   * "keep running" predicate (§3.4): a key held, or a glide not yet at
   * rest. */
  get isMoving(): boolean {
    return this.held.size > 0 || Math.hypot(...this.velocity) > FLY_REST_SPEED_MPS
  }

  /** Apply one wheel event to the base speed and return the new value. */
  wheel(deltaY: number, deltaMode = 0): number {
    this.baseSpeedMps = speedAfterWheel(this.baseSpeedMps, deltaY, deltaMode)
    return this.baseSpeedMps
  }

  /** Apply one WebKit pinch step (a `scale` ratio) and return the new value. */
  scaleSpeed(scaleRatio: number): number {
    this.baseSpeedMps = speedAfterScale(this.baseSpeedMps, scaleRatio)
    return this.baseSpeedMps
  }

  /**
   * Advance one frame (§3.4): clamp `dtMs`, move the velocity toward the
   * held keys' target for the given look direction, and return the eye
   * displacement in meters. A velocity that has coasted below
   * `FLY_REST_SPEED_MPS` with nothing held snaps to zero so `isMoving`
   * turns false and the loop can stop.
   */
  step(dtMs: number, yawRad: number, pitchRad: number): V3 {
    const dt = Math.min(FLY_MAX_DT_MS, Math.max(0, dtMs))
    const target = targetVelocity(this.held, this.sprint, this.baseSpeedMps, yawRad, pitchRad)
    this.velocity = approachVelocity(this.velocity, target, dt)
    if (this.held.size === 0 && Math.hypot(...this.velocity) < FLY_REST_SPEED_MPS) {
      this.velocity = [0, 0, 0]
    }
    const s = dt / 1000
    return [this.velocity[0] * s, this.velocity[1] * s, this.velocity[2] * s]
  }
}
