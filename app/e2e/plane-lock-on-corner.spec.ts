import { test, expect, type Page } from '@playwright/test'

/**
 * GitHub #51: a shape started on a box's corner must still reach the
 * ground with the Up arrow.
 *
 * Two boxes touch on the plane y = 0.0714; the thin one has a corner at
 * the origin, where its x = 0, y = 0 and bottom faces meet. Unlocked, a
 * click on that corner anchors on the wall facing the camera (y = 0, the
 * green plane). The arrow lock wins over that pick whether it is pressed
 * before the first click or after it: either way the shape lands on the
 * ground through the corner. Real pointer and key events throughout.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

type V3 = [number, number, number]

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.setCamera({ position: [-1.2, -1.6, 1.0], target: [0.4, 0.3, 0.1], up: [0, 0, 1], fovDeg: 50 })
    h.drawBox([0, 0, 0], [1, 0.0714, 0], 0.1826)
    h.drawBox([0.5001, 0.0714, 0], [1.2, 0.8, 0], 0.5)
  })
  await page.waitForTimeout(200)
}

async function toPage(page: Page, w: V3): Promise<{ x: number; y: number }> {
  const canvas = await page.locator('canvas').first().boundingBox()
  if (canvas === null) throw new Error('no canvas')
  const p = await page.evaluate((world) => window.__hew_test!.worldToScreen(world as V3), w)
  return { x: canvas.x + p.x, y: canvas.y + p.y }
}

/** Hover `w` the way a hand arrives (a few moves, so the snap resolves). */
async function hover(page: Page, w: V3): Promise<void> {
  const p = await toPage(page, w)
  await page.mouse.move(p.x + 4, p.y + 4)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.waitForTimeout(80)
}

async function press(page: Page): Promise<void> {
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(80)
}

const TOOLS: { name: string; pick: (p: Page) => Promise<void>; rest: V3[] }[] = [
  { name: 'Rectangle', pick: (p) => p.keyboard.press('r'), rest: [[0.5, -0.4, 0]] },
  { name: 'Circle', pick: (p) => p.keyboard.press('c'), rest: [[0.3, -0.3, 0]] },
  {
    name: 'Polygon',
    pick: (p) => p.getByRole('radiogroup', { name: 'Tools' }).getByRole('radio', { name: 'Polygon' }).click(),
    rest: [[0.3, -0.3, 0]],
  },
  { name: 'Arc', pick: (p) => p.keyboard.press('a'), rest: [[0.5, -0.4, 0], [0.3, -0.45, 0]] },
]

for (const tool of TOOLS) {
  for (const when of ['before', 'after'] as const) {
    test(`${tool.name}: Up ${when} the first click on the origin corner draws on the ground`, async ({ page }) => {
      await setup(page)
      await tool.pick(page)
      await hover(page, [0, 0, 0])
      if (when === 'before') await page.keyboard.press('ArrowUp')
      await press(page)
      if (when === 'after') await page.keyboard.press('ArrowUp')
      for (const w of tool.rest) {
        await hover(page, w)
        await press(page)
      }

      const result = await page.evaluate(() => {
        const h = window.__hew_test!
        return { planes: h.getSketchIds().map((id) => h.getSketchPlane(id)), error: h.getLastError() }
      })
      expect(result.error).toBeNull()
      expect(result.planes).toHaveLength(1)
      const plane = result.planes[0]!
      expect(plane[2]).toBeCloseTo(0, 9) // through z = 0
      expect(Math.abs(plane[5])).toBeCloseTo(1, 9) // normal along blue
    })
  }
}
