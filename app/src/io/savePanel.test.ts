import { describe, expect, it } from 'vitest'
import { scalePresetsFor } from '../print/scale'
import {
  DEFAULT_STL_SEGMENTS,
  EXPORT_FORMATS,
  SAVE_PANEL_FORMATS,
  STL_RESOLUTIONS,
  defaultSvgScaleIndex,
  exportChoiceFrom,
  exportPanelFormats,
  saveFormatFrom,
} from './savePanel'

describe('the native save panel\'s formats', () => {
  it('Save As lists Hew and both SketchUp containers, by the ids the app saves', () => {
    expect(SAVE_PANEL_FORMATS.map((f) => [f.id, f.extension])).toEqual([
      ['hew', 'hew'],
      ['skp2026', 'skp'],
      ['skp2017', 'skp'],
    ])
    expect(saveFormatFrom({ path: '/a.skp', format: 'skp2017', options: {} })).toBe('skp2017')
    expect(saveFormatFrom({ path: '/a.skp', format: 'skp2026', options: {} })).toBe('skp2026')
    expect(saveFormatFrom({ path: '/a.hew', format: 'anything', options: {} })).toBe('hew')
  })

  it('Export lists every format the in-app dialog does, STL and SVG with their options', () => {
    const formats = exportPanelFormats('mm')
    expect(formats.map((f) => f.id)).toEqual(EXPORT_FORMATS.map((f) => f.format))
    const byId = Object.fromEntries(formats.map((f) => [f.id, f]))
    expect(byId.glb.options).toEqual([])
    const stl = byId.stl.options ?? []
    expect(stl).toHaveLength(1)
    expect(stl[0]).toMatchObject({ kind: 'select', id: 'segments', value: String(DEFAULT_STL_SEGMENTS) })
    expect(stl[0].kind === 'select' && stl[0].choices.map((c) => c.value)).toEqual(
      STL_RESOLUTIONS.map((r) => String(r.value)),
    )
    expect((byId.svg.options ?? []).map((o) => [o.kind, o.id])).toEqual([
      ['select', 'view'],
      ['select', 'scale'],
      ['check', 'hidden'],
      ['check', 'dimensions'],
    ])
  })
})

describe('an export from the panel\'s answer', () => {
  it('carries the STL resolution picked', () => {
    const choice = exportChoiceFrom({ path: '/m.stl', format: 'stl', options: { segments: '96' } }, 'mm')
    expect(choice).toEqual({ format: 'stl', stlSegmentsPerTurn: 96 })
  })

  it('carries the SVG view, scale and switches picked', () => {
    const presets = scalePresetsFor('mm')
    const choice = exportChoiceFrom(
      {
        path: '/m.svg',
        format: 'svg',
        options: { view: 'top', scale: '2', hidden: true, dimensions: false },
      },
      'mm',
    )
    expect(choice?.svg).toEqual({
      view: 'top',
      scale: presets[2],
      hiddenDashed: true,
      includeDimensions: false,
    })
  })

  it('falls back to the defaults for values it does not know, and refuses an unknown format', () => {
    const presets = scalePresetsFor('arch')
    const choice = exportChoiceFrom(
      { path: '/m.svg', format: 'svg', options: { view: 'sideways', scale: '999', segments: 'many' } },
      'arch',
    )
    expect(choice?.stlSegmentsPerTurn).toBe(DEFAULT_STL_SEGMENTS)
    expect(choice?.svg?.view).toBe('current')
    expect(choice?.svg?.scale).toEqual(presets[defaultSvgScaleIndex(presets)])
    expect(choice?.svg?.includeDimensions).toBe(true)
    expect(exportChoiceFrom({ path: '/m.obj', format: 'obj', options: {} }, 'mm')).toBeNull()
  })
})
