import { test, expect } from '@playwright/test'

/**
 * The session label of an unnamed group is its real place among its
 * siblings, as the Outliner numbers it: opening the second of two unnamed
 * groups reads "Group 2", in the Outliner breadcrumb and in the viewport's
 * selection-path strip alike (it used to read "Group 1" for every group).
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test('opening the second of two unnamed groups reads "Group 2" everywhere', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })

  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const a = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const b = h.drawBox([3, 0, 0], [4, 1, 0], 1)
    const ga = h.groupNodes([{ kind: 'object', id: a }])
    const gb = h.groupNodes([{ kind: 'object', id: b }])
    h.selectNodes([{ kind: 'group', id: gb }])
    return { ga, gb }
  })

  const tray = page.getByLabel('Tray', { exact: true })
  await tray.getByText('Group 2', { exact: true }).first().dblclick()
  await page.waitForTimeout(250)

  // The kernel opened a session on the second group (it is hidden now).
  expect(await page.evaluate((g) => window.__hew_test!.getGroupMembers(g), ids.gb)).toEqual([])
  expect(await page.evaluate((g) => window.__hew_test!.getGroupMembers(g).length, ids.ga)).toBe(1)

  // Outliner breadcrumb: Model > Group 2.
  await expect(tray.getByText('Group 2', { exact: true }).first()).toBeVisible()
  await expect(tray.getByText('Group 1', { exact: true })).toHaveCount(0)
  // Viewport selection-path strip agrees.
  const strip = page.getByTestId('selection-path')
  await expect(strip.getByText('Group 2', { exact: true }).first()).toBeVisible()
  await expect(strip.getByText('Group 1', { exact: true })).toHaveCount(0)

  await page.keyboard.press('Escape')
})
