/**
 * A typed `W,D` right after the first click on a wall grows the rectangle
 * right and up as it reads on screen — driven here with REAL pointer and key
 * events on the FRONT (y = 0) face of a box, the face whose basis axes point
 * the width toward −X. Clicking a guide intersection leaves the cursor
 * exactly on the anchor, so the typed pair has no heading to follow; before
 * the fix it grew left, off the face, and was refused LoopNotStrictlyInside.
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

async function pagePoint(page: Page, w: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  return { x: box.x + p.x, y: box.y + p.y }
}

test('typing 9.4mm,3.8mm after clicking a guide intersection on the front face stays on the face', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  const object = await page.evaluate(() => {
    const h = window.__hew_test!
    const id = h.drawBox([0, 0, 0], [0.022, 0.0275, 0], 0.007)
    // Looking straight at the y = 0 wall from the front.
    h.setCamera({ position: [0.011, -0.05, 0.0035], target: [0.011, 0, 0.0035], up: [0, 0, 1], fovDeg: 45 })
    h.addGuideLine(0.0063, 0, 0.0035, 0, 0, 1) // x = 6.3 mm
    h.addGuideLine(0.011, 0, 0.0022, 1, 0, 0) // z = 2.2 mm
    return id
  })
  await page.waitForTimeout(200)

  await page.getByRole('radio', { name: 'Rectangle' }).click()
  const at = await pagePoint(page, [0.0063, 0, 0.0022])
  await page.mouse.move(at.x - 4, at.y + 3)
  await page.waitForTimeout(80)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(150)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(150)
  await page.keyboard.type('9.4mm,3.8mm')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)

  const list = await page.evaluate((o) => window.__hew_test!.getImprints(o), object)
  expect(list.length).toBe(1)
  const xs = list[0].loop.map((p) => p[0])
  const zs = list[0].loop.map((p) => p[2])
  // Snapped to the guide intersection, so the corner is exact; the far corner
  // is 9.4 mm right and 3.8 mm up from it.
  expect(Math.min(...xs)).toBeCloseTo(0.0063, 5)
  expect(Math.max(...xs)).toBeCloseTo(0.0157, 5)
  expect(Math.min(...zs)).toBeCloseTo(0.0022, 5)
  expect(Math.max(...zs)).toBeCloseTo(0.006, 5)
})
