import { describe, expect, it } from 'vitest'
import { PAPER_SIZES } from './paper'
import { layoutPrint } from './layout'
import { arrowheadPath, labelAnchor, lineArtSvgDocument, lineArtSvgForTile, projectAnnotationOverlay, type LineDrawingData } from './lineArt'

/** A 100 mm square (hard) with one hidden diagonal, in view-plane metres. */
function square(): LineDrawingData {
  const coords = new Float64Array([
    -0.05, -0.05, 0.05, -0.05,
    0.05, -0.05, 0.05, 0.05,
    0.05, 0.05, -0.05, 0.05,
    -0.05, 0.05, -0.05, -0.05,
    -0.05, -0.05, 0.05, 0.05,
  ])
  return { coords, kinds: new Uint8Array([0, 0, 0, 0, 4]), sids: new BigUint64Array([1n, 1n, 1n, 1n, 1n]), bounds: [-0.05, -0.05, 0.05, 0.05] }
}

describe('lineArtSvgDocument', () => {
  it('is true size at the scale, y flipped, hidden lines only on request', () => {
    const d = square()
    const svg = lineArtSvgDocument(d, 1, { hiddenDashed: false, marginMm: 0 })
    expect(svg).toContain('width="100mm" height="100mm"')
    expect(svg).toContain('viewBox="-50 -50 100 100"')
    expect(svg).toContain('class="hard"')
    expect(svg).not.toContain('class="hidden"')
    const dashed = lineArtSvgDocument(d, 0.5, { hiddenDashed: true, marginMm: 5 })
    expect(dashed).toContain('width="60mm" height="60mm"')
    expect(dashed).toContain('class="hidden"')
    expect(dashed).toContain('stroke-dasharray')
  })
})

describe('lineArtSvgForTile', () => {
  it('maps the tile model rect to the image rect and keeps strokes at physical weight', () => {
    const layout = layoutPrint({ mode: 'scaled', paper: PAPER_SIZES.letter, orientation: 'portrait', marginMm: 12.7, titleBlockMm: 10, overlapMm: 10, dpi: 300, ratio: 1, extent: { x: -0.05, y: -0.05, w: 0.1, h: 0.1 } })
    const tile = layout.tiles[0]
    const svg = lineArtSvgForTile(square(), tile, layout, 1, { hiddenDashed: true, annotations: { segments: [0, 0, 0.02, 0], labels: [{ x: 0.01, y: 0.005, text: '20 mm', detached: false }], arrows: [] } })
    expect(svg).toContain(`width="${tile.imageRectMm.w}mm"`)
    // viewBox = the model rect (metres), y flipped.
    expect(svg).toContain(`viewBox="${tile.modelRect!.x}`)
    // 0.35 mm hard stroke at 1:1 = 0.00035 user units (metres).
    expect(svg).toMatch(/class="hard" stroke-width="0.00035"/)
    expect(svg).toContain('20 mm')
    expect(svg).toContain('class="annotation"')
  })
})

describe('projectAnnotationOverlay', () => {
  it('projects onto the print frame (top view: x right, y up = world x, y)', () => {
    const cam = { kind: 'ortho' as const, center: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number], rect: { x: -1, y: -1, w: 2, h: 2 }, depth: { min: -1, max: 1 } }
    const o = projectAnnotationOverlay({ segments: [1, 2, 3, 4, 5, 6], labels: [{ position: [0.5, 0.25, 9], text: 'x', detached: false }], arrows: [] }, cam)
    expect(o.segments.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 2, 4, 5])
    expect(o.labels[0].x).toBeCloseTo(0.5, 9)
    expect(o.labels[0].y).toBeCloseTo(0.25, 9)
  })
})

describe('annotation arrowheads on paper', () => {
  const cam = { kind: 'ortho' as const, center: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number], rect: { x: -1, y: -1, w: 2, h: 2 }, depth: { min: -1, max: 1 } }
  it('projects arrows and sizes them from the paper label size, capped by the line', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 5], dir: [1, 0, 0], maxLen: 10 }] }, cam)
    expect(o.arrows).toEqual([{ x: 0, y: 0, dx: 1, dy: 0, maxLen: 10 }])
    // 1:1 scale: 2.7 mm = 0.0027 m; a tight cap wins over that.
    expect(arrowheadPath(o.arrows!, 0.001, (x, y) => `${x} ${y}`)).toContain('L0.0027 ')
    expect(arrowheadPath([{ ...o.arrows![0], maxLen: 0.001 }], 0.001, (x, y) => `${x} ${y}`)).toContain('L0.001 ')
  })
  it('drops a head seen end-on', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 0], dir: [0, 0, 1], maxLen: 1 }] }, cam)
    expect(o.arrows).toEqual([])
  })
})

