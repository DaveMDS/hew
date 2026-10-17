/**
 * failedOpen — keeps the file behind the most recent open or import that did
 * not land, so Help ▸ Report Bug and the crash screen's "Report this crash"
 * can send the file itself (reportBundle.ts's `failedFile` row).
 *
 * The session recording can't carry it: a recorded step is written only once
 * its call succeeds, an out-of-memory abort never runs the panic hook that
 * hands the recording over, and the recording embeds at most 64 MB of a file.
 * The file the user picked is still in hand on this side of the kernel,
 * whatever happened inside it, so it is kept here instead.
 *
 * An attempt is noted before the kernel sees the file and cleared once the
 * document lands. Until then it stays: a refusal marks it with the error, and
 * a trap that kills the kernel mid-open leaves it in place with no error at
 * all, which is itself the clue ("Hew stopped while opening it"). Only the
 * latest attempt is kept, and any document that replaces the one it failed
 * in (New, a `.hew` open, a later open or import that lands) drops it, so a
 * report about something else never carries it and its memory is let go.
 *
 * Module state, like the diagnostic log: it outlives the app tree, so the
 * crash screen's report can still read it after React has unmounted the app.
 */

export interface FailedOpen {
  /** The file's own name (no folder), as the user picked or dropped it. */
  name: string
  /** What kind of file it is, for the report preview, e.g.
   *  "SketchUp model (.skp)". */
  label: string
  /** The file, byte for byte. */
  bytes: Uint8Array
  /** The error the open or import ended with, or null when Hew stopped
   *  before it could report one (a kernel trap mid-open). */
  error: string | null
}

let current: FailedOpen | null = null

/** Note an open or import about to start, replacing any earlier one. Call it
 *  before the kernel sees the file, so a trap mid-open leaves it noted. */
export function beginOpenAttempt(file: { name: string; label: string; bytes: Uint8Array }): void {
  current = { name: file.name, label: file.label, bytes: file.bytes, error: null }
}

/** The attempt ended with `error`: keep the file for a report. */
export function openAttemptFailed(error: string): void {
  if (current !== null) current = { ...current, error }
}

/** The attempt landed, or stopped for a reason that is not the file's (the
 *  user cancelled, the app could not reset the document): nothing to report. */
export function clearOpenAttempt(): void {
  current = null
}

/** A new document replaced the one a failure happened in: forget that
 *  failure. An attempt still under way is kept, since an open loads a blank
 *  document of its own partway through. */
export function forgetSettledFailure(): void {
  if (current !== null && current.error !== null) current = null
}

/** The file behind the latest attempt that did not land, or null. */
export function getFailedOpen(): FailedOpen | null {
  return current
}
