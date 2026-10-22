import { test, expect, type Page } from '@playwright/test'

/**
 * #51b: where edges of two separate Objects pass through each other, the
 * crossing snaps as an Intersection. The reported two-box scene, rebuilt:
 * the low box's top-back edge crosses the tall box's front-left vertical
 * edge at CROSSING. Real pointer events over a pinned camera; the Line and
 * Tape Measure tools both start from the snap (Tape Measure measures from
 * the crossing; a plain edge point still starts a parallel guide).
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'pointer-driven spec, chromium only')

const CROSSING: [number, number, number] = [0.5001, 0.0714, 0.1826]

interface Ctx {
  rect: { x: number; y: number; width: number; height: number }
}

/** Looking at the crossing from the front, a little to the left and above,
 *  from `dist` metres away. */
async function aim(page: Page, dist: number): Promise<Ctx> {
  const dir = [-0.4, -1, 0.5]
  const n = Math.hypot(dir[0], dir[1], dir[2])
  const position = CROSSING.map((c, i) => c + (dir[i] / n) * dist) as [number, number, number]
  await page.evaluate(
    (cam) => window.__hew_test!.setCamera(cam),
    { position, target: CROSSING, up: [0, 0, 1] as [number, number, number], fovDeg: 45 },
  )
  await page.waitForTimeout(150)
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('viewport canvas has no bounding box')
  return { rect: box }
}

async function px(page: Page, ctx: Ctx, w: [number, number, number]): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  return { x: ctx.rect.x + p.x, y: ctx.rect.y + p.y }
}

async function hover(page: Page, ctx: Ctx, w: [number, number, number], dx = 0, dy = 0): Promise<void> {
  const p = await px(page, ctx, w)
  await page.mouse.move(p.x - 6 + dx, p.y - 4 + dy)
  await page.waitForTimeout(50)
  await page.mouse.move(p.x + dx, p.y + dy)
  await page.waitForTimeout(160)
}

async function chip(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div'))
      .filter((d) => d.style.zIndex === '20' && d.style.pointerEvents === 'none')
      .map((e) => e.textContent ?? '')
      .join(' | '),
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.drawBox([0, 0, 0], [1, 0.0714, 0], 0.1826) // obj_9
    t.drawBox([0.5001, 0.0714, 0], [1.2, 0.8, 0], 0.5) // obj_7
  })
})

test('the crossing of two Objects’ edges snaps, and Line and Tape Measure start from it', async ({ page }) => {
  test.setTimeout(120_000)
  await page.getByRole('radio', { name: 'Line' }).click()

  // The low box's top-back edge midpoint sits 0.1 mm from the crossing (at
  // x = 0.5), the same pixel at any normal zoom. A crossing outranks a
  // midpoint (midpoints are on every edge, crossings are rare), so the
  // crossing wins with the midpoint in the pick radius too.
  const normal = await aim(page, 1.5)
  await hover(page, normal, CROSSING, 2, 1)
  expect(await chip(page), 'Line at normal zoom').toContain('Intersection')
  // A crossing reaches as far as any named point (14 px against the 8 px
  // pick radius): 10 px off it, the crossing still wins.
  await hover(page, normal, CROSSING, 8, -6)
  expect(await chip(page), 'Line 10 px off the crossing').toContain('Intersection')
  await page.getByRole('radio', { name: 'Tape Measure' }).click()
  await hover(page, normal, CROSSING, 2, 1)
  expect(await chip(page), 'Tape Measure at normal zoom').toContain('Intersection')
  await hover(page, normal, CROSSING, 8, -6)
  expect(await chip(page), 'Tape Measure 10 px off the crossing').toContain('Intersection')
  await page.keyboard.press('Escape')
  await page.getByRole('radio', { name: 'Line' }).click()

  // Zoomed far in, for the gestures below to measure sub-millimetre.
  const ctx = await aim(page, 0.004)
  await hover(page, ctx, CROSSING, 2, 1)
  const nearChip = await chip(page)
  expect(nearChip).toContain('Intersection')

  // Tape Measure: the crossing snaps the same way, the hint says a click
  // there measures from it, and the click starts a measurement — the
  // crossing is a point, not a parallel guide off whichever edge ranked
  // first.
  await page.getByRole('radio', { name: 'Tape Measure' }).click()
  await hover(page, ctx, CROSSING, 2, 1)
  const tapeChip = await chip(page)
  expect(tapeChip).toContain('Intersection')
  await expect(page.getByText('Click to measure from the crossing.', { exact: true })).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.getByText('Click the second point to read the distance', { exact: false })).toBeVisible()
  // Second point inside obj_7's front face: a measurement, no guide.
  const pull: [number, number, number] = [0.5005, 0.0714, 0.183]
  await hover(page, ctx, pull)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__hew_test!.getGuideIds())).toHaveLength(0)
  // Both ends on geometry: the measurement is remembered for a resize.
  await expect(page.getByText('Type a distance and press Enter to resize the model', { exact: false })).toBeVisible()

  // A plain point on obj_9's top-back edge, away from the crossing, still
  // starts a parallel guide along that edge.
  const onEdge: [number, number, number] = [0.499, 0.0714, 0.1826]
  await hover(page, ctx, onEdge)
  expect(await chip(page)).not.toContain('Intersection')
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.getByText('Click to place the parallel guide', { exact: false })).toBeVisible()
  await hover(page, ctx, pull)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(150)
  const guides = await page.evaluate(() => {
    const t = window.__hew_test!
    return t.getGuideIds().map((id) => t.getGuideGeometry(id)!)
  })
  expect(guides).toHaveLength(1)
  const [ox, oy, oz, dx, dy, dz] = guides[0]
  // Along obj_9's edge (X)…
  expect(Math.abs(dx)).toBeGreaterThan(1 - 1e-9)
  // …through the pulled-to point (a pixel's slack: it is a free on-face point).
  const w = [pull[0] - ox, pull[1] - oy, pull[2] - oz]
  const along = w[0] * dx + w[1] * dy + w[2] * dz
  const off = Math.hypot(w[0] - along * dx, w[1] - along * dy, w[2] - along * dz)
  expect(off).toBeLessThan(2e-5)
  await page.keyboard.press('Escape')
  await page.getByRole('radio', { name: 'Line' }).click()
  await hover(page, ctx, CROSSING, 2, 1)
  expect(await chip(page)).toContain('Intersection')

  // Line: click the crossing, then a point inside obj_7's front face.
  const before = await page.evaluate(() => window.__hew_test!.getSketchIds())
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(120)
  const inFace: [number, number, number] = [0.5005, 0.0714, 0.183]
  await hover(page, ctx, inFace)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  const points = await page.evaluate((before) => {
    const t = window.__hew_test!
    const sketched = t.getSketchIds().filter((id) => !before.includes(id))
      .flatMap((id) => t.getSketchSegmentsExact(id)).flatMap((s) => [s.slice(0, 3), s.slice(3, 6)])
    const imprinted = t.getObjectIds().flatMap((o) => t.getImprints(o).flatMap((i) => i.loop))
    return [...sketched, ...imprinted]
  }, before)
  const hit = points.some((p) => Math.hypot(p[0] - CROSSING[0], p[1] - CROSSING[1], p[2] - CROSSING[2]) < 1e-9)
  expect(hit, 'the drawn line starts exactly at the crossing').toBe(true)

})
