/**
 * The Eraser: hovering highlights what a click would erase, without
 * touching the selection; a press clears the selection and selects what the
 * stroke touches as it goes; the release erases all of it in one undo step;
 * Escape mid-stroke abandons it. Driven with real pointer and key events;
 * the harness only builds the scene, pins the camera, and reads kernel
 * state back.
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

type V3 = [number, number, number]

async function pagePoint(page: Page, w: V3): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  return { x: box.x + p.x, y: box.y + p.y }
}

/** Bring the pointer to rest over a world point. */
async function hoverAt(page: Page, w: V3): Promise<void> {
  const at = await pagePoint(page, w)
  await page.mouse.move(at.x - 3, at.y + 2)
  await page.waitForTimeout(60)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(150)
}

async function click(page: Page, w: V3): Promise<void> {
  await hoverAt(page, w)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(150)
}

/** Press over `from`, then drag through each of `through` in turn, button
 *  still down. */
async function pressAndDrag(page: Page, from: V3, through: V3[]): Promise<void> {
  await hoverAt(page, from)
  await page.mouse.down()
  for (const w of through) {
    const at = await pagePoint(page, w)
    await page.mouse.move(at.x, at.y, { steps: 12 })
  }
  await page.waitForTimeout(100)
}

/** Top-down view over a unit box at the origin, a guide line on each side
 *  of it (x = 3 and x = -2, along Y), and a ground dimension below it. */
async function boot(page: Page): Promise<{ box: string; right: string; left: string; dim: string }> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    h.setGridVisible(false)
    h.setAxesVisible(false)
    const box = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const right = h.addGuideLine(3, 0, 0, 0, 1, 0)
    const left = h.addGuideLine(-2, 0, 0, 0, 1, 0)
    const dim = h.addLinearDimension([0, -2, 0], [1, -2, 0], [0, -0.5, 0], [0, 0, 0, 0, 0, 1])
    h.setCamera({ position: [0.5, 0, 12], target: [0.5, 0, 0], up: [0, 1, 0], fovDeg: 45 })
    return { box, right, left, dim }
  })
  await page.getByRole('radio', { name: 'Select' }).click()
  await page.waitForTimeout(100)
  return ids
}

async function chooseEraser(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Eraser' }).click()
  await page.waitForTimeout(100)
}

const hovered = (page: Page) => page.evaluate(() => window.__hew_test!.getHoverHighlight())
const selection = (page: Page) => page.evaluate(() => window.__hew_test!.getSelection().map((n) => n.id))
const count = (page: Page, n: number) => page.getByText(`${n} selected`, { exact: true })
const live = (page: Page) =>
  page.evaluate(() => {
    const h = window.__hew_test!
    return { objects: h.getObjectIds(), guides: h.getGuideIds(), annotations: h.getAnnotationIds() }
  })

test('hovering highlights what a click would erase, and leaves the selection alone', async ({ page }) => {
  const { box, right, dim } = await boot(page)
  await chooseEraser(page)

  await hoverAt(page, [0.5, 0.5, 1])
  await expect.poll(async () => (await hovered(page))?.objects).toEqual([box])
  await hoverAt(page, [3, 0.5, 0])
  await expect.poll(async () => (await hovered(page))?.guide).toBe(right)
  await hoverAt(page, [0.5, -2.5, 0])
  await expect.poll(async () => (await hovered(page))?.annotation).toBe(dim)
  await hoverAt(page, [-4, 2, 0])
  await expect.poll(() => hovered(page)).toBeNull()

  expect(await selection(page)).toEqual([])
  expect((await live(page)).objects).toContain(box)
})

test('a click erases what it hits, and one undo brings it back', async ({ page }) => {
  const { box, dim } = await boot(page)
  await chooseEraser(page)

  await click(page, [0.5, 0.5, 1])
  expect((await live(page)).objects).not.toContain(box)
  expect(await selection(page)).toEqual([])

  await click(page, [0.5, -2.5, 0])
  expect((await live(page)).annotations).not.toContain(dim)

  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  expect((await live(page)).annotations).toContain(dim)
  expect((await live(page)).objects).not.toContain(box)
})

test('a drag selects what it crosses, erases it all on release, and one undo brings it all back', async ({ page }) => {
  const { box, right, left, dim } = await boot(page)
  await chooseEraser(page)

  // Left guide, across the box, to the right guide.
  await pressAndDrag(page, [-2, 0.5, 0], [[0.5, 0.5, 1], [3, 0.5, 0]])
  // Mid-stroke: everything touched so far is the selection.
  await expect(count(page, 3)).toBeVisible()
  expect(await selection(page)).toEqual([box])
  expect((await live(page)).objects).toContain(box)

  await page.mouse.up()
  await page.waitForTimeout(150)
  const after = await live(page)
  expect(after.objects).not.toContain(box)
  expect(after.guides).not.toContain(left)
  expect(after.guides).not.toContain(right)
  expect(after.annotations).toEqual([dim])
  expect(await selection(page)).toEqual([])

  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  const undone = await live(page)
  expect(undone.objects).toContain(box)
  expect(undone.guides).toContain(left)
  expect(undone.guides).toContain(right)
})

test('Escape mid-drag deselects what the stroke touched and erases nothing', async ({ page }) => {
  const { box, right } = await boot(page)
  await chooseEraser(page)

  await pressAndDrag(page, [0.5, 0.5, 1], [[3, 0.5, 0]])
  await expect(count(page, 2)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  expect(await selection(page)).toEqual([])
  await expect(count(page, 2)).toHaveCount(0)

  await page.mouse.up()
  await page.waitForTimeout(150)
  const after = await live(page)
  expect(after.objects).toContain(box)
  expect(after.guides).toContain(right)
})

test('a selection made before the Eraser is dropped at the first press, not erased', async ({ page }) => {
  const { box, right } = await boot(page)

  await click(page, [3, 0.5, 0])
  await expect(page.getByText('Guide line', { exact: true })).toBeVisible()
  await chooseEraser(page)

  await click(page, [0.5, 0.5, 1])
  const after = await live(page)
  expect(after.objects).not.toContain(box)
  expect(after.guides).toContain(right)
  await expect(page.getByText('Guide line', { exact: true })).toHaveCount(0)
})
