/**
 * Fly's cursor lock (docs/design/fly-navigation.md §10, "Cursor lock"):
 * while a flight is engaged the cursor is hidden and held in place, so a
 * long look never walks it off the window edge (the "scrub" of release,
 * re-center, re-press that a captured drag forced), and the latched mode
 * can look with the mouse or a trackpad finger with no button held at all.
 * The cursor comes back where it was hidden when the flight ends — the
 * Unreal Editor posture.
 *
 * Two providers, chosen once from the environment (`chooseFlyCursorLockProvider`):
 *
 * - `'pointerlock'` — the standard Pointer Lock API (browsers, Tauri's
 *   WebView2 and WebKitGTK shells). Asynchronous: the lock is reported by
 *   `pointerlockchange`/`pointerlockerror` on the document; the browser may
 *   also take it away on its own (Escape, focus loss), which `onChange`
 *   reports as `unexpected`.
 * - `'shell'` — the macOS desktop shell. WKWebView denies the Pointer Lock
 *   API unless its embedder implements a private WebKit delegate (verified
 *   against WebKit's `UIDelegate.mm`; the request rejects with "requires
 *   the window to have focus" even when it has it), but it reports the HID
 *   deltas as `movementX`/`movementY` whether or not the cursor moves. So
 *   the shell warps the cursor to the requested point, freezes it
 *   (`CGAssociateMouseAndMouseCursorPosition(false)`) and hides it; look
 *   reads the deltas. Synchronous from the page's point of view: the lock
 *   is reported held the moment it is requested, since every event from
 *   then on carries deltas either way.
 * - `'none'` — no lock available (older shells, iPadOS). Flight works
 *   exactly as before: a captured drag looks while the right button is
 *   held, and the latched mode looks with a two-finger scroll.
 *
 * Pure of the Viewport: the element, the document, and the shell call are
 * injected, so the state machine is unit-tested without a browser.
 */

export type FlyCursorLockProvider = 'pointerlock' | 'shell' | 'none'

export interface FlyCursorLockEnv {
  isTauri: boolean
  isMac: boolean
  hasPointerLock: boolean
}

/** The provider for this environment. The macOS shell gets its own path
 * (see the module doc); every other shell and every browser uses the
 * standard API when it exists. */
export function chooseFlyCursorLockProvider(env: FlyCursorLockEnv): FlyCursorLockProvider {
  if (env.isTauri && env.isMac) return 'shell'
  return env.hasPointerLock ? 'pointerlock' : 'none'
}

/** The look delta for one pointer move: raw movement while locked (the
 * cursor is frozen, so a position difference would read zero), the
 * position difference otherwise (the proven captured-drag path; Playwright's
 * WebKit driver, for one, reports no movement on synthesized moves). */
export function flyLookDelta(
  locked: boolean,
  ev: { movementX: number; movementY: number; clientX: number; clientY: number },
  last: { x: number; y: number },
): { dx: number; dy: number } {
  if (locked) return { dx: ev.movementX, dy: ev.movementY }
  return { dx: ev.clientX - last.x, dy: ev.clientY - last.y }
}

export interface FlyCursorLockTarget {
  requestPointerLock?: () => unknown
}

