/**
 * LanguagePane — the "Language" settings pane.
 *
 * One pop-up bound to the language singleton (app/src/i18n/language.ts):
 * System default, then every shipped language named in its own script, and
 * — only while Debug Mode is on — the pseudo-locale (docs/LOCALIZATION.md).
 * Changing it re-renders every open window in the new language at once;
 * nothing reloads.
 *
 * Laid out on the shared macOS-HIG form grid (SettingsForm.tsx). Reusable
 * from both the standalone Settings window (Tauri) and the in-app modal
 * fallback (web). Changes apply instantly — no OK/Cancel.
 */

import { useEffect, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import {
  SYSTEM_LANGUAGE,
  getLanguageSetting,
  setLanguageSetting,
  subscribe,
  type LanguageSetting,
} from '../i18n/language'
import { languageOptions } from '../i18n/languageOptions'
import { getDebugMode, subscribe as subscribeDebugMode } from './debugMode'
import {
  SettingsForm,
  SettingsRow,
  SettingsNote,
  settingsSelectStyle,
  settingsOptionStyle,
} from './SettingsForm'

export function LanguagePane() {
  const { t } = useLingui()
  const [setting, setSetting] = useState<LanguageSetting>(() => getLanguageSetting())
  const [debugMode, setDebugMode] = useState<boolean>(() => getDebugMode())

  // Keep in sync with external changes (the other window, or another
  // subscriber in this same window).
  useEffect(() => subscribe(setSetting), [])
  useEffect(() => subscribeDebugMode(setDebugMode), [])

  const options = languageOptions({ systemLabel: t`System default`, debugMode })

  return (
    <SettingsForm>
      <SettingsRow label={t`Language`} htmlFor="settings-language">
        <select
          id="settings-language"
          value={options.some((o) => o.value === setting) ? setting : SYSTEM_LANGUAGE}
          onChange={(e) => setLanguageSetting(e.target.value as LanguageSetting)}
          style={settingsSelectStyle}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} style={settingsOptionStyle}>
              {opt.label}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsNote>
        {t`System default follows your OS language, when Hew is available in it.`}
      </SettingsNote>
    </SettingsForm>
  )
}
