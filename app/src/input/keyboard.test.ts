import { describe, expect, it } from 'vitest'
import { isComposingKey, physicalLetter, shortcutLetter } from './keyboard'

describe('isComposingKey', () => {
  it('flags composition keystrokes from every engine', () => {
    expect(isComposingKey({ isComposing: true, key: 'l', keyCode: 76 })).toBe(true)
    expect(isComposingKey({ isComposing: false, key: 'Process', keyCode: 229 })).toBe(true)
    // WebKit: the Enter that confirms a composition, delivered after
    // compositionend with isComposing already false.
    expect(isComposingKey({ isComposing: false, key: 'Enter', keyCode: 229 })).toBe(true)
    expect(isComposingKey({ isComposing: false, key: 'l', keyCode: 76 })).toBe(false)
  })
})

describe('physicalLetter / shortcutLetter', () => {
  it('a produced ASCII letter wins (SketchUp binds letters, so AZERTY keeps its key caps)', () => {
    expect(shortcutLetter({ code: 'KeyQ', key: 'a' })).toBe('a')
    expect(shortcutLetter({ code: 'KeyL', key: 'L' })).toBe('l')
  })

  it('falls back to the physical key when no ASCII letter was produced', () => {
    expect(physicalLetter({ code: 'KeyL' })).toBe('l')
    expect(shortcutLetter({ code: 'KeyL', key: 'ｌ' })).toBe('l')
    expect(shortcutLetter({ code: 'KeyL', key: 'Dead' })).toBe('l')
  })

  it('falls back to the produced character when no code is reported', () => {
    expect(physicalLetter({ code: '' })).toBe(null)
    expect(physicalLetter({ code: 'Digit1' })).toBe(null)
    expect(shortcutLetter({ code: '', key: 'R' })).toBe('r')
  })
})
