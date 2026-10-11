/**
 * nextPaint — the double-requestAnimationFrame paint barrier.
 *
 * The contract under test: the promise must NOT resolve within the first
 * animation frame (rAF callbacks run before that frame paints, so resolving
 * there would let a synchronous block preempt the paint), and MUST resolve
 * once the second frame has begun (by which point the first frame — with the
 * flushed DOM — has been painted).
 *
 * rAF is stubbed with a manual queue so the frame boundaries are explicit
 * and deterministic in the node environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextPaint } from './paint'

describe('nextPaint', () => {
  let queue: FrameRequestCallback[]

  beforeEach(() => {
    queue = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queue.push(cb)
      return queue.length
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Fire every callback queued so far, as one animation frame. */
  const fireFrame = () => {
    const frame = queue
    queue = []
    for (const cb of frame) cb(0)
  }

  /** Drain pending microtasks so `.then` continuations run. */
  const drainMicrotasks = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('does not resolve before any frame fires', async () => {
    let resolved = false
    void nextPaint().then(() => { resolved = true })
    await drainMicrotasks()
    expect(resolved).toBe(false)
  })

  it('does not resolve after a single frame — one rAF precedes the paint', async () => {
    let resolved = false
    void nextPaint().then(() => { resolved = true })
    fireFrame()
    await drainMicrotasks()
    expect(resolved).toBe(false)
    // The first callback must have re-queued into the next frame.
    expect(queue.length).toBe(1)
  })

  it('resolves once the second frame begins (first frame has painted)', async () => {
    let resolved = false
    const p = nextPaint().then(() => { resolved = true })
    fireFrame()
    fireFrame()
    await drainMicrotasks()
    expect(resolved).toBe(true)
    await p
  })

  describe('on a hidden page, which runs no animation frames', () => {
    let visibility: DocumentVisibilityState
    let listeners: Array<() => void>

    beforeEach(() => {
      visibility = 'visible'
      listeners = []
      vi.stubGlobal('document', {
        get visibilityState() {
          return visibility
        },
        addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
        removeEventListener: (_type: string, cb: () => void) => {
          listeners = listeners.filter((l) => l !== cb)
        },
      })
    })

    it('resolves without waiting for a frame', async () => {
      visibility = 'hidden'
      let resolved = false
      void nextPaint().then(() => { resolved = true })
      await drainMicrotasks()
      expect(resolved).toBe(true)
      expect(queue.length).toBe(0)
    })

    it('stops waiting when the page is hidden while the frames are pending', async () => {
      let resolved = false
      void nextPaint().then(() => { resolved = true })
      fireFrame()
      await drainMicrotasks()
      expect(resolved).toBe(false)
      visibility = 'hidden'
      for (const l of [...listeners]) l()
      await drainMicrotasks()
      expect(resolved).toBe(true)
      expect(listeners.length).toBe(0)
    })

    it('still waits for both frames while visible, and lets go of its listener', async () => {
      let resolved = false
      void nextPaint().then(() => { resolved = true })
      expect(listeners.length).toBe(1)
      fireFrame()
      fireFrame()
      await drainMicrotasks()
      expect(resolved).toBe(true)
      expect(listeners.length).toBe(0)
    })
  })
})
