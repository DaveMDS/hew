/**
 * ViewportHUD — top-left camera-tool cluster (`07_inference_feedback.md`):
 * an Orbit glyph + Top/Iso/Front quick-view chips. Net new — no HUD existed
 * over the viewport before this milestone. These are pure quick-access
 * shortcuts to actions that already exist (the Camera menu's Standard Views
 * submenu, the Orbit tool); full camera control still lives there.
 *
 * No live "current view" state exists anywhere in the app (the camera can
 * freely orbit away from any exact standard view), so these are plain
 * action buttons, not a toggle/radio group — matches the spec's own mock,
 * which doesn't show any of them in a "pressed" state either.
 */
import { useLingui } from '@lingui/react/macro'
import type { StandardView } from './Viewport'

export interface ViewportHUDProps {
  onSelectView: (view: StandardView) => void
  onOrbit: () => void
}

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  padding: '5px 10px',
  background: 'var(--surface-overlay)',
  border: '1px solid var(--border-hairline)',
  borderRadius: '7px',
  fontFamily: 'var(--font-family-ui)',
  fontSize: '11.5px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

export function ViewportHUD({ onSelectView, onOrbit }: ViewportHUDProps) {
  const { t } = useLingui()
  return (
    <div
      data-testid="viewport-hud"
      style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        zIndex: 20,
      }}
    >
      <button type="button" onClick={onOrbit} title={t`Orbit`} style={chipStyle}>
        <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '50%', border: '1.4px solid currentColor' }} />
        {t`Orbit`}
      </button>
      <button type="button" onClick={() => onSelectView('top')} title={t`Standard View: Top`} style={chipStyle}>{t`Top`}</button>
      <button type="button" onClick={() => onSelectView('iso')} title={t`Standard View: Iso`} style={chipStyle}>{t`Iso`}</button>
      <button type="button" onClick={() => onSelectView('front')} title={t`Standard View: Front`} style={chipStyle}>{t`Front`}</button>
    </div>
  )
}
