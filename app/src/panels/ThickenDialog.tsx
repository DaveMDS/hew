/**
 * ThickenDialog — "Add thickness" for flat panels (docs/design/import-health.md
 * §5.4): a thickness in the current display units and the side it goes on
 * (In front / Behind / Centered). The confirm button hands the parsed values to the caller;
 * 0 or an unparseable length is refused inline. Enter confirms, Escape
 * cancels. Styled like ConfirmDialog.
 */
import { useEffect, useState } from 'react'
import { THICKNESS } from '../health/healthCopy'
import {
  THICKEN_SIDE_LABELS,
  getThickenChoice,
  parseThickness,
  rememberThickenChoice,
  type ThickenSide,
} from '../health/thickenSettings'

interface Props {
  /** How many panels get a thickness (heading copy). */
  count: number
  onConfirm: (distance: number, centered: boolean) => void
  onCancel: () => void
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--backdrop-dim, rgba(0,0,0,0.6))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
}

const DIALOG_STYLE: React.CSSProperties = {
  background: 'var(--surface-overlay, #2a2a2a)',
  border: '1px solid var(--border-strong, #4a4a4a)',
  borderRadius: 'var(--radius-control, 6px)',
  boxShadow: 'var(--shadow-palette, 0 8px 32px rgba(0,0,0,0.6))',
  padding: '20px 24px',
  minWidth: '320px',
  maxWidth: '440px',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  color: 'var(--text-secondary, #ddd)',
}

const BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, transparent)',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

const SIDES: ThickenSide[] = ['front', 'behind', 'centered']

export function ThickenDialog({ count, onConfirm, onCancel }: Props) {
  const initial = getThickenChoice()
  const [text, setText] = useState(initial.text)
  const [side, setSide] = useState<ThickenSide>(initial.side)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (): void => {
    const parsed = parseThickness(text, side)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    rememberThickenChoice({ text, side })
    onConfirm(parsed.distance, parsed.centered)
  }

  const heading = THICKNESS.title(count)
  return (
    <div style={OVERLAY_STYLE} onClick={onCancel}>
      <div style={DIALOG_STYLE} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={heading}>
        <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #eee)', marginBottom: '12px' }}>
          {heading}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', marginBottom: '12px' }}>
            {THICKNESS.field}
            <input
              type="text"
              aria-label={THICKNESS.field}
              value={text}
              autoFocus
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setText(e.target.value)
                setError(null)
              }}
              style={{
                background: 'var(--surface-input, #1e1e1e)',
                border: '1px solid var(--border-strong, #444)',
                borderRadius: '3px',
                color: 'var(--text-primary, #eee)',
                fontFamily: 'var(--font-family-ui)',
                fontSize: '13px',
                padding: '4px 8px',
                outline: 'none',
              }}
            />
          </label>
          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px', display: 'flex', gap: '14px', fontSize: '13px' }}>
            
            {SIDES.map((s) => (
              <label key={s} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input type="radio" name="thicken-side" checked={side === s} onChange={() => setSide(s)} />
                {THICKEN_SIDE_LABELS[s]}
              </label>
            ))}
          </fieldset>
          {error !== null && (
            <div role="alert" style={{ color: 'var(--status-warning, #e8c84a)', fontSize: '12px', marginBottom: '12px' }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" style={BUTTON_STYLE} onClick={onCancel}>
              {THICKNESS.cancel}
            </button>
            <button
              type="submit"
              style={{ ...BUTTON_STYLE, background: 'var(--accent-base, #3a5e9e)', color: 'var(--accent-text-strong, #fff)', border: 'none' }}
            >
              {THICKNESS.confirm}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
