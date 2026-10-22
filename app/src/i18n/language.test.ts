import { describe, expect, it, beforeEach } from 'vitest'
import {
  SYSTEM_LANGUAGE,
  getLanguageSetting,
  resolveLocale,
  setLanguageSetting,
  subscribe,
} from './language'
import { PSEUDO_LOCALE } from './locales'

describe('resolveLocale', () => {
  const shipped = ['en', 'ja'] as const

  it('an explicit shipped locale wins over the system list', () => {
    expect(resolveLocale('ja', ['en-US'], { debugMode: false, shipped })).toBe('ja')
    expect(resolveLocale('en', ['ja-JP'], { debugMode: false, shipped })).toBe('en')
  })

  it('system walks the preferred list and matches by primary language', () => {
    expect(resolveLocale(SYSTEM_LANGUAGE, ['fr-FR', 'ja-JP', 'en'], { debugMode: false, shipped })).toBe('ja')
    expect(resolveLocale(SYSTEM_LANGUAGE, ['JA'], { debugMode: false, shipped })).toBe('ja')
    expect(resolveLocale(SYSTEM_LANGUAGE, ['en-GB'], { debugMode: false, shipped })).toBe('en')
  })

  it('system falls back to English when nothing matches or the list is empty', () => {
    expect(resolveLocale(SYSTEM_LANGUAGE, ['fr-FR', 'de'], { debugMode: false, shipped })).toBe('en')
    expect(resolveLocale(SYSTEM_LANGUAGE, [], { debugMode: false, shipped })).toBe('en')
  })

  it('an explicit locale that is no longer shipped resolves as system', () => {
    expect(resolveLocale('ja', ['en'], { debugMode: false, shipped: ['en'] })).toBe('en')
  })

  it('the pseudo-locale is honored only in debug mode', () => {
    expect(resolveLocale(PSEUDO_LOCALE, ['ja-JP'], { debugMode: true, shipped })).toBe(PSEUDO_LOCALE)
    // Off: a stale persisted pseudo choice must never strand a user in the
    // bracketed UI — it behaves as 'system'.
    expect(resolveLocale(PSEUDO_LOCALE, ['ja-JP'], { debugMode: false, shipped })).toBe('ja')
  })
})

describe('language setting store', () => {
  beforeEach(() => {
    setLanguageSetting(SYSTEM_LANGUAGE)
  })

  it('defaults to system', () => {
    expect(getLanguageSetting()).toBe(SYSTEM_LANGUAGE)
  })

  it('persists under hew.settings.language and notifies subscribers', () => {
    const seen: string[] = []
    const off = subscribe((s) => seen.push(s))
    setLanguageSetting('ja')
    expect(getLanguageSetting()).toBe('ja')
    expect(localStorage.getItem('hew.settings.language')).toBe('ja')
    expect(seen).toEqual(['ja'])
    off()
    setLanguageSetting(SYSTEM_LANGUAGE)
    expect(seen).toEqual(['ja'])
  })
})
