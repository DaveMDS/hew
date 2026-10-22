/**
 * Locale-aware number formatting for text a person reads.
 *
 * Decimal and grouping separators come from the active locale through
 * `Intl.NumberFormat`; never `toFixed` on a user-facing number
 * (docs/LOCALIZATION.md). Length display keeps its own grammar in
 * settings/units.ts (feet-inch-fraction, unit suffixes) and calls here for
 * the decimal part.
 *
 * Formatters are cached per (locale, options) — `Intl.NumberFormat`
 * construction is the expensive part, and the Measurements box formats on
 * every pointer move.
 */

import { i18n } from '@lingui/core'
import { t } from '@lingui/core/macro'
import { SOURCE_LOCALE } from './locales'

const cache = new Map<string, Intl.NumberFormat>()

/** The BCP 47 tag `Intl` should format for. The pseudo-locale is not a real
 * tag, so it formats as the source locale. */
export function intlLocale(): string {
  const l = i18n.locale
  return l === '' || l.startsWith('pseudo') ? SOURCE_LOCALE : l
}

export interface FormatNumberOptions {
  /** Exact number of fraction digits (both min and max). */
  fractionDigits?: number
  /** Maximum fraction digits; trailing zeros are dropped. Ignored when
   * `fractionDigits` is set. */
  maxFractionDigits?: number
  /** Digit grouping (thousands separators). Default on. */
  grouping?: boolean
}

/** Format `value` for the active locale. */
export function formatNumber(value: number, opts: FormatNumberOptions = {}): string {
  const locale = intlLocale()
  const key = `${locale}|${opts.fractionDigits ?? ''}|${opts.maxFractionDigits ?? ''}|${opts.grouping ?? true}`
  let nf = cache.get(key)
  if (nf === undefined) {
    const init: Intl.NumberFormatOptions = { useGrouping: opts.grouping ?? true }
    if (opts.fractionDigits !== undefined) {
      init.minimumFractionDigits = opts.fractionDigits
      init.maximumFractionDigits = opts.fractionDigits
    } else if (opts.maxFractionDigits !== undefined) {
      init.maximumFractionDigits = opts.maxFractionDigits
    }
    nf = new Intl.NumberFormat(locale, init)
    cache.set(key, nf)
  }
  return nf.format(value)
}

const relativeCache = new Map<string, Intl.RelativeTimeFormat>()

/**
 * Short relative-time string for the active locale ("just now", "2 minutes
 * ago", "3 hours ago"), falling back to a locale date string beyond ~24h.
 * `nextRelativeTimeBoundary` (io/relativeTime.ts) mirrors this function's
 * bucket boundaries.
 */
export function formatRelativeTime(atMs: number, now: number): string {
  const deltaMs = Math.max(0, now - atMs)
  const deltaSec = Math.floor(deltaMs / 1000)

  if (deltaSec < 45) return t`just now`

  const locale = intlLocale()
  let rtf = relativeCache.get(locale)
  if (rtf === undefined) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' })
    relativeCache.set(locale, rtf)
  }

  // Round (rather than floor) so e.g. 45s reads as "1 minute ago" instead of
  // "0 minutes ago" — the 45s "just now" cutoff implies the next bucket up.
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return rtf.format(-deltaMin, 'minute')

  const deltaHour = Math.round(deltaSec / 3600)
  if (deltaHour < 24) return rtf.format(-deltaHour, 'hour')

  return new Date(atMs).toLocaleString(locale)
}
