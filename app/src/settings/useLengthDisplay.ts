/** React binding for the length display settings (format AND precision). */
import { useEffect, useState } from 'react'
import { getLengthUnit, getPrecision, subscribe, type LengthFormat, type Precision } from './units'

export interface LengthDisplay {
  format: LengthFormat
  precision: Precision
}

/**
 * The current length format and the saved precision for that format.
 * Re-renders on either change, local or from another window. Precision
 * changes notify with an unchanged format, so a bare `useState(format)`
 * subscriber would bail out and leave its readouts stale.
 */
export function useLengthDisplay(): LengthDisplay {
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [])
  return { format: getLengthUnit(), precision: getPrecision() }
}
