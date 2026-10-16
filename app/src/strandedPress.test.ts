// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installStrandedPressFix, strandedPressAsPointerDown } from './strandedPress'

function move(init: PointerEventInit): PointerEvent {
  return new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerType: 'mouse', ...init })
}

describe('strandedPressAsPointerDown', () => {
  it('turns a left press reported as a move into a pointerdown at the same spot', () => {
    const down = strandedPressAsPointerDown(move({ button: 0, buttons: 1, clientX: 40, clientY: 70, shiftKey: true, pointerId: 1 }))
    expect(down).not.toBeNull()
    expect(down!.type).toBe('pointerdown')
    expect([down!.button, down!.buttons, down!.clientX, down!.clientY]).toEqual([0, 1, 40, 70])
    expect(down!.shiftKey).toBe(true)
    expect(down!.pointerId).toBe(1)
    expect(down!.bubbles).toBe(true)
  })

  it('leaves real moves, drags, chorded presses, and touch or pen alone', () => {
    expect(strandedPressAsPointerDown(move({ button: -1, buttons: 0 }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: -1, buttons: 1 }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: 0, buttons: 5 }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: 0, buttons: 3 }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: 2, buttons: 3 }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: 0, buttons: 1, pointerType: 'touch' }))).toBeNull()
    expect(strandedPressAsPointerDown(move({ button: 0, buttons: 1, pointerType: 'pen' }))).toBeNull()
  })
})

describe('installStrandedPressFix', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    document.body.innerHTML = ''
  })

  it('delivers the owed pointerdown to the target and hides the move', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', (e) => seen.push(`down ${e.clientX}`))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1, clientX: 12 }))
    el.dispatchEvent(move({ button: -1, buttons: 1, clientX: 14 }))
    expect(seen).toEqual(['down 12', 'move'])
  })

  it('recovers one press per release, never a stream of them', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', () => seen.push('down'))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, buttons: 0 }))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    expect(seen).toEqual(['down', 'move', 'down'])
  })

  it('recovers again after a pointercancel ends the press', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', () => seen.push('down'))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'mouse' }))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    expect(seen).toEqual(['down', 'down'])
  })

  it('recovers again after the window blurs mid-press', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', () => seen.push('down'))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    window.dispatchEvent(new Event('blur'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    expect(seen).toEqual(['down', 'down'])
  })

  it('resets on a real pointerdown, so a lost release cannot block the next press', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', (e) => seen.push(`down ${e.clientX}`))
    el.addEventListener('pointermove', (e) => seen.push(`move ${e.clientX}`))
    el.dispatchEvent(move({ button: 0, buttons: 1, clientX: 5 }))
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, buttons: 1, clientX: 99 }))
    el.dispatchEvent(move({ button: 0, buttons: 1, clientX: 7 }))
    expect(seen).toEqual(['down 5', 'down 99', 'down 7'])
  })

  it('stops recovering once uninstalled', () => {
    uninstall = installStrandedPressFix(window)
    uninstall()
    uninstall = null
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', () => seen.push('down'))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    expect(seen).toEqual(['move'])
  })

  it('keeps the latch when a focused element blurs, since only window blur resets it', () => {
    uninstall = installStrandedPressFix(window)
    const el = document.createElement('div')
    document.body.appendChild(el)
    const seen: string[] = []
    el.addEventListener('pointerdown', () => seen.push('down'))
    el.addEventListener('pointermove', () => seen.push('move'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    el.dispatchEvent(new Event('blur'))
    el.dispatchEvent(move({ button: 0, buttons: 1 }))
    expect(seen).toEqual(['down', 'move'])
  })
})
