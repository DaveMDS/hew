/**
 * panicCapture — reads the in-memory record the wasm panic hook leaves on
 * `globalThis.__hewLastPanic` (crates/wasm-api/src/lib.rs's panic hook,
 * docs/dev/DIAGNOSTICS.md). A Rust panic poisons the wasm instance, so by the
 * time React's ErrorBoundary or a catch block sees the resulting
 * "recursive use of an object" throw, every `Scene` method (`save()`,
 * `state_hash()`, `take_recording()`) throws too — the hook is the last
 * point the panic message and the recorder's buffered calls can be read at
 * all, and it hands them straight to the page rather than through a `Scene`
 * call that would itself throw.
 *
 * In-memory only (unlike the `localStorage['hew:lastPanic']` companion
 * record, which is message-only and survives a reload): it does not survive
 * a reload, but it carries the recording a crash reproducer needs.
 */

/**
 * The page event the wasm panic hook fires once the capture is written.
 * ErrorBoundary listens for it to show the crash screen at once, since the
 * handler whose `Scene` call panicked usually catches the trap and carries on.
 */
export const KERNEL_PANIC_EVENT = 'hew:kernel-panic'

/** A panic capture as the wasm panic hook writes it to `globalThis.__hewLastPanic`. */
export interface PanicCapture {
  /** ISO timestamp of the panic. */
  at: string
  /** The panic message (`info.to_string()` — includes the source location). */
  message: string
  /**
   * Recording JSON (docs/dev/DIAGNOSTICS.md) captured from inside the
   * panicking frame, or null if nothing had been recorded yet. Its
   * `golden_hash` is always 0 — a panicking frame can't hash the document —
   * so treat it as a reproducer, never a regression oracle. Never
   * `JSON.parse` it: see sessionRecording.ts for why.
   */
  recording: string | null
}

/**
 * What the crash screen says about a kernel that stopped without a panic:
 * a wasm trap the panic hook never saw. The one that matters is the
 * out-of-memory abort while opening a file — Rust's allocation failure
 * runs no panic hook, so without this the page sees only "unreachable" and
 * then "recursive use of an object" on the next render.
 */
export interface KernelStop {
  /** The crash screen's heading, e.g. "This model is too large for Hew". */
  headline: string
  /** The explanation beneath it: what happened, what to do. */
  detail: string
}

let stop: KernelStop | null = null

/** The copy `recordKernelStop` left for the crash screen, or null when the
 *  kernel stopped on a panic (or has not stopped at all). */
export function getKernelStop(): KernelStop | null {
  return stop
}

/** Tests only: forget a recorded stop. */
export function clearKernelStop(): void {
  stop = null
}

/**
 * Record that the kernel stopped on a trap outside the panic hook's reach
 * and hand the page to the crash screen, writing the same capture the hook
 * writes (`__hewLastPanic`, `localStorage['hew:lastPanic']`, the page
 * event) so Report this crash and the record that survives a reload read
 * it the same way. There is no recording: a stopped kernel cannot be asked
 * for one. Does nothing when the hook already captured a panic on this
 * page — that capture, with its recording, is the better record, and the
 * crash screen is already up.
 */
export function recordKernelStop(message: string, copy: KernelStop): void {
  if (getPanicCapture() !== null) return
  const at = new Date().toISOString()
  stop = copy
  try {
    localStorage.setItem('hew:lastPanic', `${at}\n${message}`)
  } catch {
    /* ignore storage failures */
  }
  try {
    ;(globalThis as { __hewLastPanic?: PanicCapture }).__hewLastPanic = { at, message, recording: null }
  } catch {
    /* ignore */
  }
  try {
    globalThis.dispatchEvent(new Event(KERNEL_PANIC_EVENT))
  } catch {
    /* ignore */
  }
}

/**
 * Defensively read `globalThis.__hewLastPanic`, validating every field's
 * type. Never throws; returns null when the global is absent or malformed
 * rather than trusting a shape a future refactor of the hook might change
 * out from under this reader.
 */
export function getPanicCapture(): PanicCapture | null {
  try {
    const raw = (globalThis as { __hewLastPanic?: unknown }).__hewLastPanic
    if (raw === null || typeof raw !== 'object') return null
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.at !== 'string') return null
    if (typeof candidate.message !== 'string') return null
    if (candidate.recording !== null && typeof candidate.recording !== 'string') return null
    return { at: candidate.at, message: candidate.message, recording: candidate.recording }
  } catch {
    return null
  }
}
