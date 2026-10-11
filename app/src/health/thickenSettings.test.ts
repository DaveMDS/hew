import { beforeEach, describe, expect, it } from 'vitest'
import { defaultThicknessText, getThickenChoice, parseThickness, rememberThickenChoice, resetThickenChoice } from './thickenSettings'

describe('parseThickness', () => {
  it('maps the sides: In front = +d, Behind = -d, Centered = centered', () => {
    expect(parseThickness('2cm', 'front')).toEqual({ ok: true, distance: 0.02, centered: false })
    expect(parseThickness('2cm', 'behind')).toEqual({ ok: true, distance: -0.02, centered: false })
    expect(parseThickness('2cm', 'centered')).toEqual({ ok: true, distance: 0.02, centered: true })
  })

  it('uses the VCB length grammar (explicit units, inches)', () => {
    const mm = parseThickness('25 mm', 'front')
    expect(mm.ok && mm.distance).toBeCloseTo(0.025)
    const inch = parseThickness('1"', 'front')
    expect(inch.ok && inch.distance).toBeCloseTo(0.0254)
  })

  it('rejects zero, negatives, empty and nonsense inline', () => {
    for (const text of ['0', '0cm', '', '   ', 'abc', '-1cm']) {
      const r = parseThickness(text, 'front')
      expect(r.ok).toBe(false)
    }
  })
})

describe('default thickness', () => {
  it('is 3 mm in metric display units and parses', () => {
    expect(defaultThicknessText()).toBe('3 mm')
    const r = parseThickness(defaultThicknessText(), 'front')
    expect(r.ok && r.distance).toBeCloseTo(0.003)
  })

  it('error text is the plain copy', () => {
    expect(parseThickness('abc', 'front')).toEqual({ ok: false, error: 'Enter a thickness, such as 3 mm.' })
  })

  it('1/8" is a valid thickness in imperial', () => {
    const r = parseThickness('1/8"', 'front')
    expect(r.ok && r.distance).toBeCloseTo(0.003175)
  })
})

describe('remembered choice', () => {
  beforeEach(resetThickenChoice)
  it('defaults to In front and remembers the last text + side', () => {
    expect(getThickenChoice().side).toBe('front')
    rememberThickenChoice({ text: '5cm', side: 'centered' })
    expect(getThickenChoice()).toEqual({ text: '5cm', side: 'centered' })
  })
})
