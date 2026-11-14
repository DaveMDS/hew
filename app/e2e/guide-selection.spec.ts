/**
 * Guides and annotations join the selection like nodes do: the Select
 * tool's modifier matrix (Shift toggles, Ctrl adds, Shift+Ctrl subtracts)
 * combines them with whatever else is selected, a plain click replaces the
 * whole selection, and Delete erases everything selected. Driven with real
 * pointer and key events; the harness only builds the scene, pins the
 * camera, and reads kernel state back.
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

/** Click a world point the way a person does: arrive, settle, then press. */
async function click(page: Page, w: V3, modifiers: ('Shift' | 'Control')[] = []): Promise<void> {
  const at = await pagePoint(page, w)
  await page.mouse.move(at.x - 3, at.y + 2)
  await page.waitForTimeout(60)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(150)
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.down()
  await page.mouse.up()
  for (const key of modifiers) await page.keyboard.up(key)
  await page.waitForTimeout(150)
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

const selection = (page: Page) => page.evaluate(() => window.__hew_test!.getSelection().map((n) => n.id))
const count = (page: Page, n: number) => page.getByText(`${n} selected`, { exact: true })

test('modifier clicks mix guides and annotations into a node selection; Delete erases them all', async ({ page }) => {
  const { box, right, left, dim } = await boot(page)

  await click(page, [0.5, 0.5, 1])
  expect(await selection(page)).toEqual([box])

  // Shift adds the right guide; the box stays selected.
  await click(page, [3, 0.5, 0], ['Shift'])
  expect(await selection(page)).toEqual([box])
  await expect(count(page, 2)).toBeVisible()

  // Ctrl adds the left guide and the dimension.
  await click(page, [-2, 0.5, 0], ['Control'])
  await expect(count(page, 3)).toBeVisible()
  await click(page, [0.5, -2.5, 0], ['Control'])
  await expect(count(page, 4)).toBeVisible()

  // Shift+Ctrl takes the right guide back out.
  await click(page, [3, 0.5, 0], ['Shift', 'Control'])
  await expect(count(page, 3)).toBeVisible()
  expect(await selection(page)).toEqual([box])

  await page.keyboard.press('Delete')
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => {
    const h = window.__hew_test!
    return { objects: h.getObjectIds(), guides: h.getGuideIds(), annotations: h.getAnnotationIds() }
  })
  expect(after.objects).not.toContain(box)
  expect(after.guides).toEqual([right])
  expect(after.guides).not.toContain(left)
  expect(after.annotations).not.toContain(dim)
})

test('a plain click on a guide replaces a mixed selection', async ({ page }) => {
  const { box } = await boot(page)

  await click(page, [0.5, 0.5, 1])
  await click(page, [3, 0.5, 0], ['Shift'])
  await expect(count(page, 2)).toBeVisible()
  expect(await selection(page)).toEqual([box])

  await click(page, [-2, 0.5, 0])
  expect(await selection(page)).toEqual([])
  await expect(page.getByText('Guide line', { exact: true })).toBeVisible()

  // A plain click on the box replaces the guide in turn.
  await click(page, [0.5, 0.5, 1])
  expect(await selection(page)).toEqual([box])
  await expect(page.getByText('Guide line', { exact: true })).toHaveCount(0)
})

test('Move carries a mixed selection of a box and a guide, and one undo brings both back', async ({ page }) => {
  const { box, right } = await boot(page)

  await click(page, [0.5, 0.5, 1])
  await click(page, [3, 0.5, 0], ['Shift'])
  await expect(count(page, 2)).toBeVisible()

  const before = await page.evaluate(([b, g]) => {
    const h = window.__hew_test!
    return { box: h.getObjectBounds(b), guide: h.getGuideGeometry(g)! }
  }, [box, right])

  await page.getByRole('radio', { name: 'Move' }).click()
  await page.waitForTimeout(100)
  // Base point on the box's top, a nudge right, X locked, then a typed 2 m.
  await click(page, [0.5, 0.5, 1])
  const away = await pagePoint(page, [1.5, 0.5, 1])
  await page.mouse.move(away.x, away.y, { steps: 4 })
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)

  const after = await page.evaluate(([b, g]) => {
    const h = window.__hew_test!
    return { box: h.getObjectBounds(b), guide: h.getGuideGeometry(g)! }
  }, [box, right])
  expect(after.box[0]).toBeCloseTo(before.box[0] + 2, 6)
  expect(after.box[1]).toBeCloseTo(before.box[1], 6)
  expect(after.guide[0]).toBeCloseTo(before.guide[0] + 2, 6)
  expect(after.guide[1]).toBeCloseTo(before.guide[1], 6)
  // Both stay selected.
  await expect(count(page, 2)).toBeVisible()

  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  const undone = await page.evaluate(([b, g]) => {
    const h = window.__hew_test!
    return { box: h.getObjectBounds(b), guide: h.getGuideGeometry(g)! }
  }, [box, right])
  expect(undone.box).toEqual(before.box)
  expect(undone.guide).toEqual(before.guide)
})

