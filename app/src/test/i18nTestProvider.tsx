/**
 * Test-time I18nProvider wrapper (see setup.ts).
 *
 * Components read text through `useLingui()` / `<Trans>`, which need an
 * `I18nProvider` above them — main.tsx supplies one for every window. Tests
 * render components in isolation, so setup.ts wraps every
 * `@testing-library/react` `render` in this provider with the real English
 * catalog active; a test that passes its own `wrapper` is nested inside it.
 */
import type { ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'

export function I18nTestProvider({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}
