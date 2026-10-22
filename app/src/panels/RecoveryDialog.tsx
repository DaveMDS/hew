/**
 * RecoveryDialog — modal shown at startup when autosaved recovery
 * snapshots exist and nothing else was loaded yet (see shouldPromptRecovery
 * in ../io/recoveryStore.ts).
 *
 * Lists every recoverable document — with several document windows open at
 * a crash there are several snapshots, and all of them are offered, not just
 * the newest. "Recover" loads the newest into this window and opens one
 * window per remaining snapshot; "Discard" clears them all. Escape only
 * dismisses the dialog WITHOUT clearing — an accidental keypress must never
 * destroy recoverable work; the snapshots are simply re-offered on the next
 * launch.
 */

import { useEffect, useCallback } from 'react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { RecoveryListing } from '../io/recoveryStore'
import { formatRecoveryTime } from '../io/recoveryStore'
import { isComposingKey } from '../input/keyboard'

interface RecoveryDialogProps {
  /** Every recoverable snapshot, newest first (non-empty). */
  listings: RecoveryListing[]
  onRecover: () => void
  onDiscard: () => void
  /** Dismiss without clearing the snapshots (Escape) — re-offered next launch. */
  onDismiss: () => void
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--backdrop-dim)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
}

const DIALOG_STYLE: React.CSSProperties = {
  background: 'var(--surface-window)',
  border: '1px solid var(--border-strong)',
  borderRadius: '6px',
  boxShadow: 'var(--shadow-window)',
  padding: '20px 24px',
  minWidth: '340px',
  maxWidth: '480px',
  fontFamily: 'var(--font-family-ui)',
  color: 'var(--text-secondary)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: '12px',
}

const BODY_STYLE: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--text-secondary)',
  marginBottom: '20px',
  lineHeight: '1.5',
}

const LIST_STYLE: React.CSSProperties = {
  margin: '10px 0 0',
  paddingLeft: '18px',
}

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '10px',
}

const DISCARD_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--surface-input)',
  color: 'var(--text-primary)',
  border: 'none',
  borderRadius: '4px',
  fontSize: '13px',
  fontFamily: 'var(--font-family-ui)',
  cursor: 'pointer',
}

const RECOVER_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--accent-base)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '13px',
  fontFamily: 'var(--font-family-ui)',
  cursor: 'pointer',
}

const NAME_STYLE: React.CSSProperties = { color: 'var(--text-primary)' }

export function RecoveryDialog({ listings, onRecover, onDiscard, onDismiss }: RecoveryDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isComposingKey(e)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
      }
    },
    [onDismiss],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const now = Date.now()
  const single = listings.length === 1
  const { t } = useLingui()
  const count = listings.length
  const firstName = listings[0]?.meta.name ?? ''
  const firstTime = listings[0] !== undefined ? formatRecoveryTime(listings[0].meta.savedAt, now) : ''

  return (
    <div style={OVERLAY_STYLE}>
      <div
        style={DIALOG_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={plural(count, { one: 'Recover unsaved document', other: 'Recover unsaved documents' })}
      >
        <div style={HEADING_STYLE}>
          {plural(count, { one: 'Recover Unsaved Document?', other: 'Recover # Unsaved Documents?' })}
        </div>
        <div style={BODY_STYLE}>
          {single ? (
            <>
              <Trans>
                Hew found an autosaved version of <strong style={NAME_STYLE}>{firstName}</strong> from {firstTime}{' '}
                that wasn&apos;t saved before the app closed.
              </Trans>
            </>
          ) : (
            <>
              <Trans>
                Hew found autosaved versions of these documents that weren&apos;t saved before the app closed.
                Recover opens each one in its own window.
              </Trans>
              <ul style={LIST_STYLE}>
                {listings.map((l) => (
                  <li key={l.slot}>
                    <strong style={NAME_STYLE}>{l.meta.name}</strong>{' '}
                    ({formatRecoveryTime(l.meta.savedAt, now)})
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div style={BUTTON_ROW_STYLE}>
          <button style={DISCARD_BUTTON_STYLE} onClick={onDiscard}>
            {single ? t`Discard` : t`Discard All`}
          </button>
          <button style={RECOVER_BUTTON_STYLE} onClick={onRecover} autoFocus>
            {single ? t`Recover` : t`Recover All`}
          </button>
        </div>
      </div>
    </div>
  )
}
