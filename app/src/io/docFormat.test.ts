import { describe, expect, it } from 'vitest'
import {
  saveFormatForPath,
  SAVE_FORMAT_CHOICES,
  extensionFor,
  formatDescription,
  isSkpFormat,
  nameForFormat,
  normalizeDocFormat,
  skpTarget,
  stripKnownExtension,
} from './docFormat'

describe('stripKnownExtension', () => {
  it('removes one trailing known extension, case-insensitively', () => {
    expect(stripKnownExtension('Model.skp')).toBe('Model')
    expect(stripKnownExtension('Model.SKP')).toBe('Model')
    expect(stripKnownExtension('Chair.hew')).toBe('Chair')
    expect(stripKnownExtension('Kitchen.dae')).toBe('Kitchen')
    expect(stripKnownExtension('Part.stl')).toBe('Part')
    expect(stripKnownExtension('Scan.glb')).toBe('Scan')
    expect(stripKnownExtension('Scan.gltf')).toBe('Scan')
  })

  it('leaves other names alone and only strips the last extension', () => {
    expect(stripKnownExtension('Untitled')).toBe('Untitled')
    expect(stripKnownExtension('notes.txt')).toBe('notes.txt')
    expect(stripKnownExtension('Model.skp.hew')).toBe('Model.skp')
    expect(stripKnownExtension('v1.2 plan')).toBe('v1.2 plan')
  })
})

describe('nameForFormat', () => {
  it('swaps the extension instead of stacking (Model.skp -> Model.hew)', () => {
    expect(nameForFormat('Model.skp', 'hew')).toBe('Model.hew')
    expect(nameForFormat('Model.hew', 'skp2026')).toBe('Model.skp')
    expect(nameForFormat('Model', 'skp2017')).toBe('Model.skp')
    expect(nameForFormat('Model.skp', 'skp2026')).toBe('Model.skp')
  })
})

describe('format helpers', () => {
  it('knows which formats are SketchUp', () => {
    expect(isSkpFormat('hew')).toBe(false)
    expect(isSkpFormat('skp2026')).toBe(true)
    expect(isSkpFormat('skp2017')).toBe(true)
  })

  it('maps formats to extensions, targets and descriptions', () => {
    expect(extensionFor('hew')).toBe('.hew')
    expect(extensionFor('skp2017')).toBe('.skp')
    expect(skpTarget('skp2017')).toBe('skp2017')
    expect(skpTarget('skp2026')).toBe('skp2026')
    expect(formatDescription('hew')).toBe('Hew model')
    expect(formatDescription('skp2026')).toBe('SketchUp model')
    expect(formatDescription('skp2017')).toBe('SketchUp 2017 model')
  })

  it('normalizes unknown values to hew', () => {
    expect(normalizeDocFormat(undefined)).toBe('hew')
    expect(normalizeDocFormat('')).toBe('hew')
    expect(normalizeDocFormat('skp2026')).toBe('skp2026')
    expect(normalizeDocFormat('skp2017')).toBe('skp2017')
  })

  it('offers the three Save As choices in order', () => {
    expect(SAVE_FORMAT_CHOICES.map((c) => c.format)).toEqual(['hew', 'skp2026', 'skp2017'])
    expect(SAVE_FORMAT_CHOICES[2]?.hint).toBe('Opens in SketchUp Make 2017 and later.')
  })
})

describe('saveFormatForPath (the live API\'s hew.doc.save)', () => {
  it('follows the extension, keeping a SketchUp document\'s own container', () => {
    expect(saveFormatForPath('/m/a.hew', undefined, 'skp2017')).toBe('hew')
    expect(saveFormatForPath('/m/a.SKP', undefined, 'skp2017')).toBe('skp2017')
    expect(saveFormatForPath('/m/a.skp', undefined, 'hew')).toBe('skp2026')
    expect(saveFormatForPath('/m/a.skp', undefined, undefined)).toBe('skp2026')
  })

  it('takes a named format the extension agrees with, and refuses one it contradicts', () => {
    expect(saveFormatForPath('/m/a.skp', 'skp2017', 'hew')).toBe('skp2017')
    expect(saveFormatForPath('/m/a.skp', 'skp', 'skp2017')).toBe('skp2026')
    expect(saveFormatForPath('/m/a.hew', 'hew', 'skp2026')).toBe('hew')
    expect(saveFormatForPath('/m/a.skp', 'hew', undefined)).toBeNull()
    expect(saveFormatForPath('/m/a.hew', 'skp', undefined)).toBeNull()
    expect(saveFormatForPath('/m/a.hew', 'obj', undefined)).toBeNull()
  })
})
