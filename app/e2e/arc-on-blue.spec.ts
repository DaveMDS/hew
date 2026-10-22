import { test, expect, type Page } from '@playwright/test'

/**
 * Arc acts like Line on the Blue axis: with the first point on the ground
 * and the cursor straight above it on the Blue inference, a typed chord
 * length — or a click — puts the second point straight up, and the bulge
 * follows on a vertical plane through the chord. Before, the chord
 * flattened onto the first point: the typed length only raised a toast and
 * the click was dropped. Real pointer and key events throughout.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'pointer-driven spec, chromium only')

type V3 = [number, number, number]

const CAMERA: V3 = [2, -3, 2]
const TARGET: V3 = [0.5, 0.5, 0.2]
const A: V3 = [0.5, 0.5, 0]

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(
    ({ position, target }) => window.__hew_test!.setCamera({ position, target, up: [0, 0, 1], fovDeg: 45 }),
    { position: CAMERA, target: TARGET },
  )
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
  await page.mouse.move(p.x + 5, p.y + 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.waitForTimeout(100)
}

async function press(page: Page): Promise<void> {
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(100)
}

/** A point beside the chord's middle, in the vertical plane through A that
 *  faces the camera — where the bulge is pulled to. */
function bulgePoint(height: number): V3 {
  const n = [TARGET[0] - CAMERA[0], TARGET[1] - CAMERA[1]]
  const len = Math.hypot(n[0], n[1])
  const u = [-n[1] / len, n[0] / len]
  return [A[0] + 0.08 * u[0], A[1] + 0.08 * u[1], height / 2]
}

async function arcResult(page: Page) {
  return page.evaluate(() => {
    const h = window.__hew_test!
    const ids = h.getSketchIds()
    return {
      error: h.getLastError(),
      planes: ids.map((id) => h.getSketchPlane(id)),
      points: ids.flatMap((id) => h.getSketchSegmentsExact(id)).flatMap((s) => [s.slice(0, 3), s.slice(3, 6)]),
    }
  })
}

/** The arc's first point: the one on the ground (a free pick lands within
 *  a pixel of the hovered `A`, not exactly on it). */
function groundPoint(result: Awaited<ReturnType<typeof arcResult>>): V3 {
  const on = result.points.filter((q) => q[2] === 0)
  expect(on.length, 'the arc starts on the ground').toBeGreaterThan(0)
  return on[0] as V3
}

/** The committed arc lies on one vertical plane through `a`, and runs from
 *  `a` to a point straight above it at `height` (or, with no height, any
 *  point straight above it above 0.1 m), which it returns. */
function expectVerticalArc(result: Awaited<ReturnType<typeof arcResult>>, height: number | null): V3 {
  expect(result.error).toBeNull()
  expect(result.planes).toHaveLength(1)
  const a = groundPoint(result)
  const [ox, oy, oz, nx, ny, nz] = result.planes[0]!
  expect(Math.abs(nz)).toBeLessThan(1e-9) // a vertical plane…
  expect(Math.abs(nx * (a[0] - ox) + ny * (a[1] - oy) + nz * (a[2] - oz))).toBeLessThan(1e-9) // …through A
  const over = result.points.filter((q) => q[0] === a[0] && q[1] === a[1] && q[2] > 0.1)
  expect(over.length, 'the arc ends straight above A').toBeGreaterThan(0)
  if (height !== null) expect(over[0][2]).toBeCloseTo(height, 12)
  return over[0] as V3
}

test('Arc: a typed chord on Blue goes straight up from a ground point', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('a')
  await hover(page, A)
  await press(page)
  await hover(page, [A[0], A[1], 0.3])
  await page.keyboard.type('300mm')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  await expect(page.getByText('An arc stays on its drawing plane', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Click to set the curve', { exact: false })).toBeVisible()
  await hover(page, bulgePoint(0.3))
  await press(page)

  expectVerticalArc(await arcResult(page), 0.3)
})

test('Arc: a click on Blue straight above a ground point places the second point there', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('a')
  await hover(page, A)
  await press(page)
  await hover(page, [A[0], A[1], 0.25])
  await press(page)
  await expect(page.getByText('Click to set the curve', { exact: false })).toBeVisible()
  await hover(page, bulgePoint(0.25))
  await press(page)

  // The clicked height is wherever the cursor met Blue (the displayed
  // length, as if typed).
  const top = expectVerticalArc(await arcResult(page), null)
  expect(top[2]).toBeGreaterThan(0.2)
  expect(top[2]).toBeLessThan(0.3)
})
