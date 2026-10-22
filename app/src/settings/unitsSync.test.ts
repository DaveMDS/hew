// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest'
import { DEFAULT_PRECISION, getPrecision, getLengthUnit, setPrecision, setLengthUnit, subscribe } from './units'

afterEach(() => {
  for (const f of ['m', 'cm', 'mm', 'dec_in', 'frac_in', 'arch'] as const) setPrecision(DEFAULT_PRECISION[f], f)
  setLengthUnit('m')
  // @ts-expect-error — jsdom has no such property unless a test set it.
  delete window.__TAURI_INTERNALS__
})

describe('Precision sync from another window', () => {
  it('applies a storage event for the precision key and notifies subscribers', () => {
    const cb = vi.fn()
    const off = subscribe(cb)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hew.settings.precision',
        newValue: JSON.stringify({ m: 5, cm: 2, mm: 1, dec_in: 2, frac_in: 'foot', arch: 32 }),
      }),
    )
    expect(getPrecision('m')).toBe(5)
    expect(getPrecision('dec_in')).toBe(2)
    expect(getPrecision('frac_in')).toBe('foot')
    expect(getPrecision('arch')).toBe(32)
    expect(cb).toHaveBeenCalledTimes(1)
    // Junk values fall back to the defaults; bad JSON is ignored.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'hew.settings.precision', newValue: JSON.stringify({ m: 99 }) }),
    )
    expect(getPrecision('m')).toBe(3)
    window.dispatchEvent(new StorageEvent('storage', { key: 'hew.settings.precision', newValue: '{nope' }))
    expect(getPrecision('m')).toBe(3)
    off()
  })

  it('applies the precision in a Tauri settings-changed payload and leaves the format alone', async () => {
    const callbacks: ((e: { payload: unknown }) => void)[] = []
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: (cb: (e: { payload: unknown }) => void) => callbacks.push(cb),
        invoke: async () => 0,
        unregisterCallback: () => {},
      },
      configurable: true,
    })
    vi.resetModules()
    const fresh = await import('./units')
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0))
    const cb = vi.fn()
    fresh.subscribe(cb)
    const before = fresh.getLengthUnit()
    callbacks.forEach((h) => h({ payload: { precision: { m: 1, cm: 2, mm: 1, dec_in: 3, frac_in: 8, arch: 8 } } }))
    expect(fresh.getPrecision('m')).toBe(1)
    expect(fresh.getPrecision('frac_in')).toBe(8)
    expect(fresh.getLengthUnit()).toBe(before)
    expect(cb).toHaveBeenCalled()
    // Another setting's payload and junk leave it alone.
    const calls = cb.mock.calls.length
    callbacks.forEach((h) => h({ payload: { theme: 'dark' } }))
    callbacks.forEach((h) => h({ payload: null }))
    expect(cb.mock.calls.length).toBe(calls)
    expect(getLengthUnit()).toBe('m')
  })
})
