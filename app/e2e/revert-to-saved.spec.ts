import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * File ▸ Revert to Saved, end to end with the real kernel: open a file
 * through the picker (so the document has a file handle to read back), edit
 * it, then revert through the real menu and confirm dialog. The edit goes
 * away, the document reads clean, and both history stacks are empty.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

const bytes = Array.from(readFileSync(resolve(process.cwd(), 'public/samples/wall-clock.hew')))

async function armFilePicker(page: Page): Promise<void> {
  await page.addInitScript((b) => {
    const buf = new Uint8Array(b as number[])
    // @ts-expect-error test override of the File System Access API
    window.showOpenFilePicker = async () => [
      {
        getFile: async () => ({ name: 'wall-clock.hew', arrayBuffer: async () => buf.buffer.slice(0) }),
      },
    ]
  }, bytes)
  await page.reload()
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
}

test('Revert to Saved puts the saved file back, clean, with no undo or redo', async ({ page }) => {
  await page.goto('/')
  await armFilePicker(page)

  const file = page.getByTestId('menu-bar').getByRole('button', { name: 'File' })
  await file.click()
  await page.getByText('Open…', { exact: true }).click()
  await page.waitForFunction(() => (window.__hew_test?.getObjectCount() ?? 0) > 0, null, { timeout: 15_000 })
  await expect(page).toHaveTitle(/^wall-clock\.hew — Hew$/)
  const savedCount = await page.evaluate(() => window.__hew_test!.getObjectCount())

  // Real edits: one more object, a tag on it, then undo the tag, so both
  // stacks have something on them when the revert comes.
  const box = await page.evaluate(() => window.__hew_test!.drawBox([40, 40, 0], [41, 41, 0], 1))
  await expect(page).toHaveTitle(/^• wall-clock\.hew — Hew$/)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(savedCount + 1)
  await page.evaluate((id) => window.__hew_test!.addNodeTag('object', id, ['x']), box)
  await page.evaluate(() => window.__hew_test!.undo())
  expect(await page.evaluate(() => window.__hew_test!.canUndo())).toBe(true)
  expect(await page.evaluate(() => window.__hew_test!.canRedo())).toBe(true)
  await expect(page).toHaveTitle(/^• wall-clock\.hew — Hew$/)

  // Cancel is the default button: Enter on the dialog changes nothing.
  await file.click()
  await page.getByText('Revert to Saved', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Revert to Saved?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveTitle(/^• wall-clock\.hew — Hew$/)

  await file.click()
  await page.getByText('Revert to Saved', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Revert' }).click()

  await expect(page.getByText('Reverted to the saved file.')).toBeVisible()
  await expect(page).toHaveTitle(/^wall-clock\.hew — Hew$/)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(savedCount)
  expect(await page.evaluate(() => window.__hew_test!.canUndo())).toBe(false)
  expect(await page.evaluate(() => window.__hew_test!.canRedo())).toBe(false)

  // Clean again, so Revert has nothing to do.
  await file.click()
  await page.getByText('Revert to Saved', { exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('reverting a SketchUp file keeps the camera and does not reopen the report', async ({ page }) => {
  const skp = Array.from(readFileSync(resolve(process.cwd(), 'e2e/fixtures/skp/2026/box.skp')))
  await page.addInitScript((b) => {
    const buf = new Uint8Array(b as number[])
    // @ts-expect-error test override of the File System Access API
    window.showOpenFilePicker = async () => [
      {
        kind: 'file',
        name: 'box.skp',
        getFile: async () => ({ name: 'box.skp', arrayBuffer: async () => buf.buffer.slice(0) }),
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
      },
    ]
  }, skp)
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 20_000 })

  const file = page.getByTestId('menu-bar').getByRole('button', { name: 'File' })
  await file.click()
  await page.getByText('Open…', { exact: true }).click()
  const report = page.getByRole('dialog', { name: /open report/i })
  await expect(report).toBeVisible({ timeout: 20_000 })
  await report.getByRole('button', { name: 'OK' }).click()
  await expect(page).toHaveTitle(/^box\.skp — Hew$/)

  // A camera the open's zoom-to-fit would never pick, then an edit.
  const pose = { position: [30, -40, 25] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovDeg: 45 }
  await page.evaluate((p) => window.__hew_test!.setCamera(p), pose)
  const before = await page.evaluate(() => window.__hew_test!.getCamera())
  await page.evaluate(() => window.__hew_test!.drawBox([40, 40, 0], [41, 41, 0], 1))
  await expect(page).toHaveTitle(/^• box\.skp — Hew$/)

  await file.click()
  await page.getByText('Revert to Saved', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Revert to Saved?' }).getByRole('button', { name: 'Revert' }).click()
  await expect(page.getByText('Reverted to the saved file.')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveTitle(/^box\.skp — Hew$/)
  await expect(report).toHaveCount(0)
  const after = await page.evaluate(() => window.__hew_test!.getCamera())
  for (let i = 0; i < 3; i++) {
    expect(after.position[i]).toBeCloseTo(before.position[i]!, 3)
    expect(after.target[i]).toBeCloseTo(before.target[i]!, 3)
  }
})
