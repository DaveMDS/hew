/**
 * UnitsPane — the "Units" settings pane.
 *
 * Two-level system × format selector bound to the length-format
 * singleton (app/src/settings/units.ts):
 *   - A SYSTEM selector (Metric / Imperial).
 *   - A FORMAT selector whose options depend on the chosen system.
 * Changing system selects that system's default format (Meters for Metric,
 * Architectural for Imperial).
 *
 * Laid out on the shared macOS-HIG form grid (SettingsForm.tsx). Reusable
 * from both the standalone Settings window (Tauri) and the in-app modal
 * fallback (web). Changes apply instantly — no OK/Cancel.
 */

import { useEffect, useState } from 'react'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  getLengthUnit,
  setLengthUnit,
  getPrecision,
  setPrecision,
  precisionLabel,
  PRECISION_OPTIONS,
  subscribe,
  LENGTH_FORMAT_OPTIONS,
  LENGTH_FORMATS_BY_SYSTEM,
  LENGTH_SYSTEM_OF,
  DEFAULT_FORMAT_FOR_SYSTEM,
  type LengthFormat,
  type LengthSystem,
  type Precision,
} from './units'
import {
  SettingsForm,
  SettingsRow,
  SettingsSeparator,
  SettingsNote,
  settingsSelectStyle,
  settingsOptionStyle,
} from './SettingsForm'

const SYSTEM_OPTIONS: { value: LengthSystem; label: MessageDescriptor }[] = [
  { value: 'metric', label: msg`Metric` },
  { value: 'imperial', label: msg`Imperial` },
]

export function UnitsPane() {
  const { t, i18n } = useLingui()
  const [format, setFormat] = useState<LengthFormat>(() => getLengthUnit())

  // Keep in sync with external changes (the other window, or another
  // subscriber in this same window).
  const [, setTick] = useState(0)
  useEffect(
    () =>
      subscribe((next) => {
        setFormat(next)
        setTick((t) => t + 1) // precision changes notify with the same format
      }),
    [],
  )

  const system = LENGTH_SYSTEM_OF[format]
  const formatOptions = LENGTH_FORMATS_BY_SYSTEM[system]

  function handleSystemChange(next: LengthSystem): void {
    if (next === system) return
    setLengthUnit(DEFAULT_FORMAT_FOR_SYSTEM[next])
  }

  return (
    <SettingsForm>
      <SettingsRow label={t`System`} htmlFor="settings-units-system">
        <select
          id="settings-units-system"
          value={system}
          onChange={(e) => handleSystemChange(e.target.value as LengthSystem)}
          style={settingsSelectStyle}
        >
          {SYSTEM_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} style={settingsOptionStyle}>
              {i18n._(opt.label)}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow label={t`Format`} htmlFor="settings-units-format">
        <select
          id="settings-units-format"
          value={format}
          onChange={(e) => setLengthUnit(e.target.value as LengthFormat)}
          style={settingsSelectStyle}
        >
          {formatOptions.map((value) => {
            const opt = LENGTH_FORMAT_OPTIONS.find((o) => o.value === value)
            return (
              <option key={value} value={value} style={settingsOptionStyle}>
                {opt === undefined ? value : i18n._(opt.label)}
              </option>
            )
          })}
        </select>
      </SettingsRow>

      <SettingsRow label="Precision" htmlFor="settings-units-precision">
        <select
          id="settings-units-precision"
          value={String(getPrecision(format))}
          onChange={(e) => {
            const v = e.target.value
            setPrecision(v === 'exact' || v === 'foot' ? v : Number(v))
          }}
          style={settingsSelectStyle}
        >
          {PRECISION_OPTIONS[format].map((p: Precision) => (
            <option key={String(p)} value={String(p)} style={settingsOptionStyle}>
              {precisionLabel(format, p)}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsSeparator />

      <SettingsNote>
        <Trans>
          Controls how lengths are displayed (e.g. the Move tool's live measurement).
          Precision sets how far readouts are rounded: a number of decimals, or
          a fraction of an inch. A rounded readout is marked with ~, and Exact
          shows every digit a length needs. Each format remembers its own
          choice. Model geometry is always stored in meters internally.
        </Trans>
      </SettingsNote>
    </SettingsForm>
  )
}
