/**
 * ViewPane — the "View" settings pane.
 *
 * How the viewport feels: zoom wheel speed, smooth camera moves, what shows
 * at the cursor, and where the Measurements box sits. Each control is bound
 * to a singleton in settings/view.ts; every default is today's behavior.
 *
 * Laid out on the shared macOS-HIG form grid (SettingsForm.tsx). Changes
 * apply instantly — no OK/Cancel.
 */

import type { CSSProperties } from 'react'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  getZoomWheelStop,
  setZoomWheelStop,
  subscribeZoomWheelStop,
  ZOOM_WHEEL_FACTORS,
  ZOOM_WHEEL_LABELS,
  getSmoothCamera,
  setSmoothCamera,
  subscribeSmoothCamera,
  getShowToolHints,
  setShowToolHints,
  subscribeShowToolHints,
  getShowToolPointer,
  setShowToolPointer,
  subscribeShowToolPointer,
  getMeasurementsPosition,
  setMeasurementsPosition,
  subscribeMeasurementsPosition,
  type MeasurementsPosition,
} from './view'
import { useViewSetting } from './useViewSetting'
import { SettingsForm, SettingsRow, SettingsSeparator, SettingsNote } from './SettingsForm'

// Checkboxes and radios carry their own inline <label> (macOS puts the text
// to the right of the control), so the row label is a plain span.
const choiceLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '13px',
  color: 'var(--text-primary, #eee)',
  cursor: 'pointer',
}

const choiceColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px' }

const sliderScaleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '11px',
  color: 'var(--text-faint, #888)',
}

const POSITION_OPTIONS: { value: MeasurementsPosition; label: MessageDescriptor }[] = [
  { value: 'top-right', label: msg`Top right` },
  { value: 'bottom-right', label: msg`Bottom right` },
]

export function ViewPane() {
  const { t, i18n } = useLingui()
  const stop = useViewSetting(getZoomWheelStop, subscribeZoomWheelStop)
  const smooth = useViewSetting(getSmoothCamera, subscribeSmoothCamera)
  const hints = useViewSetting(getShowToolHints, subscribeShowToolHints)
  const pointer = useViewSetting(getShowToolPointer, subscribeShowToolPointer)
  const position = useViewSetting(getMeasurementsPosition, subscribeMeasurementsPosition)

  return (
    <SettingsForm>
      <SettingsRow label={t`Zoom wheel speed`} htmlFor="settings-view-zoom-speed" alignTop>
        <div style={{ width: '220px' }}>
          <input
            id="settings-view-zoom-speed"
            type="range"
            min={0}
            max={ZOOM_WHEEL_FACTORS.length - 1}
            step={1}
            value={stop}
            aria-valuetext={i18n._(ZOOM_WHEEL_LABELS[stop])}
            onChange={(e) => setZoomWheelStop(Number(e.target.value))}
            style={{ width: '100%', margin: 0 }}
          />
          <div style={sliderScaleStyle} aria-hidden="true">
            <span><Trans>Slow</Trans></span>
            <span><Trans>Fast</Trans></span>
          </div>
        </div>
      </SettingsRow>
      <SettingsNote><Trans>How far one turn of the mouse wheel moves the camera. The middle stop is the usual speed.</Trans></SettingsNote>

      <SettingsRow label={t`Camera`} alignTop>
        <label style={choiceLabelStyle}>
          <input type="checkbox" checked={smooth} onChange={(e) => setSmoothCamera(e.target.checked)} />
          <span><Trans>Smooth camera moves</Trans></span>
        </label>
      </SettingsRow>
      <SettingsNote>
        <Trans>
          Views, scenes, and zoom fly into place, and orbiting coasts to a stop. Turn this off and the camera
          jumps straight there and stops the moment you let go.
        </Trans>
      </SettingsNote>

      <SettingsSeparator />

      <SettingsRow label={t`At the cursor`} alignTop>
        <div style={choiceColumnStyle}>
          <label style={choiceLabelStyle}>
            <input type="checkbox" checked={hints} onChange={(e) => setShowToolHints(e.target.checked)} />
            <span><Trans>Show tool hints</Trans></span>
          </label>
          <label style={choiceLabelStyle}>
            <input type="checkbox" checked={pointer} onChange={(e) => setShowToolPointer(e.target.checked)} />
            <span><Trans>Show tool pointer</Trans></span>
          </label>
        </div>
      </SettingsRow>
      <SettingsNote>
        <Trans>
          Hints are the small labels that follow the pointer, like Endpoint or On Edge. The tool pointer is the
          cursor shaped like your current tool; off, you get the plain arrow.
        </Trans>
      </SettingsNote>

      <SettingsSeparator />

      <SettingsRow label={t`Measurements box`} alignTop>
        <div role="radiogroup" aria-label={t`Measurements box position`} style={choiceColumnStyle}>
          {POSITION_OPTIONS.map((opt) => (
            <label key={opt.value} style={choiceLabelStyle}>
              <input
                type="radio"
                name="settings-view-measurements-position"
                value={opt.value}
                checked={position === opt.value}
                onChange={() => setMeasurementsPosition(opt.value)}
              />
              <span>{i18n._(opt.label)}</span>
            </label>
          ))}
        </div>
      </SettingsRow>
      <SettingsNote>
        <Trans>Where the box that shows the number you are typing sits. The fly speed readout moves with it.</Trans>
      </SettingsNote>
    </SettingsForm>
  )
}
