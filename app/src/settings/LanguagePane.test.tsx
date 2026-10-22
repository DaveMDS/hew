import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { LanguagePane } from './LanguagePane'
import { SYSTEM_LANGUAGE, getLanguageSetting, setLanguageSetting } from '../i18n/language'
import { setDebugMode } from './debugMode'
import { activateLocale } from '../i18n/activate'

function renderPane() {
  return render(
    <I18nProvider i18n={i18n}>
      <LanguagePane />
    </I18nProvider>,
  )
}

describe('LanguagePane', () => {
  beforeEach(async () => {
    await activateLocale('en')
    setLanguageSetting(SYSTEM_LANGUAGE)
    setDebugMode(false)
  })
  afterEach(() => {
    setDebugMode(false)
    setLanguageSetting(SYSTEM_LANGUAGE)
  })

  it('offers System default plus the shipped languages, and no pseudo-locale', () => {
    renderPane()
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels[0]).toBe('System default')
    expect(labels).toContain('English')
    expect(labels.some((l) => l?.startsWith('Pseudo'))).toBe(false)
  })

  it('offers the pseudo-locale only while Debug Mode is on', () => {
    setDebugMode(true)
    renderPane()
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels.some((l) => l?.startsWith('Pseudo'))).toBe(true)
  })

  it('persists a choice through the language singleton', () => {
    renderPane()
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'en' } })
    expect(getLanguageSetting()).toBe('en')
    expect(select.value).toBe('en')
  })
})
