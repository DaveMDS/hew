import { describe, it, expect } from 'vitest'
import { EraserTool, type EraseTarget, type EraserHost } from './EraserTool'
import type { Ray } from '../viewport/math'

const RAY = { origin: [0, 0, 0], direction: [0, 0, -1] } as unknown as Ray

const box: EraseTarget = { kind: 'node', ref: { kind: 'object', id: 1n } }
const line: EraseTarget = { kind: 'node', ref: { kind: 'draft-edge', id: 2n } as never }
const guide: EraseTarget = { kind: 'guide', id: 7n }
const dim: EraseTarget = { kind: 'annotation', id: 9n }

/** A host whose pick reads a map of canvas columns: every pixel in
 * [from, to) on any row picks `target`. Records every call. A guide is
 * given a 4 px band, the narrowest the stroke's sampling step promises to
 * catch (the real pick radius is wider). */
function makeHost(columns: { from: number; to: number; target: EraseTarget }[]) {
  const log: string[] = []
  const picked: number[] = []
  const erased: EraseTarget[][] = []
  const host: EraserHost = {
    pickAt: (x) => {
      picked.push(x)
      return columns.find((c) => x >= c.from && x < c.to)?.target ?? null
    },
    select: (t) => log.push(`select ${t.kind === 'node' ? `node:${t.ref.id}` : `${t.kind}:${t.id}`}`),
    clearSelection: () => log.push('clear'),
    erase: (targets) => {
      erased.push([...targets])
      log.push('erase')
    },
  }
  return { host, log, picked, erased }
}

function esc(): KeyboardEvent {
  return { key: 'Escape' } as KeyboardEvent
}

describe('EraserTool', () => {
  it('a click clears the selection, selects what it touched, and erases it on release', () => {
    const { host, log, erased } = makeHost([{ from: 0, to: 10, target: box }])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 5)
    expect(log).toEqual(['clear', 'select node:1'])
    expect(tool.hasArmedGesture()).toBe(true)
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([[box]])
    expect(tool.hasArmedGesture()).toBe(false)
  })

  it('a click on nothing erases nothing', () => {
    const { host, log, erased } = makeHost([])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 5)
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([])
    expect(log).toEqual(['clear'])
  })

  it('a drag selects each thing it crosses once, in touch order, and erases them together', () => {
    const { host, log, erased } = makeHost([
      { from: 0, to: 10, target: box },
      { from: 20, to: 24, target: guide },
      { from: 30, to: 40, target: dim },
      { from: 50, to: 60, target: box },
    ])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(2, 0)
    tool.onPointerScreenMove(8, 0)
    tool.onPointerScreenMove(35, 0)
    tool.onPointerScreenMove(55, 0)
    expect(log).toEqual(['clear', 'select node:1', 'select guide:7', 'select annotation:9'])
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([[box, guide, dim]])
  })

  it('samples between two pointer events, so a fast drag still catches a thin guide it crossed', () => {
    const { host, picked, erased } = makeHost([{ from: 50, to: 54, target: guide }])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(0, 0)
    tool.onPointerScreenMove(100, 0)
    expect(picked.length).toBeGreaterThanOrEqual(25)
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([[guide]])
  })

  it('a pointer move without a press touches nothing', () => {
    const { host, log, picked } = makeHost([{ from: 0, to: 10, target: box }])
    const tool = new EraserTool(host)
    tool.onPointerScreenMove(5, 5)
    expect(picked).toEqual([])
    expect(log).toEqual([])
  })

  it('Escape mid-stroke deselects what the stroke selected, erases nothing, and touches nothing more', () => {
    const { host, log, erased, picked } = makeHost([
      { from: 0, to: 10, target: box },
      { from: 20, to: 30, target: line },
    ])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 0)
    tool.onKey(esc())
    expect(log).toEqual(['clear', 'select node:1', 'clear'])
    expect(tool.hasArmedGesture()).toBe(false)
    const before = picked.length
    tool.onPointerScreenMove(25, 0)
    expect(picked.length).toBe(before)
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([])
    // The next stroke works again.
    tool.onPointerRawDown(25, 0)
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([[line]])
  })

  it('Escape on a stroke that touched nothing leaves the selection alone', () => {
    const { host, log } = makeHost([])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 0)
    tool.onKey(esc())
    expect(log).toEqual(['clear'])
  })

  it('an undo or redo mid-stroke abandons the stroke', () => {
    const { host, log, erased } = makeHost([{ from: 0, to: 10, target: box }])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 0)
    tool.onHistoryChanged()
    expect(log).toEqual(['clear', 'select node:1', 'clear'])
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([])
  })

  it('an undo or redo between strokes touches nothing', () => {
    const { host, log } = makeHost([])
    const tool = new EraserTool(host)
    tool.onHistoryChanged()
    expect(log).toEqual([])
  })

  it('cancel mid-stroke abandons it like Escape', () => {
    const { host, log, erased } = makeHost([{ from: 0, to: 10, target: box }])
    const tool = new EraserTool(host)
    tool.onPointerRawDown(5, 0)
    tool.cancel()
    expect(log).toEqual(['clear', 'select node:1', 'clear'])
    tool.onPointerUp(null, RAY)
    expect(erased).toEqual([])
  })

  it('a document reset between strokes leaves the selection alone', () => {
    const { host, log } = makeHost([])
    const tool = new EraserTool(host)
    tool.onDocumentReset()
    expect(log).toEqual([])
  })

  it('a click takes what a Select click takes, for the hover highlight', () => {
    const tool = new EraserTool(makeHost([]).host)
    expect(tool.clickAcquire()).toEqual({ guides: false, nodes: false, select: true })
  })
})
