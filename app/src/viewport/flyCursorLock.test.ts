import { describe, expect, it, vi } from 'vitest'
import {
  FlyCursorLock,
  chooseFlyCursorLockProvider,
  flyLookDelta,
  type FlyCursorLockDocument,
  type FlyCursorLockProvider,
} from './flyCursorLock'

/** A document double with the Pointer Lock surface the lock reads. */
function fakeDocument(): FlyCursorLockDocument & {
  listeners: Map<string, Set<() => void>>
  fire(type: string): void
  exitPointerLock: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Set<() => void>>()
  const doc = {
    pointerLockElement: null as unknown,
    exitPointerLock: vi.fn(),
    listeners,
    addEventListener: (type: string, l: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(l)
    },
    removeEventListener: (type: string, l: () => void) => {
      listeners.get(type)?.delete(l)
    },
    fire: (type: string) => {
      for (const l of listeners.get(type) ?? []) l()
    },
  }
  return doc
}

function make(provider: FlyCursorLockProvider, overrides: { shell?: (locked: boolean, x: number, y: number) => Promise<boolean>; requestPointerLock?: () => unknown } = {}) {
  const document = fakeDocument()
  const target = { requestPointerLock: overrides.requestPointerLock ?? vi.fn() }
  const shell = vi.fn(overrides.shell ?? (() => Promise.resolve(true)))
  const changes: Array<[boolean, boolean]> = []
  const lock = new FlyCursorLock({
    provider,
    target,
    document,
    shell,
    onChange: (locked, unexpected) => changes.push([locked, unexpected]),
  })
  lock.attach()
  return { lock, document, target, shell, changes }
}

describe('chooseFlyCursorLockProvider', () => {
  it('gives the macOS desktop shell its own path, since WKWebView denies the API', () => {
    expect(chooseFlyCursorLockProvider({ isTauri: true, isMac: true, hasPointerLock: true })).toBe('shell')
    expect(chooseFlyCursorLockProvider({ isTauri: true, isMac: true, hasPointerLock: false })).toBe('shell')
  })
  it('uses the standard API in browsers and the other shells', () => {
    expect(chooseFlyCursorLockProvider({ isTauri: false, isMac: true, hasPointerLock: true })).toBe('pointerlock')
    expect(chooseFlyCursorLockProvider({ isTauri: true, isMac: false, hasPointerLock: true })).toBe('pointerlock')
    expect(chooseFlyCursorLockProvider({ isTauri: false, isMac: false, hasPointerLock: true })).toBe('pointerlock')
  })
  it('has no lock where the API is missing', () => {
    expect(chooseFlyCursorLockProvider({ isTauri: false, isMac: false, hasPointerLock: false })).toBe('none')
  })
})

describe('flyLookDelta', () => {
  const ev = { movementX: 7, movementY: -3, clientX: 110, clientY: 95 }
  it('reads raw movement while locked (the cursor is frozen)', () => {
    expect(flyLookDelta(true, ev, { x: 100, y: 100 })).toEqual({ dx: 7, dy: -3 })
  })
  it('reads the position difference while unlocked', () => {
    expect(flyLookDelta(false, ev, { x: 100, y: 100 })).toEqual({ dx: 10, dy: -5 })
  })
})

describe('FlyCursorLock with the Pointer Lock API', () => {
  it('requests the lock on the target and reports it held once the document says so', () => {
    const { lock, document, target, changes } = make('pointerlock')
    lock.request(10, 20)
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1)
    expect(lock.locked).toBe(false)
    document.pointerLockElement = target
    document.fire('pointerlockchange')
    expect(lock.locked).toBe(true)
    expect(changes).toEqual([[true, false]])
  })

  it('is idempotent while wanted', () => {
    const { lock, target } = make('pointerlock')
    lock.request(0, 0)
    lock.request(0, 0)
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1)
  })

  it('release exits the lock and reports it released at once, not when the event lands', () => {
    const { lock, document, target, changes } = make('pointerlock')
    lock.request(0, 0)
    document.pointerLockElement = target
    document.fire('pointerlockchange')
    lock.release()
    expect(document.exitPointerLock).toHaveBeenCalledTimes(1)
    expect(lock.locked).toBe(false)
    expect(changes).toEqual([[true, false], [false, false]])
    // The browser's own change event for the exit is not a second report.
    document.pointerLockElement = null
    document.fire('pointerlockchange')
    expect(changes).toHaveLength(2)
  })

  it('reports a lock the browser took away (Escape, focus loss) as unexpected and does not re-request', () => {
    const { lock, document, target, changes } = make('pointerlock')
    lock.request(0, 0)
    document.pointerLockElement = target
    document.fire('pointerlockchange')
    document.pointerLockElement = null
    document.fire('pointerlockchange')
    expect(lock.locked).toBe(false)
    expect(changes).toEqual([[true, false], [false, true]])
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1)
    // A later request is a fresh one.
    lock.request(0, 0)
    expect(target.requestPointerLock).toHaveBeenCalledTimes(2)
  })

  it('a denied request without a gesture leaves the lock available for another try', () => {
    const { lock, document, target } = make('pointerlock')
    lock.request(0, 0)
    document.fire('pointerlockerror')
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(true)
    lock.request(0, 0)
    expect(target.requestPointerLock).toHaveBeenCalledTimes(2)
  })

  it('a denied request made inside a gesture marks the lock unavailable (the API is blocked)', () => {
    const { lock, document, target, changes } = make('pointerlock')
    lock.request(0, 0, { gesture: true })
    document.fire('pointerlockerror')
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(false)
    expect(changes).toEqual([])
    lock.request(0, 0, { gesture: true })
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1)
  })

  it('a grant that lands after release is given straight back and never reported held', () => {
    const { lock, document, target, changes } = make('pointerlock')
    lock.request(0, 0)
    lock.release()
    // Pending at release time: nothing to exit yet.
    expect(document.exitPointerLock).not.toHaveBeenCalled()
    document.pointerLockElement = target
    document.fire('pointerlockchange')
    expect(lock.locked).toBe(false)
    expect(document.exitPointerLock).toHaveBeenCalledTimes(1)
    expect(changes).toEqual([])
    document.pointerLockElement = null
    document.fire('pointerlockchange')
    expect(changes).toEqual([])
  })

  it('swallows the promise rejection Chromium and Firefox return (pointerlockerror carries it)', async () => {
    const rejected = Promise.reject(new Error('A user gesture is required'))
    const { lock } = make('pointerlock', { requestPointerLock: () => rejected })
    lock.request(0, 0)
    await Promise.resolve()
    await Promise.resolve()
    expect(lock.locked).toBe(false)
  })

  it('a request while the document already holds the lock on the target is held at once', () => {
    const { lock, document, target } = make('pointerlock')
    document.pointerLockElement = target
    lock.request(0, 0)
    expect(lock.locked).toBe(true)
    expect(target.requestPointerLock).not.toHaveBeenCalled()
  })

  it('detach releases and unsubscribes', () => {
    const { lock, document, target } = make('pointerlock')
    lock.request(0, 0)
    document.pointerLockElement = target
    document.fire('pointerlockchange')
    lock.detach()
    expect(document.exitPointerLock).toHaveBeenCalledTimes(1)
    expect(document.listeners.get('pointerlockchange')?.size ?? 0).toBe(0)
    expect(document.listeners.get('pointerlockerror')?.size ?? 0).toBe(0)
  })
})

