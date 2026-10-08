import { describe, expect, it } from 'vitest'
import {
  FLY_ACCEL_TAU_MS,
  FLY_DECEL_TAU_MS,
  FLY_DEFAULT_SPEED_MPS,
  FLY_MAX_DT_MS,
  FLY_MAX_SPEED_MPS,
  FLY_MIN_SPEED_MPS,
  FLY_SPRINT_FACTOR,
  FLY_WHEEL_STEP,
  FlyIntegrator,
  approachVelocity,
  flyKeyForCode,
  formatFlySpeed,
  speedAfterScale,
  speedAfterWheel,
  targetVelocity,
  type FlyKey,
} from './flyNavigation'
import { forwardFromYawPitch, horizontalBasis } from '../tools/cameraWalkMath'

const len = (v: readonly number[]) => Math.hypot(...v)
const held = (...keys: FlyKey[]) => new Set<FlyKey>(keys)

describe('flyKeyForCode (design §3.3 — physical keys, arrows alias WASD)', () => {
  it('maps the WASD/QE cluster by KeyboardEvent.code', () => {
    expect(flyKeyForCode('KeyW')).toBe('forward')
    expect(flyKeyForCode('KeyS')).toBe('back')
    expect(flyKeyForCode('KeyA')).toBe('left')
    expect(flyKeyForCode('KeyD')).toBe('right')
    expect(flyKeyForCode('KeyE')).toBe('up')
    expect(flyKeyForCode('KeyQ')).toBe('down')
  })

  it('aliases the arrow keys: up/down = W/S, left/right = A/D', () => {
    expect(flyKeyForCode('ArrowUp')).toBe('forward')
    expect(flyKeyForCode('ArrowDown')).toBe('back')
    expect(flyKeyForCode('ArrowLeft')).toBe('left')
    expect(flyKeyForCode('ArrowRight')).toBe('right')
  })

  it('returns null for everything else (Space, Escape, letters outside the cluster)', () => {
    expect(flyKeyForCode('Space')).toBeNull()
    expect(flyKeyForCode('Escape')).toBeNull()
    expect(flyKeyForCode('KeyR')).toBeNull()
    expect(flyKeyForCode('ShiftLeft')).toBeNull()
  })
})

describe('targetVelocity (design §3.3)', () => {
  const yaw = 0.7
  const pitch = 0.4

  it('is zero with nothing held', () => {
    expect(targetVelocity(held(), false, 2, yaw, pitch)).toEqual([0, 0, 0])
  })

  it('forward follows the VIEW direction, pitch included', () => {
    const v = targetVelocity(held('forward'), false, 2, yaw, pitch)
    const f = forwardFromYawPitch(yaw, pitch)
    expect(v[0]).toBeCloseTo(2 * f[0], 9)
    expect(v[1]).toBeCloseTo(2 * f[1], 9)
    expect(v[2]).toBeCloseTo(2 * f[2], 9)
    expect(v[2]).toBeGreaterThan(0)
  })

  it('back is the exact opposite of forward', () => {
    const f = targetVelocity(held('forward'), false, 2, yaw, pitch)
    const b = targetVelocity(held('back'), false, 2, yaw, pitch)
    expect(b[0]).toBeCloseTo(-f[0], 9)
    expect(b[1]).toBeCloseTo(-f[1], 9)
    expect(b[2]).toBeCloseTo(-f[2], 9)
  })

  it('strafe is horizontal, along the yaw basis right vector, regardless of pitch', () => {
    const v = targetVelocity(held('right'), false, 3, yaw, pitch)
    const { right } = horizontalBasis(yaw)
    expect(v[0]).toBeCloseTo(3 * right[0], 9)
    expect(v[1]).toBeCloseTo(3 * right[1], 9)
    expect(v[2]).toBe(0)
  })

  it('up/down are along world Z regardless of pitch', () => {
    expect(targetVelocity(held('up'), false, 2, yaw, -1.2)).toEqual([0, 0, 2])
    expect(targetVelocity(held('down'), false, 2, yaw, 1.2)).toEqual([0, 0, -2])
  })

  it('opposing keys cancel', () => {
    expect(targetVelocity(held('forward', 'back'), false, 2, yaw, pitch)).toEqual([0, 0, 0])
    expect(targetVelocity(held('left', 'right'), false, 2, yaw, pitch)).toEqual([0, 0, 0])
    expect(targetVelocity(held('up', 'down'), false, 2, yaw, pitch)).toEqual([0, 0, 0])
  })

  it('diagonals are normalized: W+D is exactly as fast as W', () => {
    const w = targetVelocity(held('forward'), false, 2, yaw, 0)
    const wd = targetVelocity(held('forward', 'right'), false, 2, yaw, 0)
    expect(len(wd)).toBeCloseTo(len(w), 9)
    expect(len(wd)).toBeCloseTo(2, 9)
  })

  it('Shift sprints at FLY_SPRINT_FACTOR × the base speed', () => {
    const v = targetVelocity(held('forward'), true, 2, yaw, 0)
    expect(len(v)).toBeCloseTo(2 * FLY_SPRINT_FACTOR, 9)
  })
})

