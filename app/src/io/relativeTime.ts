/**
 * Relative-time helpers for the "Edited/Saved <relative time>" indicator
 * (`02_app_shell.md`) and the recovery prompt. `formatRelativeTime` lives in
 * `i18n/format.ts` (locale-aware via `Intl.RelativeTimeFormat`) and is
 * re-exported here for the existing call sites; recoveryStore.ts re-exports it
 * as `formatRecoveryTime`.
 */
export { formatRelativeTime } from '../i18n/format'

/**
 * Earliest epoch ms strictly after `now` at which `formatRelativeTime(atMs,
 * ·)`'s return value would actually change — the exact boundary of whichever
 * bucket `formatRelativeTime` is currently reporting (mirrors its own
 * branching: the 45s "just now" cutoff, then each rounded-minute/rounded-hour
 * bucket's half-width). `null` once the label has settled on the fixed
 * `toLocaleString()` form (24h+), which never changes again on its own.
 *
 * Lets a caller (App.tsx's save-state indicator) schedule exactly one timer
 * at the next moment the visible text would differ, instead of polling on a
 * fixed interval regardless of whether anything is about to change (Lane F,
 * "Render loop on demand" — the same on-demand principle applied to a
 * non-rAF timer).
 */
export function nextRelativeTimeBoundary(atMs: number, now: number): number | null {
  const deltaSec = Math.max(0, now - atMs) / 1000
  if (deltaSec < 45) return atMs + 45_000
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return atMs + (deltaMin + 0.5) * 60_000
  const deltaHour = Math.round(deltaSec / 3600)
  if (deltaHour < 24) return atMs + (deltaHour + 0.5) * 3_600_000
  return null
}
