import { describe, expect, it } from 'vitest'
import { wantsSilhouettePass } from './printPass'

describe('wantsSilhouettePass', () => {
  it('runs for line art in Shaded and X-ray', () => {
    expect(wantsSilhouettePass('lineart', 'shaded')).toBe(true)
    expect(wantsSilhouettePass('lineart', 'xray')).toBe(true)
  })

  it('skips Wireframe, which draws no faces', () => {
    expect(wantsSilhouettePass('lineart', 'wireframe')).toBe(false)
  })

  it('is for line art only', () => {
    expect(wantsSilhouettePass('shaded', 'shaded')).toBe(false)
  })
})