describe('approachVelocity (design §3.4 — exponential approach)', () => {
  it('moves toward the target without overshooting, reaching it only asymptotically', () => {
    let v: [number, number, number] = [0, 0, 0]
    const target: [number, number, number] = [2, 0, 0]
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      v = approachVelocity(v, target, 16)
      samples.push(v[0])
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThan(samples[i - 1])
    expect(samples[samples.length - 1]).toBeLessThan(2)
    expect(samples[samples.length - 1]).toBeGreaterThan(1.9)
  })

  it('uses the accelerate time constant when speeding up and the decelerate one when slowing down', () => {
    // After one step of exactly τ the gap closes by (1 − 1/e).
    const up = approachVelocity([0, 0, 0], [1, 0, 0], FLY_ACCEL_TAU_MS)
    expect(up[0]).toBeCloseTo(1 - Math.exp(-1), 9)
    const down = approachVelocity([1, 0, 0], [0, 0, 0], FLY_DECEL_TAU_MS)
    expect(down[0]).toBeCloseTo(Math.exp(-1), 9)
    // Decelerating over the ACCEL constant would have closed less of the gap
    // than accelerating does over it — the two constants really differ.
    const downOverAccelTau = approachVelocity([1, 0, 0], [0, 0, 0], FLY_ACCEL_TAU_MS)
    expect(downOverAccelTau[0]).toBeGreaterThan(Math.exp(-1))
  })

  it('a zero dt leaves the velocity untouched', () => {
    expect(approachVelocity([0.5, 0.25, 0], [2, 0, 0], 0)).toEqual([0.5, 0.25, 0])
  })
})

describe('speedAfterWheel (design §3.3/§6 — the wheel speed ladder)', () => {
  it('one 100 px notch up multiplies by FLY_WHEEL_STEP, one notch down divides', () => {
    expect(speedAfterWheel(2, -100)).toBeCloseTo(2 * FLY_WHEEL_STEP, 9)
    expect(speedAfterWheel(2, 100)).toBeCloseTo(2 / FLY_WHEEL_STEP, 9)
  })

  it('is continuous in pixel distance (half a notch is the square root of a step)', () => {
    expect(speedAfterWheel(2, -50)).toBeCloseTo(2 * Math.sqrt(FLY_WHEEL_STEP), 9)
  })

  it('normalizes line and page delta modes toward pixels', () => {
    expect(speedAfterWheel(2, -3, 1)).toBeGreaterThan(2)
    expect(speedAfterWheel(2, 3, 1)).toBeLessThan(2)
    expect(speedAfterWheel(2, -1, 2)).toBeGreaterThan(2)
  })

  it('caps a single event at a few notches, so a runaway delta cannot cross the ladder at once', () => {
    expect(speedAfterWheel(2, -100000)).toBeCloseTo(2 * Math.pow(FLY_WHEEL_STEP, 3), 9)
  })

  it('clamps to the session speed range', () => {
    let s = FLY_DEFAULT_SPEED_MPS
    for (let i = 0; i < 200; i++) s = speedAfterWheel(s, -100)
    expect(s).toBe(FLY_MAX_SPEED_MPS)
    for (let i = 0; i < 400; i++) s = speedAfterWheel(s, 100)
    expect(s).toBe(FLY_MIN_SPEED_MPS)
  })
})