test('undoing a copy of a box and a guide leaves neither copy selected, so a later Delete still erases', async ({ page }) => {
  const { box, right, left } = await boot(page)
  const live = () => page.evaluate(() => {
    const h = window.__hew_test!
    return { objects: h.getObjectIds(), guides: h.getGuideIds() }
  })

  await click(page, [0.5, 0.5, 1])
  await click(page, [3, 0.5, 0], ['Shift'])
  await expect(count(page, 2)).toBeVisible()

  // Move with the copy toggle on, 2 m along X: the copies become the selection.
  await page.getByRole('radio', { name: 'Move' }).click()
  await page.waitForTimeout(100)
  await page.keyboard.press('Control') // a real clean tap: copy on
  await click(page, [0.5, 0.5, 1])
  const away = await pagePoint(page, [1.5, 0.5, 1])
  await page.mouse.move(away.x, away.y, { steps: 4 })
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  const copied = await live()
  expect(copied.objects).toHaveLength(2)
  expect(copied.guides).toHaveLength(3)
  await expect(count(page, 2)).toBeVisible()

  // Undo takes both copies back, and with them the selection.
  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  const undone = await live()
  expect(undone.objects).toEqual([box])
  expect([...undone.guides].sort()).toEqual([right, left].sort())
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)

  // A Shift-click selects the box alone, and Delete erases it.
  await page.getByRole('radio', { name: 'Select' }).click()
  await page.waitForTimeout(100)
  await click(page, [0.5, 0.5, 1], ['Shift'])
  expect(await selection(page)).toEqual([box])
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(150)
  expect((await live()).objects).not.toContain(box)
})

test('Rotate turns a mixed selection of a box and a guide, and one undo brings both back', async ({ page }) => {
  const { box, right } = await boot(page)

  await click(page, [0.5, 0.5, 1])
  await click(page, [3, 0.5, 0], ['Shift'])
  await expect(count(page, 2)).toBeVisible()

  const read = () => page.evaluate(([b, g]) => {
    const h = window.__hew_test!
    return { box: h.getObjectBounds(b), guide: h.getGuideGeometry(g)! }
  }, [box, right])
  const before = await read()

  await page.getByRole('radio', { name: 'Rotate' }).click()
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowUp') // lock the blue (Z) axis
  // Pivot on the box's top corner at the origin, reference along +X, sweep
  // toward +Y, then a typed 90°.
  await click(page, [0, 0, 1])
  await click(page, [1, 0, 1])
  const toward = await pagePoint(page, [0, 1, 1])
  await page.mouse.move(toward.x, toward.y, { steps: 6 })
  await page.waitForTimeout(100)
  await page.keyboard.type('90')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)

  const after = await read()
  // A quarter turn about Z through the origin: (x, y) → (−y, x).
  expect(after.box[0]).toBeCloseTo(-1, 6)
  expect(after.box[3]).toBeCloseTo(0, 6)
  expect(after.guide[0]).toBeCloseTo(0, 6)
  expect(after.guide[1]).toBeCloseTo(3, 6)
  expect(after.guide[3]).toBeCloseTo(-1, 6)
  expect(after.guide[4]).toBeCloseTo(0, 6)
  await expect(count(page, 2)).toBeVisible()

  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  const undone = await read()
  expect(undone.box).toEqual(before.box)
  expect(undone.guide).toEqual(before.guide)
})
