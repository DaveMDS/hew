/**
 * FloatingWindow — the pure placement helpers (clamp, covered sides, default
 * place, the stored value) and the window itself: dragging by the title bar,
 * resizing by the grip, the ✕, the remembered rect, storage that throws, the
 * covered-side report, and bringing it forward.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FloatingWindow,
  clampRect,
  coveredSides,
  defaultRect,
  parseStoredRect,
} from './FloatingWindow'

const BOX = { width: 1000, height: 700 }
const KEY = 'hew.test.floatingWindow'

describe('clampRect', () => {
  it('leaves a rect that fits alone', () => {
    const r = { x: 100, y: 80, width: 340, height: 400 }
    expect(clampRect(r, BOX, 0)).toEqual(r)
  })
  it('pulls a rect back inside every edge', () => {
    expect(clampRect({ x: -50, y: -9, width: 340, height: 400 }, BOX, 0)).toMatchObject({ x: 0, y: 0 })
    expect(clampRect({ x: 900, y: 600, width: 340, height: 400 }, BOX, 0)).toMatchObject({ x: 660, y: 300 })
  })
  it('keeps clear of the reserved strip on the right', () => {
    expect(clampRect({ x: 900, y: 10, width: 340, height: 400 }, BOX, 400)).toMatchObject({ x: 260 })
  })
  it('raises a too-small size to the minimum and shrinks a too-big one', () => {
    expect(clampRect({ x: 0, y: 0, width: 50, height: 50 }, BOX, 0)).toMatchObject({ width: 280, height: 200 })
    expect(clampRect({ x: 0, y: 0, width: 5000, height: 5000 }, BOX, 0)).toMatchObject({ width: 984, height: 684 })
  })
  it('shrinks to fit a narrow container, never off-screen', () => {
    const r = clampRect({ x: 40, y: 0, width: 340, height: 400 }, { width: 250, height: 700 }, 0)
    expect(r.width).toBe(234)
    expect(r.x).toBe(16)
    expect(r.x + r.width).toBeLessThanOrEqual(250)
  })
  it('an unmeasured container leaves the rect alone', () => {
    const r = { x: 5, y: 6, width: 7, height: 8 }
    expect(clampRect(r, { width: 0, height: 0 }, 0)).toBe(r)
  })
})

describe('coveredSides', () => {
  it('a window in the right half covers from its left edge to the right edge', () => {
    expect(coveredSides({ x: 648, y: 54, width: 340, height: 500 }, 1000)).toEqual({ left: 0, right: 352 })
  })
  it('a window in the left half covers from the left edge to its right edge', () => {
    expect(coveredSides({ x: 20, y: 54, width: 340, height: 500 }, 1000)).toEqual({ left: 360, right: 0 })
  })
})

describe('defaultRect', () => {
  it('sits 12 px from the right edge, 54 px down, 340 wide', () => {
    expect(defaultRect({ width: 1000, height: 700 })).toEqual({ x: 648, y: 54, width: 340, height: 560 })
  })
  it('a short container shortens it', () => {
    expect(defaultRect({ width: 1000, height: 400 })).toMatchObject({ height: 334 })
  })
  it('a narrow container narrows it', () => {
    expect(defaultRect({ width: 300, height: 700 })).toMatchObject({ width: 284, x: 4 })
  })
})

describe('parseStoredRect', () => {
  it('reads a good value', () => {
    expect(parseStoredRect('{"x":1,"y":2,"width":3,"height":4}')).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
  it('rejects bad JSON, missing fields, and non-numbers', () => {
    expect(parseStoredRect(null)).toBeNull()
    expect(parseStoredRect('{nope')).toBeNull()
    expect(parseStoredRect('null')).toBeNull()
    expect(parseStoredRect('[1,2,3,4]')).toBeNull()
    expect(parseStoredRect('{"x":1,"y":2,"width":3}')).toBeNull()
    expect(parseStoredRect('{"x":"1","y":2,"width":3,"height":4}')).toBeNull()
    expect(parseStoredRect('{"x":1,"y":2,"width":3,"height":null}')).toBeNull()
  })
})

describe('FloatingWindow', () => {
  let cw: ReturnType<typeof vi.spyOn>
  let ch: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(BOX.width)
    ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(BOX.height)
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  })
  afterEach(() => {
    cw.mockRestore()
    ch.mockRestore()
    vi.restoreAllMocks()
  })

  const win = (): HTMLElement => screen.getByRole('dialog', { name: 'Things' })
  const titleBar = (): HTMLElement => win().querySelector('[data-floating-window-title]') as HTMLElement
  const grip = (): HTMLElement => win().querySelector('[data-floating-window-grip]') as HTMLElement
  const place = (): { x: number; y: number; w: number; h: number } => ({
    x: parseFloat(win().style.left),
    y: parseFloat(win().style.top),
    w: parseFloat(win().style.width),
    h: parseFloat(win().style.height),
  })
  const mount = (props: Partial<React.ComponentProps<typeof FloatingWindow>> = {}) =>
    render(
      <div>
        <FloatingWindow title="Things" storageKey={KEY} onClose={() => {}} {...props}>
          <button type="button">First</button>
          <button type="button">Second</button>
        </FloatingWindow>
      </div>,
    )

  it('is a non-modal dialog labelled by its title, placed by default', () => {
    mount()
    expect(win()).toHaveAttribute('aria-modal', 'false')
    expect(screen.getByRole('heading', { name: 'Things' })).toBeInTheDocument()
    expect(place()).toEqual({ x: 648, y: 54, w: 340, h: 560 })
  })

  it('the ✕ calls onClose', () => {
    const onClose = vi.fn()
    mount({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dragging the title bar moves it, and a drag past an edge clamps', () => {
    mount()
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 600, clientY: 100, pointerId: 1 })
    expect(place()).toMatchObject({ x: 548, y: 94 })
    fireEvent.pointerMove(titleBar(), { clientX: -9000, clientY: -9000, pointerId: 1 })
    expect(place()).toMatchObject({ x: 0, y: 0 })
    fireEvent.pointerMove(titleBar(), { clientX: 9000, clientY: 9000, pointerId: 1 })
    expect(place()).toMatchObject({ x: 660, y: 140 })
    fireEvent.pointerUp(titleBar(), { pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 0, clientY: 0, pointerId: 1 })
    expect(place()).toMatchObject({ x: 660, y: 140 }) // no drag in progress: ignored
  })

  it('a drag that starts on the ✕ does not move the window', () => {
    mount()
    const x = screen.getByRole('button', { name: 'Close' })
    fireEvent.pointerDown(x, { clientX: 900, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 500, clientY: 300, pointerId: 1 })
    expect(place()).toMatchObject({ x: 648, y: 54 })
  })

  it('the grip resizes, within the minimum and the container', () => {
    mount()
    fireEvent.pointerDown(grip(), { clientX: 988, clientY: 614, pointerId: 1 })
    fireEvent.pointerMove(grip(), { clientX: 900, clientY: 500, pointerId: 1 })
    expect(place()).toMatchObject({ x: 648, y: 54, w: 280, h: 446 }) // the minimum width wins over 252
    fireEvent.pointerMove(grip(), { clientX: 9000, clientY: 9000, pointerId: 1 })
    expect(place()).toMatchObject({ w: 352, h: 646 }) // as far as the container allows
  })

  it('remembers the last rect and uses it (clamped) next time', () => {
    const first = mount()
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 500, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(titleBar(), { pointerId: 1 })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ x: 448, y: 94, width: 340, height: 560 })
    first.unmount()
    mount()
    expect(place()).toMatchObject({ x: 448, y: 94, w: 340, h: 560 })
    document.body.innerHTML = ''
    localStorage.setItem(KEY, JSON.stringify({ x: 5000, y: 5000, width: 340, height: 560 }))
    mount()
    expect(place()).toMatchObject({ x: 660, y: 140 })
  })

  it('ignores a bad stored value', () => {
    localStorage.setItem(KEY, '{"x":"left"}')
    mount()
    expect(place()).toEqual({ x: 648, y: 54, w: 340, h: 560 })
  })

  it('still renders and drags when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    mount()
    expect(place()).toEqual({ x: 648, y: 54, w: 340, h: 560 })
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 650, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(titleBar(), { pointerId: 1 })
    expect(place()).toMatchObject({ x: 598 })
  })

  it('stays left of reservedRight, and re-clamps when it changes', () => {
    const view = mount()
    expect(place().x).toBe(648)
    view.rerender(
      <div>
        <FloatingWindow title="Things" storageKey={KEY} onClose={() => {}} reservedRight={500}>
          <button type="button">First</button>
        </FloatingWindow>
      </div>,
    )
    expect(place().x + place().w).toBeLessThanOrEqual(500)
  })

  it('re-clamps when the container shrinks (window resize fallback)', () => {
    mount()
    cw.mockReturnValue(600)
    fireEvent(window, new Event('resize'))
    expect(place().x + place().w).toBeLessThanOrEqual(600)
  })

  it('reports the covered side on placement and on move, and zeros on unmount', () => {
    const onCoverChange = vi.fn()
    const view = mount({ onCoverChange })
    expect(onCoverChange).toHaveBeenLastCalledWith({ left: 0, right: 352 })
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 100, clientY: 60, pointerId: 1 })
    expect(onCoverChange).toHaveBeenLastCalledWith({ left: 48 + 340, right: 0 })
    view.unmount()
    expect(onCoverChange).toHaveBeenLastCalledWith({ left: 0, right: 0 })
  })

  it('the window takes focus on mount and again when focusNonce changes', () => {
    const view = mount({ focusNonce: 1 })
    expect(win()).toHaveFocus()
    screen.getByRole('button', { name: 'Second' }).focus()
    view.rerender(
      <div>
        <FloatingWindow title="Things" storageKey={KEY} onClose={() => {}} focusNonce={2}>
          <button type="button">First</button>
          <button type="button">Second</button>
        </FloatingWindow>
      </div>,
    )
    expect(win()).toHaveFocus()
  })

  it('a right-click or a second pointer never moves it', () => {
    mount()
    const left0 = win().style.left
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1, button: 2 })
    fireEvent.pointerMove(titleBar(), { clientX: 400, clientY: 160, pointerId: 1 })
    expect(win().style.left).toBe(left0)
    // A drag by pointer 1; pointer 2 can neither move it nor end it.
    fireEvent.pointerDown(titleBar(), { clientX: 700, clientY: 60, pointerId: 1 })
    fireEvent.pointerDown(titleBar(), { clientX: 900, clientY: 300, pointerId: 2 })
    fireEvent.pointerMove(titleBar(), { clientX: 100, clientY: 300, pointerId: 2 })
    expect(win().style.left).toBe(left0)
    fireEvent.pointerUp(titleBar(), { pointerId: 2 })
    fireEvent.pointerMove(titleBar(), { clientX: 600, clientY: 60, pointerId: 1 })
    expect(win().style.left).toBe(`${parseFloat(left0) - 100}px`)
    fireEvent.pointerUp(titleBar(), { pointerId: 1 })
  })

  it('Escape does not close it', () => {
    const onClose = vi.fn()
    mount({ onClose })
    fireEvent.keyDown(win(), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
