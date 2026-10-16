/**
 * Recovers the left-button press a browser reports as a move.
 *
 * When the window manager takes over a press — the title bar's window move
 * or a resize grip (`TitleBar.tsx`) — the matching release goes to the
 * window manager, never to the page. WebKitGTK then still counts the left
 * button as held, so the NEXT real press arrives as a chorded
 * `pointermove` (`button` 0, `buttons` 1) instead of a `pointerdown`. Its
 * `mousedown`, `pointerup`, and `click` still fire. Every press-driven
 * surface (the viewport's tools above all) missed that first click.
 *
 * Under the Pointer Events spec a mouse `pointermove` with `button` 0 and
 * `buttons` exactly 1 cannot happen: a left press with no other button
 * down is always a `pointerdown`, and a chorded left press leaves another
 * bit set in `buttons`. So the move is swallowed and the `pointerdown` the
 * browser owed is dispatched in its place, on the same target.
 */
export function strandedPressAsPointerDown(ev: PointerEvent): PointerEvent | null {
  if (ev.type !== 'pointermove' || ev.pointerType !== 'mouse') return null
  if (ev.button !== 0 || ev.buttons !== 1) return null
  return new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: ev.view,
    detail: 1,
    screenX: ev.screenX,
    screenY: ev.screenY,
    clientX: ev.clientX,
    clientY: ev.clientY,
    ctrlKey: ev.ctrlKey,
    shiftKey: ev.shiftKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    button: 0,
    buttons: 1,
    relatedTarget: null,
    pointerId: ev.pointerId,
    width: ev.width,
    height: ev.height,
    pressure: 0.5,
    tiltX: ev.tiltX,
    tiltY: ev.tiltY,
    pointerType: 'mouse',
    isPrimary: ev.isPrimary,
  })
}

/** Installs the recovery on `win` (capture phase, ahead of every other
 * listener). One recovered press at a time: until its release, a further
 * such move passes through untouched, so an engine that misreports drag
 * moves can't turn one drag into a stream of presses. The latch also resets
 * on a real pointerdown and on window blur, so a release that never reaches
 * the page cannot leave the next stranded press unrecovered. Returns the
 * uninstaller. */
export function installStrandedPressFix(win: Window): () => void {
  let recovered = false
  let dispatching = false
  const onMove = (ev: PointerEvent) => {
    if (recovered) return
    const down = strandedPressAsPointerDown(ev)
    if (down === null || ev.target === null) return
    recovered = true
    ev.stopImmediatePropagation()
    dispatching = true
    ev.target.dispatchEvent(down)
    dispatching = false
  }
  // The synthesized pointerdown passes through here too; only a real press
  // means the earlier release was lost, so only that one resets the latch.
  const onDown = () => {
    if (!dispatching) recovered = false
  }
  const onEnd = () => { recovered = false }
  win.addEventListener('pointermove', onMove, true)
  win.addEventListener('pointerdown', onDown, true)
  win.addEventListener('pointerup', onEnd, true)
  win.addEventListener('pointercancel', onEnd, true)
  // Bubble phase, so only a blur of the window itself arrives here; a capture
  // listener would also see every focused element's blur.
  win.addEventListener('blur', onEnd)
  return () => {
    win.removeEventListener('pointermove', onMove, true)
    win.removeEventListener('pointerdown', onDown, true)
    win.removeEventListener('pointerup', onEnd, true)
    win.removeEventListener('pointercancel', onEnd, true)
    win.removeEventListener('blur', onEnd)
  }
}
