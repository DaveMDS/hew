import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { activateLocale } from './activate'
import { PSEUDO_LOCALE, type Locale } from './locales'

// Loads the real catalogs through @lingui/vite-plugin, so this also proves
// the .po → runtime pipeline the app uses, not a hand-built message table.
// Messages are keyed by a generated id, so lookups go through the `msg`
// macro exactly as app code does — `i18n._('English text')` would only
// echo the string back.
const SYSTEM_DEFAULT = msg`System default`

describe('activateLocale', () => {
  it('activates the English catalog and sets the document language', async () => {
    await activateLocale('en')
    expect(i18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(i18n._(SYSTEM_DEFAULT)).toBe('System default')
  })

  it('the pseudo-locale is generated from the English catalog at compile time', async () => {
    await activateLocale(PSEUDO_LOCALE)
    expect(i18n.locale).toBe(PSEUDO_LOCALE)
    const s = i18n._(SYSTEM_DEFAULT)
    expect(s).not.toBe('System default')
    expect(s.startsWith('⟦ ')).toBe(true)
    expect(s.endsWith(' ⟧')).toBe(true)
    await activateLocale('en')
  })

  it('an unshipped catalog with empty entries falls back to English text', async () => {
    await activateLocale('ja')
    expect(i18n.locale).toBe('ja')
    expect(i18n._(SYSTEM_DEFAULT)).toBe('System default')
    await activateLocale('en')
  })
})

describe('activation ordering', () => {
  it('a later request wins over a slower earlier one', async () => {
    // Start a pseudo-locale activation (its catalog is not loaded yet in
    // this suite's state only on the first call; force the race by not
    // awaiting) and immediately request English: English must end up active
    // even though the pseudo load resolves afterward.
    const slow = activateLocale(PSEUDO_LOCALE)
    const fast = activateLocale('en')
    await Promise.all([slow, fast])
    expect(i18n.locale).toBe('en')
  })

  it('English is active even when the requested catalog cannot load', async () => {
    // 'ja' exists; simulate a missing one by casting an unknown tag.
    await activateLocale('zz' as unknown as Locale)
    expect(i18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
