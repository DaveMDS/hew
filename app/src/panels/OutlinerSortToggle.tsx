/**
 * The Outliner's sort control: three icon buttons in one segmented
 * strip (Document order, Name, Kind), Finder/Explorer style. A radio group
 * — one is always on — so arrow keys move between them and select as they
 * go. The strip stretches to the height of the filter box beside it and
 * never makes the row taller.
 */
import { useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { OUTLINER_SORT_LABELS, type OutlinerSort } from '../settings/view'

const MODES: OutlinerSort[] = ['document', 'name', 'kind']

const SVG_PROPS = {
  viewBox: '0 0 16 16',
  width: 14,
  height: 14,
  'aria-hidden': true,
  focusable: false,
} as const

/** Numbered list: three rows with a number-ish tick at the left. */
function DocumentOrderGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <line x1="7" y1="3.5" x2="14" y2="3.5" />
        <line x1="7" y1="8" x2="14" y2="8" />
        <line x1="7" y1="12.5" x2="14" y2="12.5" />
        <path d="M2.2 2.6 3.4 2v3" />
        <path d="M2 7.2c.3-.7 2-.7 2 .2 0 .8-2 1.3-2 2.1h2.1" />
        <path d="M2 11.6h2l-1 1.1c.7 0 1.1.4 1.1.9 0 .6-.6 1-1.2 1-.4 0-.7-.1-.9-.3" />
      </g>
    </svg>
  )
}

/** "A to Z": a small A, an arrow, and a Z. */
function NameGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M.9 7.4 2.7 2.2l1.8 5.2M1.5 5.8h2.4" />
        <path d="M5.6 4.8h4.4M8.4 3.2l1.8 1.6-1.8 1.6" />
        <path d="M11.2 2.4h3.6l-3.6 5h3.6" />
        <path d="M2.4 11.3h11.2M9.6 9.7l3.9 1.6-3.9 1.6" />
      </g>
    </svg>
  )
}

/** Shapes: a circle, a square, and a triangle. */
function KindGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <circle cx="4.6" cy="4.6" r="2.7" />
        <rect x="9.4" y="2" width="5" height="5" rx="0.6" />
        <path d="M8 14 11.2 8.8 14.4 14Z" />
        <path d="M1.8 14h5.6" />
      </g>
    </svg>
  )
}

const GLYPHS: Record<OutlinerSort, () => React.JSX.Element> = {
  document: DocumentOrderGlyph,
  name: NameGlyph,
  kind: KindGlyph,
}

export function OutlinerSortToggle({
  value,
  onChange,
}: {
  value: OutlinerSort
  onChange: (next: OutlinerSort) => void
}) {
  const { t, i18n } = useLingui()
  const refs = useRef<Partial<Record<OutlinerSort, HTMLButtonElement | null>>>({})

  function onKeyDown(e: React.KeyboardEvent, mode: OutlinerSort): void {
    const i = MODES.indexOf(mode)
    let next: OutlinerSort | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = MODES[(i + 1) % MODES.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = MODES[(i + MODES.length - 1) % MODES.length]
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    onChange(next)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={t`Sort outliner`}
      title={t`Sort outliner`}
      data-testid="outliner-sort"
      style={{
        display: 'flex',
        alignSelf: 'stretch',
        flexShrink: 0,
        overflow: 'hidden',
        borderRadius: '3px',
        border: '1px solid var(--border-strong, #555)',
        background: 'var(--surface-input, #444)',
        boxSizing: 'border-box',
      }}
    >
      {MODES.map((mode, i) => {
        const on = mode === value
        const Glyph = GLYPHS[mode]
        return (
          <button
            key={mode}
            ref={(el) => {
              refs.current[mode] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={i18n._(OUTLINER_SORT_LABELS[mode])}
            title={i18n._(OUTLINER_SORT_LABELS[mode])}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(mode)}
            onKeyDown={(e) => onKeyDown(e, mode)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              minHeight: 0,
              padding: 0,
              margin: 0,
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-strong, #555)',
              borderRadius: 0,
              // The strip clips overflow, so the keyboard focus ring is drawn
              // inside the button instead of outside, where it would vanish.
              outlineOffset: '-2px',
              cursor: 'pointer',
              background: on ? 'var(--accent-tint-18, rgba(91,140,255,0.18))' : 'transparent',
              color: on ? 'var(--accent-text-strong, var(--accent-base, #7aa7e0))' : 'var(--text-secondary, #bbb)',
              boxShadow: on ? 'inset 0 -2px 0 var(--accent-base, #7aa7e0)' : 'none',
            }}
          >
            <Glyph />
          </button>
        )
      })}
    </div>
  )
}
