import { test, expect } from '@playwright/test'

/**
 * #52a: Top/Bottom/Front/Back/Left/Right only turn the camera about the
 * current orbit target and keep the distance, so the on-screen scale never
 * changes. Iso still re-frames the model. Real Camera menu clicks.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'chromium only')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
})

async function chooseView(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'Camera' }).click()
  await page.getByText('Standard Views', { exact: true }).hover()
  await page.getByText(name, { exact: true }).first().click()
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

const state = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const t = window.__hew_test!
    const s = t.getCameraState()
    const d = Math.hypot(s.eye[0] - s.target[0], s.eye[1] - s.target[1], s.eye[2] - s.target[2])
    const a = t.worldToScreen([0, 0, 5])
    const b = t.worldToScreen([10, 10, 5])
    return { target: s.target, dist: d, span: Math.hypot(a.x - b.x, a.y - b.y) }
  })

test('Top keeps the zoom on a box corner; Iso frames the box', async ({ page }) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.drawBox([0, 0, 0], [10, 10, 0], 5)
    // Zoomed in on the (1,1,0.5) corner from an oblique pose.
    t.setCamera({ position: [14, 6, 11], target: [10, 10, 5], up: [0, 0, 1], fovDeg: 45 } as never)
  })
  const before = await state(page)

  await chooseView(page, 'Top')
  const top = await state(page)
  expect(top.dist).toBeCloseTo(before.dist, 3)
  for (let i = 0; i < 3; i++) expect(top.target[i]).toBeCloseTo(before.target[i], 3)

  // Zoomed in on the corner: the 14-unit diagonal is far bigger than the
  // viewport-fitting extent would make it, so it spans well past the canvas.
  const canvas = (await page.locator('canvas').first().boundingBox())!
  expect(top.span).toBeGreaterThan(canvas.width)

  await chooseView(page, 'Iso')
  const iso = await state(page)
  expect(iso.dist).toBeGreaterThan(before.dist * 2)
  expect(iso.span).toBeLessThan(canvas.width)
  expect(iso.span).toBeGreaterThan(canvas.width * 0.1)
})

test('parallel projection: axis views keep the ortho zoom; Iso frames the box', async ({ page }) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.drawBox([0, 0, 0], [10, 10, 0], 5)
    t.setCamera({ position: [14, 6, 11], target: [10, 10, 5], up: [0, 0, 1], fovDeg: 45 } as never)
  })
  await page.getByRole('button', { name: 'Camera' }).click()
  await page.getByText('Parallel Projection', { exact: true }).click()
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  expect((await page.evaluate(() => window.__hew_test!.getCameraState().projection))).toBe('parallel')

  // An x-axis edge is perpendicular to the view in both Front and Top, so
  // its on-screen length depends only on the ortho zoom.
  const xSpan = () =>
    page.evaluate(() => {
      const t = window.__hew_test!
      const a = t.worldToScreen([0, 0, 5])
      const b = t.worldToScreen([10, 0, 5])
      return Math.hypot(a.x - b.x, a.y - b.y)
    })
  await chooseView(page, 'Front')
  const front = await xSpan()
  await chooseView(page, 'Top')
  expect(await xSpan()).toBeCloseTo(front, 1)
  expect(await page.evaluate(() => window.__hew_test!.getCameraState().projection)).toBe('parallel')

  await chooseView(page, 'Iso')
  const canvas = (await page.locator('canvas').first().boundingBox())!
  const iso = await xSpan()
  expect(Math.abs(iso - front)).toBeGreaterThan(1)
  expect(iso).toBeLessThan(canvas.width * 0.8)
})