export interface FlyCursorLockDocument {
  pointerLockElement: unknown
  exitPointerLock?: () => void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** The macOS shell call: lock (warping the cursor to the given SCREEN
 * point first — `screenX`/`screenY` CSS pixels, the one frame that already
 * accounts for WebKit's content inset under the title bar) or unlock. Resolves false when the shell does not handle
 * it (an older shell, another platform); rejects when the command is
 * missing entirely. */
export type FlyShellCursorLock = (locked: boolean, x: number, y: number) => Promise<boolean>

export interface FlyCursorLockOptions {
  provider: FlyCursorLockProvider
  target: FlyCursorLockTarget
  document: FlyCursorLockDocument
  shell: FlyShellCursorLock
  /** `unexpected` is true when the lock was lost while still wanted —
   * the browser took it away (Escape, focus loss) rather than `release`. */
  onChange: (locked: boolean, unexpected: boolean) => void
}

export interface FlyCursorLockRequest {
  /** True when the request runs inside a user gesture (a pointer press, a
   * key). A gesture-backed request the browser still denies means the API
   * is blocked for good (a sandbox, a policy), so the lock is marked
   * unavailable rather than asked for on every later click — which would
   * swallow every left click of a latched flight (review finding). A
   * request without a gesture (the native menu) may be denied for the
   * gesture's lack alone, and stays retryable. */
  gesture?: boolean
}

export class FlyCursorLock {
  private wanted = false
  private held = false
  private unavailable = false
  private gestureRequest = false
  /** The shell calls run strictly one after another (review finding): the
   * lock waits on a main-thread round trip before it freezes the cursor,
   * the unlock does not, and two independent invokes from a quick tap
   * could run unlock-then-lock and leave the cursor frozen and hidden with
   * nothing wanting it. The generation lets a result from a call that a
   * later call superseded be ignored. */
  private shellChain: Promise<unknown> = Promise.resolve()
  private shellGeneration = 0
  private readonly onPointerLockChange = (): void => this.syncFromDocument()
  private readonly onPointerLockError = (): void => {
    if (!this.wanted) return
    // A denied request — not a loss: nothing was held. Reported so the
    // hint can say how to try again.
    this.wanted = false
    if (this.gestureRequest) this.unavailable = true
    this.setHeld(false, false)
  }

  constructor(private readonly opts: FlyCursorLockOptions) {
    if (opts.provider === 'none') this.unavailable = true
  }

  /** True while the cursor is hidden and frozen. */
  get locked(): boolean {
    return this.held
  }

  /** True when a request could succeed: a provider exists and has not
   * failed permanently (a shell without the command). */
  get available(): boolean {
    return !this.unavailable
  }

  get provider(): FlyCursorLockProvider {
    return this.opts.provider
  }

  attach(): void {
    if (this.opts.provider !== 'pointerlock') return
    this.opts.document.addEventListener('pointerlockchange', this.onPointerLockChange)
    this.opts.document.addEventListener('pointerlockerror', this.onPointerLockError)
  }

  detach(): void {
    this.release()
    if (this.opts.provider !== 'pointerlock') return
    this.opts.document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.opts.document.removeEventListener('pointerlockerror', this.onPointerLockError)
  }

  /** Ask for the lock. `x`/`y` is the SCREEN point (`screenX`/`screenY`
   * CSS pixels) the hidden cursor should sit at: the press for a hold,
   * the view center for a latched flight. Only the shell provider reads
   * it. Idempotent while wanted. */
  request(x: number, y: number, req: FlyCursorLockRequest = {}): void {
    if (this.unavailable || this.wanted) return
    this.wanted = true
    this.gestureRequest = req.gesture === true
    if (this.opts.provider === 'shell') {
      this.setHeld(true, false)
      this.shellCall(true, x, y).then(
        (handled) => {
          if (!handled) this.failShell()
        },
        () => this.failShell(),
      )
      return
    }
    if (this.opts.document.pointerLockElement === this.opts.target) {
      this.setHeld(true, false)
      return
    }
    let result: unknown
    try {
      result = this.opts.target.requestPointerLock?.()
    } catch {
      this.onPointerLockError()
      return
    }
    // Chromium and Firefox return a promise; its rejection duplicates
    // `pointerlockerror`, which is the one path handled.
    if (typeof result === 'object' && result !== null && 'then' in result) {
      (result as Promise<unknown>).catch(() => { /* pointerlockerror reports it */ })
    }
  }

  release(): void {
    if (!this.wanted) return
    this.wanted = false
    if (this.opts.provider === 'shell') {
      this.setHeld(false, false)
      this.shellCall(false, 0, 0).catch(() => { /* already unavailable or gone */ })
      return
    }
    if (this.opts.document.pointerLockElement === this.opts.target) {
      this.opts.document.exitPointerLock?.()
    }
    // `pointerlockchange` will follow; report the release now so the hint
    // does not lag an event loop turn behind the visible cursor.
    this.setHeld(false, false)
  }

  /** One shell call in the chain. Resolves `true` for a call a later
   * call superseded, so its outcome is never acted on. */
  private shellCall(locked: boolean, x: number, y: number): Promise<boolean> {
    const generation = ++this.shellGeneration
    const call = this.shellChain.then(() => this.opts.shell(locked, x, y))
    this.shellChain = call.catch(() => undefined)
    return call.then(
      (handled) => generation !== this.shellGeneration || handled,
      (err: unknown) => {
        if (generation !== this.shellGeneration) return true
        throw err
      },
    )
  }

  /** The shell has no lock (an older shell without the command, a failed
   * step): not a loss the browser inflicted, so not `unexpected` — the
   * flight goes on with the visible cursor and never asks again. A
   * best-effort unlock first, in case a step applied before one failed. */
  private failShell(): void {
    if (this.unavailable) return
    this.unavailable = true
    this.wanted = false
    this.shellCall(false, 0, 0).catch(() => { /* nothing more to do */ })
    this.setHeld(false, false)
  }

  private syncFromDocument(): void {
    const now = this.opts.document.pointerLockElement === this.opts.target
    if (now && !this.wanted) {
      // Granted after the flight already let go (a quick tap releases
      // before the asynchronous grant lands; `exitPointerLock` on a
      // pending request is a no-op): give it straight back, never report
      // it held (review finding).
      this.opts.document.exitPointerLock?.()
      return
    }
    if (now === this.held) return
    if (!now && this.wanted) {
      // The browser took it away (Escape, focus loss). The lock is not
      // re-requested on its own: that needs a user gesture anyway.
      this.wanted = false
      this.setHeld(false, true)
      return
    }
    this.setHeld(now, false)
  }

  private setHeld(held: boolean, unexpected: boolean): void {
    if (held === this.held && !unexpected) return
    this.held = held
    this.opts.onChange(held, unexpected)
  }
}
