/**
 * FloatingWindow — a small, generic, non-modal window that floats over the
 * viewport. It mounts inside the viewport container (the `position: relative`
 * parent the Make Solid wizard also mounts in), moves by its title bar,
 * resizes by its bottom-right grip, and always stays inside that container
 * (and left of `reservedRight` px, the wizard's width while it is open).
 *
 * It reports which side of the viewport it covers (`onCoverChange`) so camera
 * framing can fit things in the part that stays visible. The last rect is
 * remembered in localStorage under `storageKey`; whether the window is open is
 * the caller's business and is never stored.
 *
 * Opening (and `focusNonce`) focuses the window itself, not a control in it:
 * a focused select or search box would swallow the tool shortcut typed next.
 *
 * There is no Escape-to-close: Escape already cancels the active tool or ends
 * isolation in the viewport. The window closes with its ✕ or from the menu.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ContainerSize {
  width: number
  height: number
}

export interface CoveredSides {
  left: number
  right: number
}

export const MIN_WIDTH = 280
export const MIN_HEIGHT = 200
/** Breathing room kept on the sides of a narrow container. */
const SIDE_MARGIN = 16
const DEFAULT_WIDTH = 340
const DEFAULT_MAX_HEIGHT = 560
const DEFAULT_TOP = 54
const DEFAULT_EDGE_GAP = 12

/**
 * Keep `rect` inside the container and left of `reservedRight`. The size
 * shrinks to fit a small container (never below `min`, unless the container
 * itself is smaller). A container that has not been measured yet (0 × 0)
 * leaves the rect alone.
 */
export function clampRect(
  rect: Rect,
  container: ContainerSize,
  reservedRight = 0,
  min: { width: number; height: number } = { width: MIN_WIDTH, height: MIN_HEIGHT },
): Rect {
  if (container.width <= 0 || container.height <= 0) return rect
  const availW = Math.max(0, container.width - Math.max(0, reservedRight))
  const maxW = Math.max(0, Math.min(availW, container.width) - SIDE_MARGIN)
  const maxH = Math.max(0, container.height - SIDE_MARGIN)
  const width = Math.min(Math.max(rect.width, Math.min(min.width, maxW)), maxW)
  const height = Math.min(Math.max(rect.height, Math.min(min.height, maxH)), maxH)
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, availW - width))
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, container.height - height))
  return { x, y, width, height }
}

/**
 * The part of the viewport the window hides: from the right edge when its
 * center is in the container's right half, else from the left edge.
 */
export function coveredSides(rect: Rect, containerWidth: number): CoveredSides {
  const center = rect.x + rect.width / 2
  if (center > containerWidth / 2) return { left: 0, right: Math.max(0, containerWidth - rect.x) }
  return { left: Math.max(0, rect.x + rect.width), right: 0 }
}

/** The first-open place: the container's right side, below the camera chips. */
export function defaultRect(container: ContainerSize): Rect {
  const width = Math.min(DEFAULT_WIDTH, Math.max(0, container.width - SIDE_MARGIN))
  const height = Math.min(DEFAULT_MAX_HEIGHT, container.height - DEFAULT_TOP - DEFAULT_EDGE_GAP)
  return { x: container.width - DEFAULT_EDGE_GAP - width, y: DEFAULT_TOP, width, height }
}

