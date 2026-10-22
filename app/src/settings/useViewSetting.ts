/** React binding for a View setting singleton (settings/view.ts). */
import { useEffect, useState } from 'react'

export function useViewSetting<T>(get: () => T, subscribe: (cb: (value: T) => void) => () => void): T {
  const [value, setValue] = useState<T>(get)
  useEffect(() => {
    setValue(get())
    return subscribe(setValue)
  }, [get, subscribe])
  return value
}