describe('formatFlySpeed (design §3.4 — the Measurements-box readout)', () => {
  it('shows meters per second in metric, trimmed', () => {
    expect(formatFlySpeed(2, 'metric')).toBe('2 m/s')
    expect(formatFlySpeed(2.5, 'metric')).toBe('2.5 m/s')
    expect(formatFlySpeed(0.05, 'metric')).toBe('0.05 m/s')
  })

  it('shows feet per second in imperial, to a tenth', () => {
    expect(formatFlySpeed(0.3048, 'imperial')).toBe('1 ft/s')
    expect(formatFlySpeed(2, 'imperial')).toBe('6.6 ft/s')
  })
})

describe('FlyIntegrator (design §5 — the frame integrator)', () => {
  it('starts at the default base speed, at rest, with nothing held', () => {
    const f = new FlyIntegrator()
    expect(f.baseSpeedMps).toBe(FLY_DEFAULT_SPEED_MPS)
    expect(f.isMoving).toBe(false)
    expect(f.step(16, 0, 0)).toEqual([0, 0, 0])
  })

  it('a held forward key accelerates toward base speed along the view direction', () => {
    const f = new FlyIntegrator()
    f.press('forward')
    expect(f.isMoving).toBe(true)
    let total = 0
    for (let i = 0; i < 60; i++) total += f.step(16, 0, 0)[0]
    // 60 × 16 ms ≈ 0.96 s at (asymptotically) 2 m/s, minus the ramp-up.
    expect(total).toBeGreaterThan(1.5)
    expect(total).toBeLessThan(1.92)
    // Per-frame displacement at steady state: 2 m/s × 16 ms.
    const d = f.step(16, 0, 0)
    expect(d[0]).toBeCloseTo(2 * 0.016, 3)
    expect(d[1]).toBeCloseTo(0, 9)
    expect(d[2]).toBeCloseTo(0, 9)
  })

  it('releasing the key glides to rest, then isMoving turns false and the displacement is exactly zero', () => {
    const f = new FlyIntegrator()
    f.press('forward')
    for (let i = 0; i < 30; i++) f.step(16, 0, 0)
    f.release('forward')
    expect(f.isMoving).toBe(true)
    const first = f.step(16, 0, 0)[0]
    const second = f.step(16, 0, 0)[0]
    expect(first).toBeGreaterThan(0)
    expect(second).toBeLessThan(first)
    let frames = 0
    while (f.isMoving && frames < 200) {
      f.step(16, 0, 0)
      frames++
    }
    expect(f.isMoving).toBe(false)
    expect(frames).toBeLessThan(200)
    expect(f.step(16, 0, 0)).toEqual([0, 0, 0])
  })

  it('clamps a stalled frame to FLY_MAX_DT_MS so a hitch never teleports the eye', () => {
    const f = new FlyIntegrator()
    f.press('forward')
    for (let i = 0; i < 60; i++) f.step(16, 0, 0)
    const d = f.step(5000, 0, 0)
    expect(d[0]).toBeLessThanOrEqual(2 * (FLY_MAX_DT_MS / 1000) + 1e-9)
    expect(d[0]).toBeGreaterThan(2 * (FLY_MAX_DT_MS / 1000) * 0.9)
  })

  it('a negative dt is treated as zero', () => {
    const f = new FlyIntegrator()
    f.press('forward')
    expect(f.step(-16, 0, 0)).toEqual([0, 0, 0])
  })

  it('up moves along world Z even while pitched down, and the pitch argument does not change that', () => {
    const f = new FlyIntegrator()
    f.press('up')
    for (let i = 0; i < 60; i++) f.step(16, 1.1, -0.9)
    const d = f.step(16, 1.1, -0.9)
    expect(d[0]).toBeCloseTo(0, 9)
    expect(d[1]).toBeCloseTo(0, 9)
    expect(d[2]).toBeCloseTo(2 * 0.016, 3)
  })

  it('sprint quadruples the steady-state speed and the wheel scales the base', () => {
    const f = new FlyIntegrator()
    f.press('forward')
    f.setSprint(true)
    for (let i = 0; i < 80; i++) f.step(16, 0, 0)
    expect(f.step(16, 0, 0)[0]).toBeCloseTo(2 * FLY_SPRINT_FACTOR * 0.016, 3)
    f.setSprint(false)
    expect(f.wheel(-100)).toBeCloseTo(2 * FLY_WHEEL_STEP, 9)
    for (let i = 0; i < 80; i++) f.step(16, 0, 0)
    expect(f.step(16, 0, 0)[0]).toBeCloseTo(2 * FLY_WHEEL_STEP * 0.016, 3)
  })

  it('clearKeys drops the keys and sprint but lets the glide finish; stop halts everything at once', () => {
    const a = new FlyIntegrator()
    a.press('forward')
    a.setSprint(true)
    for (let i = 0; i < 30; i++) a.step(16, 0, 0)
    a.clearKeys()
    expect(a.isHeld('forward')).toBe(false)
    expect(a.step(16, 0, 0)[0]).toBeGreaterThan(0)

    const b = new FlyIntegrator()
    b.press('forward')
    for (let i = 0; i < 30; i++) b.step(16, 0, 0)
    b.stop()
    expect(b.isMoving).toBe(false)
    expect(b.step(16, 0, 0)).toEqual([0, 0, 0])
  })

  it('the base speed persists across stop (a session value, not a per-engagement one)', () => {
    const f = new FlyIntegrator()
    f.wheel(-100)
    f.wheel(-100)
    const s = f.baseSpeedMps
    f.press('forward')
    f.step(16, 0, 0)
    f.stop()
    expect(f.baseSpeedMps).toBe(s)
  })
})