/** A stored rect, or null for anything that is not four finite numbers. */
export function parseStoredRect(raw: string | null): Rect | null {
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const { x, y, width, height } = o
  for (const n of [x, y, width, height]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

function readStoredRect(key: string): Rect | null {
  try {
    return parseStoredRect(localStorage.getItem(key))
  } catch {
    return null
  }
}

function writeStoredRect(key: string, rect: Rect): void {
  try {
    localStorage.setItem(key, JSON.stringify(rect))
  } catch {
    // Storage unavailable: the window still works, it just won't remember.
  }
}

export interface FloatingWindowProps {
  title: string
  /** The localStorage key the last rect is remembered under. */
  storageKey: string
  onClose: () => void
  children: ReactNode
  /** Pixels at the container's right edge the window must stay clear of. */
  reservedRight?: number
  /** Which side of the container the window covers; zeros on unmount. */
  onCoverChange?: (cover: CoveredSides) => void
  /** Changing this brings the window forward: the window takes focus. */
  focusNonce?: number
  [dataAttr: `data-${string}`]: string | boolean | undefined
}

type Gesture = { kind: 'move' | 'resize'; pointerId: number; startX: number; startY: number; from: Rect }

export function FloatingWindow({
  title,
  storageKey,
  onClose,
  children,
  reservedRight = 0,
  onCoverChange,
  focusNonce = 0,
  ...rest
}: FloatingWindowProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const { t } = useLingui()
  const titleId = useId()
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 })
  const [rect, setRect] = useState<Rect | null>(null)
  const rectRef = useRef<Rect | null>(null)
  rectRef.current = rect
  const gesture = useRef<Gesture | null>(null)
  const reservedRef = useRef(reservedRight)
  reservedRef.current = reservedRight
  const sizeRef = useRef(size)
  sizeRef.current = size

  // Measure the container, and keep measuring as it resizes.
  useLayoutEffect(() => {
    const container = rootRef.current?.parentElement
    if (container == null) return
    const measure = (): void => {
      const next = { width: container.clientWidth, height: container.clientHeight }
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure)
      ro.observe(container)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // First place: the remembered rect, else the default; always clamped.
  // Afterwards: re-clamp when the container or the reserved strip changes.
  const placedUnmeasured = useRef(false)
  useLayoutEffect(() => {
    const measured = size.width > 0 && size.height > 0
    const prev = rectRef.current
    // A first placement made before the container was measured is redone once
    // it is (an unmeasured container can't place anything sensibly).
    const base = prev === null || (measured && placedUnmeasured.current) ? readStoredRect(storageKey) ?? defaultRect(size) : prev
    placedUnmeasured.current = !measured
    setRect(clampRect(base, size, reservedRight))
    // storageKey is fixed for a window's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, reservedRight])

  const coverRef = useRef(onCoverChange)
  coverRef.current = onCoverChange
  useEffect(() => {
    if (rect === null) return
    coverRef.current?.(coveredSides(rect, size.width))
  }, [rect, size.width])
  useEffect(() => () => coverRef.current?.({ left: 0, right: 0 }), [])

  // Bring forward: the window takes focus. It waits for the first placement,
  // since the window is hidden (and so can't take focus) until then.
  const placed = rect !== null
  useEffect(() => {
    if (placed) rootRef.current?.focus()
  }, [focusNonce, placed])

  // One gesture at a time, by the primary button, followed only for the
  // pointer that started it (a right-click or a second touch can't take over).
  const begin = (kind: Gesture['kind']) => (e: React.PointerEvent): void => {
    if (e.button !== 0 || gesture.current !== null) return
    if (kind === 'move' && (e.target as HTMLElement).closest('button') !== null) return
    const from = rectRef.current
    if (from === null) return
    gesture.current = { kind, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, from }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }
  const onGestureMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (g === null || e.pointerId !== g.pointerId) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    const room = sizeRef.current
    const next =
      g.kind === 'move'
        ? { ...g.from, x: g.from.x + dx, y: g.from.y + dy }
        : {
            // Growing stops at the container's edge; it never pushes the window.
            ...g.from,
            width: Math.min(g.from.width + dx, room.width > 0 ? room.width - reservedRef.current - g.from.x : Infinity),
            height: Math.min(g.from.height + dy, room.height > 0 ? room.height - g.from.y : Infinity),
          }
    setRect(clampRect(next, sizeRef.current, reservedRef.current))
  }
  const onGestureEnd = (e: React.PointerEvent): void => {
    if (gesture.current === null || e.pointerId !== gesture.current.pointerId) return
    gesture.current = null
    if (rectRef.current !== null) writeStoredRect(storageKey, rectRef.current)
  }

  const shown = rect ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: MIN_HEIGHT }
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      {...rest}
      style={{
        position: 'absolute',
        left: shown.x,
        top: shown.y,
        width: shown.width,
        height: shown.height,
        // Above the wizard (40) and the viewport overlays; below toasts (100),
        // menus and modal dialogs (the Thicken dialog is fixed at 2000).
        zIndex: 60,
        visibility: rect === null ? 'hidden' : 'visible',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-window)',
        border: '1px solid var(--border-strong)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow-window)',
        fontFamily: 'var(--font-family-ui)',
        color: 'var(--text-secondary)',
        boxSizing: 'border-box',
        outline: 'none',
      }}
    >
      <div
        data-floating-window-title
        onPointerDown={begin('move')}
        onPointerMove={onGestureMove}
        onPointerUp={onGestureEnd}
        onPointerCancel={onGestureEnd}
        onLostPointerCapture={onGestureEnd}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 10px 8px 14px',
          borderBottom: '1px solid var(--border-hairline)',
          cursor: 'move',
          userSelect: 'none',
          touchAction: 'none',
          flex: '0 0 auto',
        }}
      >
        <h2
          id={titleId}
          style={{ margin: 0, flex: '1 1 auto', fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}
        >
          {title}
        </h2>
        <button
          type="button"
          aria-label={t`Close`}
          title={t`Close`}
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            fontSize: '16px',
            lineHeight: 1,
            cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '10px 13px 13px' }}>
        {children}
      </div>
      <div
        role="separator"
        aria-label={t`Resize`}
        data-floating-window-grip
        onPointerDown={begin('resize')}
        onPointerMove={onGestureMove}
        onPointerUp={onGestureEnd}
        onPointerCancel={onGestureEnd}
        onLostPointerCapture={onGestureEnd}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
          touchAction: 'none',
          background:
            'linear-gradient(135deg, transparent 0 55%, var(--border-strong) 55% 63%, transparent 63% 77%, var(--border-strong) 77% 85%, transparent 85%)',
        }}
      />
    </div>
  )
}
