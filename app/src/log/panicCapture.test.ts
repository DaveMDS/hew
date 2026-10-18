// @vitest-environment jsdom
// (recordKernelStop fires a page event and writes localStorage, which the
// default node environment for .ts tests has neither of.)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { clearKernelStop, getKernelStop, getPanicCapture, KERNEL_PANIC_EVENT, recordKernelStop } from './panicCapture'

function setGlobal(value: unknown): void {
  ;(globalThis as { __hewLastPanic?: unknown }).__hewLastPanic = value
}

afterEach(() => {
  delete (globalThis as { __hewLastPanic?: unknown }).__hewLastPanic
  clearKernelStop()
  localStorage.clear()
})

describe('recordKernelStop', () => {
  const copy = { headline: 'This model is too large for Hew to open', detail: 'Hew ran out of memory opening Big.skp (137.0 MB).' }

  it('writes the capture the panic hook would, keeps the copy, and fires the panic event', () => {
    const fired = vi.fn()
    globalThis.addEventListener(KERNEL_PANIC_EVENT, fired)
    try {
      recordKernelStop('Out of memory opening Big.skp (137.0 MB); kernel memory 4095.9 MB', copy)
    } finally {
      globalThis.removeEventListener(KERNEL_PANIC_EVENT, fired)
    }
    expect(fired).toHaveBeenCalledTimes(1)
    const capture = getPanicCapture()
    expect(capture?.message).toBe('Out of memory opening Big.skp (137.0 MB); kernel memory 4095.9 MB')
    expect(capture?.recording).toBeNull()
    expect(Date.parse(capture!.at)).not.toBeNaN()
    expect(getKernelStop()).toEqual(copy)
    expect(localStorage.getItem('hew:lastPanic')).toBe(`${capture!.at}\nOut of memory opening Big.skp (137.0 MB); kernel memory 4095.9 MB`)
  })

  it('stands down when the panic hook already captured a panic on this page', () => {
    setGlobal({ at: '2026-01-01T00:00:00.000Z', message: 'panicked at document.rs:42', recording: '{"calls":[]}' })
    const fired = vi.fn()
    globalThis.addEventListener(KERNEL_PANIC_EVENT, fired)
    try {
      recordKernelStop('Kernel trap opening Big.skp', copy)
    } finally {
      globalThis.removeEventListener(KERNEL_PANIC_EVENT, fired)
    }
    expect(fired).not.toHaveBeenCalled()
    expect(getKernelStop()).toBeNull()
    expect(getPanicCapture()?.recording).toBe('{"calls":[]}')
    expect(localStorage.getItem('hew:lastPanic')).toBeNull()
  })
})

describe('getPanicCapture', () => {
  it('returns null when the global is absent', () => {
    expect(getPanicCapture()).toBeNull()
  })

  it('reads a well-formed capture with a recording', () => {
    setGlobal({ at: '2026-01-01T00:00:00.000Z', message: 'panicked at foo.rs:1', recording: '{"version":2,"calls":[],"golden_hash":0}' })
    expect(getPanicCapture()).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      message: 'panicked at foo.rs:1',
      recording: '{"version":2,"calls":[],"golden_hash":0}',
    })
  })

  it('reads a well-formed capture with a null recording', () => {
    setGlobal({ at: '2026-01-01T00:00:00.000Z', message: 'panicked at foo.rs:1', recording: null })
    expect(getPanicCapture()).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      message: 'panicked at foo.rs:1',
      recording: null,
    })
  })

  it.each([
    ['null', null],
    ['a string', 'not an object'],
    ['a number', 42],
    ['missing at', { message: 'm', recording: null }],
    ['missing message', { at: 'a', recording: null }],
    ['non-string at', { at: 1, message: 'm', recording: null }],
    ['non-string message', { at: 'a', message: 1, recording: null }],
    ['non-string/non-null recording', { at: 'a', message: 'm', recording: 1 }],
  ])('returns null for a malformed capture (%s)', (_label, value) => {
    setGlobal(value)
    expect(getPanicCapture()).toBeNull()
  })

  it('never throws even if reading the global itself misbehaves', () => {
    Object.defineProperty(globalThis, '__hewLastPanic', {
      configurable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(() => getPanicCapture()).not.toThrow()
    expect(getPanicCapture()).toBeNull()
    // Restore a plain writable property so afterEach's delete works cleanly.
    Object.defineProperty(globalThis, '__hewLastPanic', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })
})
