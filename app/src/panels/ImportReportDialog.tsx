/**
 * ImportReportDialog — modal shown after a successful model import
 * (COLLADA, SketchUp, or glTF).
 *
 * Displays the kernel ImportReport fields:
 *   - objects created, and how many of them are solid. Not being solid is
 *     normal for a SketchUp model, so the text is neutral. OK is always the
 *     primary button; when anything isn't solid a secondary Make Solid…
 *     button opens the Make Solid wizard on this import.
 *   - a notice when a .skp looks incomplete or damaged (`incomplete`)
 *   - skipped meshes (name + reason), if any
 *   - missing texture URIs, if any
 *   - warnings, if any: parser recovery notes from damaged SketchUp files
 *     and non-manifold split notices from any importer (COLLADA, glTF,
 *     SketchUp)
 *
 * Dismissed by clicking OK or pressing Escape (Make Solid… also
 * closes it).
 */

import { useEffect, useCallback } from 'react'
import type { ImportReport } from '../io/fileHost'
import { REPORT, ACTION, importSummary } from '../health/healthCopy'

interface ImportReportDialogProps {
  report: ImportReport
  /** The file was opened as the document's own (a .skp), not imported. */
  opened?: boolean
  onClose: () => void
  /** Close the dialog and open the Make Solid wizard on this import's
   *  objects. The Make Solid… button shows only when this is given and
   *  something isn't solid. */
  onMakeSolid?: () => void
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
  maxWidth: '520px',
  fontFamily: 'var(--font-family-ui)',
  color: 'var(--text-secondary)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: '16px',
}

const SECTION_STYLE: React.CSSProperties = {
  marginBottom: '12px',
}

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-faint)',
  marginBottom: '6px',
}

const LIST_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0 0 0 16px',
  fontSize: '12px',
  color: 'var(--text-secondary)',
  lineHeight: '1.6',
  maxHeight: '120px',
  overflowY: 'auto',
}

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '16px',
}

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--accent-base)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '13px',
  fontFamily: 'var(--font-family-ui)',
  cursor: 'pointer',
}

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
  ...PRIMARY_BUTTON_STYLE,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-strong)',
}

export function ImportReportDialog({ report, opened = false, onClose, onMakeSolid }: ImportReportDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    },
    [onClose],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const { objects_created, lines_added, health, skipped, textures_missing, warnings } = report
  const notSolid =
    health.flat_sheets + health.bent_sheets + health.cappable + health.holes + health.mixed + health.non_manifold
  const canMakeSolid = onMakeSolid !== undefined && objects_created > 0 && notSolid > 0

  return (
    <div style={OVERLAY_STYLE} onClick={onClose}>
      <div
        style={DIALOG_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={opened ? 'Open report' : 'Import report'}
      >
        <div style={HEADING_STYLE}>{opened ? 'Open Complete' : 'Import Complete'}</div>

        {/* Summary row */}
        <div style={{ ...SECTION_STYLE, fontSize: '13px', color: 'var(--text-primary)' }}>
          {objects_created === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>
              {lines_added > 0
                ? `No objects were created. ${lines_added === 1 ? '1 line' : `${lines_added} lines`} of drawing came in.`
                : 'No objects were created.'}
            </span>
          ) : (
            <div data-import-headline>
              {importSummary(opened ? 'Opened' : 'Imported', objects_created, health.solids)}
              {lines_added > 0 && ` ${lines_added === 1 ? '1 line' : `${lines_added} lines`} of drawing came in too.`}
            </div>
          )}
        </div>

        {/* A damaged or cut-short .skp that still yielded something: said
            out loud, since what is missing can't be listed. */}
        {report.incomplete === true && (
          <div
            style={{ ...SECTION_STYLE, fontSize: '13px', color: 'var(--status-warning)' }}
            data-import-incomplete
          >
            This file looks incomplete or damaged, so parts of the model may be missing.
            If it was downloaded or copied, a fresh copy may open whole.
          </div>
        )}

        {/* Skipped meshes */}
        {skipped.length > 0 && (
          <div style={SECTION_STYLE}>
            <div style={SECTION_LABEL_STYLE}>{REPORT.leftOut(skipped.length)}</div>
            <ul style={LIST_STYLE}>
              {skipped.map((item, i) => (
                <li key={i}>
                  <strong style={{ color: 'var(--text-primary)' }}>{item.name}</strong>
                  {' — '}
                  <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Missing textures */}
        {textures_missing.length > 0 && (
          <div style={SECTION_STYLE}>
            <div style={SECTION_LABEL_STYLE}>{REPORT.missingTextures(textures_missing.length)}</div>
            <ul style={LIST_STYLE}>
              {textures_missing.map((uri, i) => (
                <li key={i} style={{ fontFamily: 'monospace', fontSize: '11px' }}>{uri}</li>
              ))}
            </ul>
          </div>
        )}

        {/* The importers' notes (a damaged section the reader skipped, a
            mesh that came in as separate pieces) are for the curious, so
            they start folded away; each line carries its own context. */}
        {warnings.length > 0 && (
          <details style={SECTION_STYLE} data-import-details>
            <summary style={{ ...SECTION_LABEL_STYLE, cursor: 'pointer' }}>{REPORT.details(warnings.length)}</summary>
            <ul style={LIST_STYLE}>
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </details>
        )}

        <div style={BUTTON_ROW_STYLE}>
          {canMakeSolid && (
            <button style={SECONDARY_BUTTON_STYLE} onClick={onMakeSolid}>
              {ACTION.makeSolid}
            </button>
          )}
          <button style={PRIMARY_BUTTON_STYLE} onClick={onClose} autoFocus>
            {ACTION.ok}
          </button>
        </div>
      </div>
    </div>
  )
}