describe('annotation arrows through both SVG emitters', () => {
  const top = { kind: 'ortho' as const, center: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number], rect: { x: -1, y: -1, w: 2, h: 2 }, depth: { min: -1, max: 1 } }
  // Looking down at 45 degrees from the +y side: a world-y run is foreshortened to 0.7071 and
  // appears pointing down the page (view -y).
  const oblique = { ...top, dir: [0, -Math.SQRT1_2, -Math.SQRT1_2] as [number, number, number], up: [0, 0, 1] as [number, number, number] }
  const arrowPath = (svg: string): string => /class="annotation-arrow"[^>]* d="([^"]*)"/.exec(svg)?.[1] ?? ''
  const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const layout1 = layoutPrint({ mode: 'scaled', paper: PAPER_SIZES.letter, orientation: 'portrait', marginMm: 12.7, titleBlockMm: 10, overlapMm: 10, dpi: 300, ratio: 1, extent: { x: -0.05, y: -0.05, w: 0.1, h: 0.1 } })

  it('document: the head is 2.7 mm on paper, y flipped, at the scaled tip', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0.05, 0.05, 0], dir: [0, 1, 0], maxLen: 1 }] }, top)
    const svg = lineArtSvgDocument(square(), 0.5, { hiddenDashed: false, marginMm: 0, annotations: o })
    // k = 500: tip (25, -25); the arrow points up the model (down in y-flipped
    // SVG user space), so its wings sit at y = -25 - 2.7.
    const n = nums(arrowPath(svg))
    expect(n).toHaveLength(8)
    expect(n.slice(0, 2)).toEqual([25, -25])
    expect(n[3]).toBeCloseTo(-27.7, 6)
    const wings = [n[2], n[6]].sort((x, y) => x - y)
    expect(wings[0]).toBeCloseTo(25 - 0.945, 6)
    expect(wings[1]).toBeCloseTo(25 + 0.945, 6)
  })

  it('document: a short line caps the head, scaled by k', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 0], dir: [1, 0, 0], maxLen: 0.001 }] }, top)
    const n = nums(arrowPath(lineArtSvgDocument(square(), 0.5, { hiddenDashed: false, marginMm: 0, annotations: o })))
    // 0.001 m at k = 500 is 0.5 mm, shorter than the 2.7 mm head.
    expect(n[2]).toBeCloseTo(0.5, 6)
  })

  it('document: an oblique view foreshortens the cap and keeps the sign', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 0], dir: [0, 1, 0], maxLen: 0.002 }] }, oblique)
    expect(o.arrows).toHaveLength(1)
    expect(o.arrows[0].dx).toBeCloseTo(0, 9)
    expect(o.arrows[0].dy).toBeCloseTo(-1, 9)
    expect(o.arrows[0].maxLen).toBeCloseTo(0.002 * Math.SQRT1_2, 9)
    const n = nums(arrowPath(lineArtSvgDocument(square(), 1, { hiddenDashed: false, marginMm: 0, annotations: o })))
    // k = 1000: cap 1.414 mm; view -y flips to +y in SVG user space.
    expect(n[3]).toBeCloseTo(0.002 * Math.SQRT1_2 * 1000, 5)
    expect(n[3]).toBeGreaterThan(0)
  })

  it('tile: metres in user space, head sized by mm per metre, no y flip in the path', () => {
    const tile = layout1.tiles[0]
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0.01, 0.01, 0], dir: [0, 1, 0], maxLen: 1 }] }, top)
    const svg = lineArtSvgForTile(square(), tile, layout1, 1, { hiddenDashed: false, annotations: o })
    const n = nums(arrowPath(svg))
    // 2.7 mm at 1:1 is 0.0027 m, pointing +y (the group's scale(1,-1) flips it on the page).
    expect(n.slice(0, 2)).toEqual([0.01, 0.01])
    expect(n[3]).toBeCloseTo(0.01 + 0.0027, 6)
    const wings = [n[2], n[6]].sort((x, y) => x - y)
    expect(wings[0]).toBeCloseTo(0.01 - 0.000945, 6)
    expect(wings[1]).toBeCloseTo(0.01 + 0.000945, 6)
  })

  it('tile: the scale divides the head (1:2 doubles its size in metres)', () => {
    const layout2 = layoutPrint({ mode: 'scaled', paper: PAPER_SIZES.letter, orientation: 'portrait', marginMm: 12.7, titleBlockMm: 10, overlapMm: 10, dpi: 300, ratio: 0.5, extent: { x: -0.05, y: -0.05, w: 0.1, h: 0.1 } })
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 0], dir: [0, 1, 0], maxLen: 1 }] }, top)
    const n = nums(arrowPath(lineArtSvgForTile(square(), layout2.tiles[0], layout2, 0.5, { hiddenDashed: false, annotations: o })))
    expect(n[3]).toBeCloseTo(0.0054, 6)
  })

  it('tile: an oblique head is capped by the foreshortened line', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [], arrows: [{ tip: [0, 0, 0], dir: [0, 1, 0], maxLen: 0.002 }] }, oblique)
    const n = nums(arrowPath(lineArtSvgForTile(square(), layout1.tiles[0], layout1, 1, { hiddenDashed: false, annotations: o })))
    // Projected cap 0.001414 m < 0.0027 m, heading view -y.
    expect(n[3]).toBeCloseTo(-0.002 * Math.SQRT1_2, 6)
  })
})