describe('FlyCursorLock with the macOS shell', () => {
  it('is held the moment it is requested and warps the cursor to the given point', async () => {
    const { lock, shell, changes } = make('shell')
    lock.request(320, 240)
    expect(lock.locked).toBe(true)
    expect(changes).toEqual([[true, false]])
    await new Promise((r) => setTimeout(r, 0))
    expect(shell).toHaveBeenCalledWith(true, 320, 240)
    lock.release()
    expect(lock.locked).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(shell).toHaveBeenLastCalledWith(false, 0, 0)
    expect(lock.available).toBe(true)
  })

  it('never touches the Pointer Lock API', () => {
    const { lock, target, document } = make('shell')
    lock.request(0, 0)
    lock.release()
    expect(target.requestPointerLock).not.toHaveBeenCalled()
    expect(document.exitPointerLock).not.toHaveBeenCalled()
  })

  it('a shell that rejects the command (an older shell) makes the lock unavailable', async () => {
    const { lock, changes } = make('shell', { shell: () => Promise.reject(new Error('command not found')) })
    lock.request(0, 0)
    expect(lock.locked).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(false)
    // Not "unexpected": nothing took the lock away, the shell has none.
    expect(changes).toEqual([[true, false], [false, false]])
    lock.request(0, 0)
    expect(lock.locked).toBe(false)
  })

  it('runs the shell calls one after another, so a quick lock-then-unlock can never apply out of order', async () => {
    const order: string[] = []
    let releaseLock: () => void = () => undefined
    const { lock } = make('shell', {
      shell: (locked) => {
        order.push(locked ? 'lock:start' : 'unlock:start')
        if (locked) {
          return new Promise<boolean>((resolve) => {
            releaseLock = () => {
              order.push('lock:done')
              resolve(true)
            }
          })
        }
        order.push('unlock:done')
        return Promise.resolve(true)
      },
    })
    lock.request(0, 0)
    lock.release()
    await new Promise((r) => setTimeout(r, 0))
    // The unlock has not started: the lock is still in flight.
    expect(order).toEqual(['lock:start'])
    releaseLock()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['lock:start', 'lock:done', 'unlock:start', 'unlock:done'])
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(true)
  })

  it('a failure of a lock call that a later unlock superseded is ignored', async () => {
    let calls = 0
    const { lock } = make('shell', {
      shell: (locked) => {
        calls++
        return locked ? Promise.reject(new Error('late failure')) : Promise.resolve(true)
      },
    })
    lock.request(0, 0)
    lock.release()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(true)
  })

  it('a failed lock is followed by a best-effort unlock before the lock is written off', async () => {
    const seen: boolean[] = []
    const { lock } = make('shell', {
      shell: (locked) => {
        seen.push(locked)
        return locked ? Promise.resolve(false) : Promise.resolve(true)
      },
    })
    lock.request(0, 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([true, false])
    expect(lock.available).toBe(false)
  })

  it('a shell that declines (resolves false) does the same', async () => {
    const { lock } = make('shell', { shell: () => Promise.resolve(false) })
    lock.request(0, 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(lock.locked).toBe(false)
    expect(lock.available).toBe(false)
  })
})

describe('FlyCursorLock with no provider', () => {
  it('is unavailable and a request is a no-op', () => {
    const { lock, target, shell, changes } = make('none')
    expect(lock.available).toBe(false)
    lock.request(0, 0)
    expect(lock.locked).toBe(false)
    expect(target.requestPointerLock).not.toHaveBeenCalled()
    expect(shell).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  })
})
