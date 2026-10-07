/**
 * Unified drafting, selecting and editing what is drawn, with REAL pointer
 * and keyboard events: the drawing on a plane is one set of units, so a
 * rectangle drawn on a box top selects by clicking its fill, moves half off
 * the top's edge as ONE selected shape (the face part is a pushable face, the
 * overhang an extrudable free region), and undoes and redoes; a line on a face
 * deletes with the Delete key.
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

async function moveTo(page: Page, w: [number, number, number]): Promise<void> {
  const at = await pagePoint(page, w)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(80)
}

const TOP = 0.5

/** The units listed on the box top's plane, with how many edges of each store. */
async function topUnits(page: Page): Promise<{ key: string; topology: number; free: number; owned: number }[]> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    const ctx = h.ctxOfPlane([0, 0, 0.5], [0, 0, 1])!
    return h.getPlaneUnits(ctx).units.map((u) => ({
      key: u.key,
      topology: u.edges.filter((e) => e.store.kind === 'topology').length,
      free: u.edges.filter((e) => e.store.kind === 'free').length,
      owned: u.edges.filter((e) => e.store.kind === 'owned').length,
    }))
  })
}

async function selection(page: Page): Promise<{ kind: string; ctx?: string; key?: string }[]> {
  return page.evaluate(() => window.__hew_test!.getSelection())
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

test('select a rectangle on a box top by its fill, move it half off the edge as one shape, undo and redo', async ({ page }) => {
  // Draw the rectangle with the real Rectangle tool.
  await page.getByRole('radio', { name: 'Rectangle' }).click()
  await click(page, [0.3, 0.3, TOP])
  await click(page, [0.6, 0.6, TOP])
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
  const drawn = await topUnits(page)
  expect(drawn).toHaveLength(1)
  expect(drawn[0].topology).toBe(4)

  // Select it by clicking its FILL (not its outline).
  await page.getByRole('radio', { name: 'Select' }).click()
  await click(page, [0.45, 0.45, TOP])
  let sel = await selection(page)
  expect(sel).toHaveLength(1)
  expect(sel[0].kind).toBe('draft-island')
  expect(sel[0].key).toBe(drawn[0].key)

  // Move it +0.55 in X: half of it (x from 1.0 to 1.15) hangs off the top.
  await page.keyboard.press('m')
  await click(page, [0.45, 0.45, TOP])
  await page.keyboard.press('ArrowRight') // lock the X axis
  await moveTo(page, [1.0, 0.45, TOP])
  await page.keyboard.type('0.55')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()

  // Still ONE shape, and still the selection; it mixes face edges and free ones.
  const moved = await topUnits(page)
  expect(moved).toHaveLength(1)
  expect(moved[0].topology).toBeGreaterThan(0)
  expect(moved[0].free).toBeGreaterThan(0)
  sel = await selection(page)
  expect(sel).toHaveLength(1)
  expect(sel[0].kind).toBe('draft-island')
  expect(sel[0].key).toBe(moved[0].key)

  // The face part is a face (pushable); the overhang is an extrudable free region.
  const regions = await page.evaluate(() => {
    const h = window.__hew_test!
    const ctx = h.ctxOfPlane([0, 0, 0.5], [0, 0, 1])!
    return h.getPlaneUnits(ctx).regions.map((r) => ({ over: r.over, extrude: r.extrude }))
  })
  expect(regions.some((r) => r.over !== null && r.over.face !== null)).toBe(true)
  expect(regions.some((r) => r.extrude !== null)).toBe(true)

  // Undo restores the rectangle whole on the face; redo moves it again.
  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(100)
  const undone = await topUnits(page)
  expect(undone).toHaveLength(1)
  expect(undone[0].free).toBe(0)
  expect(undone[0].key).toBe(drawn[0].key)
  await page.evaluate(() => window.__hew_test!.redo())
  await page.waitForTimeout(100)
  const redone = await topUnits(page)
  expect(redone).toHaveLength(1)
  expect(redone[0].free).toBeGreaterThan(0)
  expect(redone[0].key).toBe(moved[0].key)
})

test('a line on a face selects by clicking it and deletes with the Delete key', async ({ page }) => {
  await page.getByRole('radio', { name: 'Line' }).click()
  await click(page, [0.25, 0.4, TOP])
  await click(page, [0.75, 0.4, TOP])
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
  expect(await topUnits(page)).toHaveLength(1)

  await page.getByRole('radio', { name: 'Select' }).click()
  await click(page, [0.5, 0.4, TOP])
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  expect(sel[0].kind).toBe('draft-edge')

  await page.keyboard.press('Delete')
  await page.waitForTimeout(150)
  expect(await topUnits(page)).toHaveLength(0)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()

  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(100)
  expect(await topUnits(page)).toHaveLength(1)
})
