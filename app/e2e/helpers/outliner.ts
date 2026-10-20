import type { Locator, Page } from '@playwright/test'

/**
 * The Outliner's "editing" chips — one per node on the combined session-stack
 * path. The viewport's selection-path strip repeats each open frame's chip
 * (docs/design/selection-path.md), so an unscoped exact-text match counts both;
 * these specs assert the Outliner's own chips and exclude the strip's.
 */
export function outlinerEditingChips(page: Page): Locator {
  return page.locator(':text-is("editing"):not([data-testid="selection-path"] *)')
}
