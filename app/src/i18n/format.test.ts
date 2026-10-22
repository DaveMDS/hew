import { describe, expect, it, afterEach } from 'vitest'
import { i18n } from '@lingui/core'
import { formatNumber, intlLocale } from './format'

describe('formatNumber', () => {
  afterEach(() => {
    i18n.load('en', {})
    i18n.activate('en')
  })

  it('uses the active locale separators', () => {
    i18n.load('en', {})
    i18n.activate('en')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    i18n.load('de', {})
    i18n.activate('de')
    expect(formatNumber(1234.5)).toBe('1.234,5')
  })

  it('fixed and maximum fraction digits, with grouping off', () => {
    i18n.load('en', {})
    i18n.activate('en')
    expect(formatNumber(2, { fractionDigits: 3 })).toBe('2.000')
    expect(formatNumber(2.123456, { maxFractionDigits: 2 })).toBe('2.12')
    expect(formatNumber(12345, { grouping: false })).toBe('12345')
  })

  it('the pseudo-locale and an unset locale format as English', () => {
    i18n.load('pseudo-LOCALE', {})
    i18n.activate('pseudo-LOCALE')
    expect(intlLocale()).toBe('en')
    expect(formatNumber(1234.5)).toBe('1,234.5')
  })
})