describe('radial label push on paper', () => {
  const top = { kind: 'ortho' as const, center: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number], rect: { x: -1, y: -1, w: 2, h: 2 }, depth: { min: -1, max: 1 } }
  const labelX = (svg: string): number => Number(/class="annotation-label" x="(-?[\d.]+)"/.exec(svg)![1])
  const R = 'R5' // 2 chars: width 2 * 0.55 * 3 = 3.3 mm, half 1.65, plus 1.2 padding

  it('projects the push direction into the view plane, and drops it when seen end-on', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [{ position: [0, 0, 0], text: R, detached: false, pushDir: [1, 0, 0] }], arrows: [] }, top)
    expect(o.labels[0].push).toEqual({ dx: 1, dy: 0 })
    const end = projectAnnotationOverlay({ segments: [], labels: [{ position: [0, 0, 0], text: R, detached: false, pushDir: [0, 0, 1] }], arrows: [] }, top)
    expect(end.labels[0].push).toBeUndefined()
  })

  it('document: the label moves past its anchor by half its width plus padding', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [{ position: [0.01, 0, 0], text: R, detached: false, pushDir: [1, 0, 0] }], arrows: [] }, top)
    const svg = lineArtSvgDocument(square(), 1, { hiddenDashed: false, marginMm: 0, annotations: o })
    // Anchor at 10 mm; pushed right by 1.65 + 0.4 * 3.
    expect(labelX(svg)).toBeCloseTo(10 + 1.65 + 1.2, 5)
  })

  it('document: an unpushed label stays on its anchor', () => {
    const o = projectAnnotationOverlay({ segments: [], labels: [{ position: [0.01, 0, 0], text: R, detached: false }], arrows: [] }, top)
    expect(labelX(lineArtSvgDocument(square(), 1, { hiddenDashed: false, marginMm: 0, annotations: o }))).toBeCloseTo(10, 6)
  })

  it('tile: the push is in metres at the drawing scale', () => {
    const layout = layoutPrint({ mode: 'scaled', paper: PAPER_SIZES.letter, orientation: 'portrait', marginMm: 12.7, titleBlockMm: 10, overlapMm: 10, dpi: 300, ratio: 0.5, extent: { x: -0.05, y: -0.05, w: 0.1, h: 0.1 } })
    const o = projectAnnotationOverlay({ segments: [], labels: [{ position: [0, 0, 0], text: R, detached: false, pushDir: [0, 1, 0] }], arrows: [] }, top)
    const svg = lineArtSvgForTile(square(), layout.tiles[0], layout, 0.5, { hiddenDashed: false, annotations: o })
    // Pushed up: the box exits through its top (1.5 mm) plus 1.2 mm padding, at 1 mm paper = 2 mm model.
    const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(svg.slice(svg.indexOf('annotation-label')))!
    expect(Number(m[1])).toBeCloseTo(0, 9)
    expect(Number(m[2])).toBeCloseTo((1.5 + 1.2) * 0.002, 6)
  })

  it('a diagonal push clears the upright box through whichever side it exits first', () => {
    const d = Math.SQRT1_2
    const p = labelAnchor({ x: 0, y: 0, text: R, detached: false, push: { dx: d, dy: d } }, 1)
    // Height 1.5 is nearer than width 1.65 along a 45 degree line.
    expect(p.x).toBeCloseTo((1.5 / d + 1.2) * d, 6)
    expect(p.y).toBeCloseTo((1.5 / d + 1.2) * d, 6)
  })
})
