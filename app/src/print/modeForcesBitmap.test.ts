import { describe, expect, it } from 'vitest'
import { modeForcesBitmap } from './usePrintController'
import type { RenderMode } from '../viewport/SceneRenderer'

describe('modeForcesBitmap (Line art falls back to a bitmap)', () => {
  const api = (mode: RenderMode) => ({ getRenderMode: () => mode })

  it('triggers for X-ray', () => {
    expect(modeForcesBitmap(api('xray'))).toBe(true)
  })
  it('triggers for Wireframe', () => {
    expect(modeForcesBitmap(api('wireframe'))).toBe(true)
  })
  it('does not trigger in Shaded', () => {
    expect(modeForcesBitmap(api('shaded'))).toBe(false)
  })
  it('falls through when the api has no getRenderMode', () => {
    expect(modeForcesBitmap({})).toBe(false)
  })
})
