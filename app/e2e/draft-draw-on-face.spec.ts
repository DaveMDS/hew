/**
 * Unified drafting, drawing on a solid's face with REAL pointer events: the
 * plane is the drafting context, so a loose Line segment on a box top is a
 * valid edit (no more "must reach an edge"), and a Rectangle drawn half over
 * the top's edge leaves a pushable face part AND an extrudable free part —
 * all as undoable steps.
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

async function click(page: Page, w: [number, number, number]): Promise<void> {
  const at = await pagePoint(page, w)
  await page.mouse.move(at.x - 3, at.y + 2)
  await page.waitForTimeout(60)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(120)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(120)
}

/** Total length of every live sketch segment, and how many segments exist. */
async function sketchTotals(page: Page): Promise<{ segments: number; length: number }> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    let segments = 0
    let length = 0
    for (const id of h.getSketchIds()) {
      for (const s of h.getSketchSegmentsExact(id)) {
        segments += 1
        length += Math.hypot(s[3] - s[0], s[4] - s[1], s[5] - s[2])
      }
    }
    return { segments, length }
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.setGridVisible(false)
    h.setAxesVisible(false)
    h.drawBox([0, 0, 0], [1, 1, 0], 0.5)
    // Straight down onto the top face (z = 0.5).
    h.setCamera({ position: [0.5, 0.5, 4], target: [0.5, 0.5, 0.5], up: [0, 1, 0], fovDeg: 45 })
  })
  await page.waitForTimeout(250)
})

test('a loose Line segment on a box top commits and survives undo/redo', async ({ page }) => {
  await page.getByRole('radio', { name: 'Line' }).click()
  expect(await sketchTotals(page)).toEqual({ segments: 0, length: 0 })

  await click(page, [0.25, 0.4, 0.5])
  await click(page, [0.75, 0.4, 0.5])
  await page.keyboard.press('Escape') // finish the chain; nothing is pending

  const drawn = await sketchTotals(page)
  expect(drawn.segments).toBe(1)
  expect(drawn.length).toBeCloseTo(0.5, 2)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()

  await page.evaluate(() => window.__hew_test!.undo())
  expect((await sketchTotals(page)).segments).toBe(0)
  await page.evaluate(() => window.__hew_test!.redo())
  const back = await sketchTotals(page)
  expect(back.segments).toBe(1)
  expect(back.length).toBeCloseTo(drawn.length, 9)
})

test('a Rectangle drawn half over the top edge leaves a pushable face part and an extrudable free part', async ({ page }) => {
  const object = (await page.evaluate(() => window.__hew_test!.getObjectIds()))[0]
  await page.getByRole('radio', { name: 'Rectangle' }).click()
  await click(page, [0.5, 0.25, 0.5])
  await click(page, [1.5, 0.75, 0.5]) // the far corner is off the face
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()

  // The part over the face is its own pushable face...
  const inside = await page.evaluate(() => window.__hew_test!.pickFace([0.75, 0.5, 4], [0, 0, -1]))
  const outsideOfRect = await page.evaluate(() => window.__hew_test!.pickFace([0.1, 0.1, 4], [0, 0, -1]))
  expect(inside).not.toBeNull()
  expect(outsideOfRect).not.toBeNull()
  expect(inside!.face).not.toBe(outsideOfRect!.face)
  await page.evaluate(
    ([o, f]) => window.__hew_test!.pushPull(o, f, 0.2),
    [inside!.object, inside!.face],
  )
  const bounds = await page.evaluate((o) => window.__hew_test!.getObjectBounds(o), object)
  expect(bounds[5]).toBeCloseTo(0.7, 6) // the face part rose; the rest of the top did not
  await page.evaluate(() => window.__hew_test!.undo())

  // ...and the overhang is a free region, closed against the box's edge,
  // that extrudes into a new object.
  const free = await page.evaluate(() => {
    const h = window.__hew_test!
    for (const id of h.getSketchIds()) {
      const regions = h.getSketchRegionIds(id)
      if (regions.length > 0) return { sketch: id, region: regions[0] }
    }
    return null
  })
  expect(free).not.toBeNull()
  const before = await page.evaluate(() => window.__hew_test!.getObjectCount())
  await page.evaluate(
    ([s, r]) => window.__hew_test!.extrudeRegion(s, r, 0.3),
    [free!.sketch, free!.region],
  )
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(before + 1)
})