describe('speedAfterScale (design §10 — WebKit pinch gestures)', () => {
  it('multiplies the base speed by the pinch ratio, so a 2× spread doubles the speed', () => {
    expect(speedAfterScale(2, 2)).toBeCloseTo(4, 9)
    expect(speedAfterScale(2, 0.5)).toBeCloseTo(1, 9)
    expect(speedAfterScale(2, 1)).toBe(2)
  })

  it('ignores non-finite or non-positive ratios and clamps to the speed range', () => {
    expect(speedAfterScale(2, NaN)).toBe(2)
    expect(speedAfterScale(2, 0)).toBe(2)
    expect(speedAfterScale(2, -1)).toBe(2)
    expect(speedAfterScale(FLY_MAX_SPEED_MPS, 2)).toBe(FLY_MAX_SPEED_MPS)
    expect(speedAfterScale(FLY_MIN_SPEED_MPS, 0.5)).toBe(FLY_MIN_SPEED_MPS)
  })

  it('caps a single step so one wild event cannot cross the ladder', () => {
    expect(speedAfterScale(2, 100)).toBeCloseTo(8, 9)
    expect(speedAfterScale(2, 0.001)).toBeCloseTo(0.5, 9)
  })

  it('FlyIntegrator.scaleSpeed applies it to the session base speed', () => {
    const f = new FlyIntegrator()
    expect(f.scaleSpeed(1.5)).toBeCloseTo(3, 9)
    expect(f.baseSpeedMps).toBeCloseTo(3, 9)
  })
})
