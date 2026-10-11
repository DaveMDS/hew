/**
 * SaveFormatDialog — the in-app format choice File ▸ Save As… shows before
 * the native save picker: Hew document, SketchUp (the 2026 container), or
 * SketchUp 2017. The picker's filter and forced extension follow the choice
 * (`FileHost.saveAs`'s `format`). The selection starts on the current
 * document's format (`hew` for a new document).
 *
 * Enter continues, Escape cancels; styled like ConfirmDialog.
 */

import { useCallback, useEffect, useState } from 'react'
import type { DocFormat } from '../io/fileHost'
import { SAVE_FORMAT_CHOICES } from '../io/docFormat'

interface SaveFormatDialogProps {
  /** The format selected when the dialog opens. */
  initial: DocFormat
  onChoose: (format: DocFormat) => void
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
  minWidth: '360px',
  maxWidth: '480px',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  color: 'var(--text-secondary, #ddd)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--text-primary, #eee)',
  marginBottom: '14px',
}

const OPTION_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  padding: '8px 4px',
  cursor: 'pointer',
}

const OPTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-size-menu-item, 13px)',
  color: 'var(--text-primary, #eee)',
}

const OPTION_HINT_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-size-body, 12px)',
  color: 'var(--text-tertiary, #ccc)',
  marginTop: '2px',
}

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '10px',
  marginTop: '16px',
}

const CANCEL_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, transparent)',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

const CONFIRM_BUTTON_STYLE: React.CSSProperties = {
  ...CANCEL_BUTTON_STYLE,
  background: 'var(--accent-base, #3a5e9e)',
  color: 'var(--accent-text-strong, #fff)',
  border: 'none',
}

export function SaveFormatDialog({ initial, onChoose, onCancel }: SaveFormatDialogProps) {
  const [format, setFormat] = useState<DocFormat>(initial)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      } else if (e.key === 'Enter') {
        // A focused button (Cancel, Continue) handles its own Enter.
        if (e.target instanceof HTMLButtonElement) return
        e.preventDefault()
        e.stopPropagation()
        onChoose(format)
      }
    },
    [onCancel, onChoose, format],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div style={OVERLAY_STYLE} onClick={onCancel}>
      <div
        style={DIALOG_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Save As"
      >
        <div style={HEADING_STYLE}>Save As</div>
        <div role="radiogroup" aria-label="File format">
          {SAVE_FORMAT_CHOICES.map((choice) => (
            <label key={choice.format} style={OPTION_STYLE}>
              <input
                type="radio"
                name="save-format"
                value={choice.format}
                checked={format === choice.format}
                onChange={() => setFormat(choice.format)}
                autoFocus={choice.format === initial}
              />
              <span>
                <div style={OPTION_LABEL_STYLE}>{choice.label}</div>
                <div style={OPTION_HINT_STYLE}>{choice.hint}</div>
              </span>
            </label>
          ))}
        </div>
        <div style={BUTTON_ROW_STYLE}>
          <button style={CANCEL_BUTTON_STYLE} onClick={onCancel}>
            Cancel
          </button>
          <button style={CONFIRM_BUTTON_STYLE} onClick={() => onChoose(format)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
