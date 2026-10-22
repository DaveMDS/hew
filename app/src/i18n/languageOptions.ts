/**
 * The Language pop-up's option list, shared by the macOS Settings pane and
 * the Windows Fluent settings page so both offer the same choices in the
 * same order: System default, the shipped locales in their own names, and
 * the pseudo-locale only while Debug Mode is on.
 */

import { LOCALE_NAMES, PSEUDO_LOCALE, SHIPPED_LOCALES } from './locales'
import { SYSTEM_LANGUAGE, type LanguageSetting } from './language'

export interface LanguageOption {
  value: LanguageSetting
  label: string
}

export function languageOptions(opts: { systemLabel: string; debugMode: boolean }): LanguageOption[] {
  const list: LanguageOption[] = [{ value: SYSTEM_LANGUAGE, label: opts.systemLabel }]
  for (const locale of SHIPPED_LOCALES) list.push({ value: locale, label: LOCALE_NAMES[locale] })
  if (opts.debugMode) list.push({ value: PSEUDO_LOCALE, label: LOCALE_NAMES[PSEUDO_LOCALE] })
  return list
}
