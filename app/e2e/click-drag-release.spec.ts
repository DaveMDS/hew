import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * Click-drag-release for two-point tools (GitHub #52b): SketchUp accepts a
 * press on the start point, a drag, and a release on the end point as well
 * as click, move, click. Driven with REAL mouse down / move / up (the
 * shared mechanism lives in viewport/dragCommit.ts; the click-click specs,
 * e.g. rectangle-retype.spec.ts and modify-retype.spec.ts, cover the other
 * gesture and must stay green untouched).
 */

const CAMERA = {
  position: [4, -8, 6] as [number, number, number],
  target: [1, 1, 0] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
  fovDeg: 45,
}

type V3 = [number, number, number]

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
  await page.evaluate((cam) => window.__hew_test!.setCamera(cam), CAMERA)
  await page.waitForTimeout(100)
}

async function pagePoint(page: Page, w: V3): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  if (p.behind) throw new Error(`world point ${w.join(',')} is behind the camera`)
  return { x: box.x + p.x, y: box.y + p.y }
}

/** A real press on `a`, a drag in steps, and a release on `b`. */
async function dragWorld(page: Page, a: V3, b: V3): Promise<void> {
  const pa = await pagePoint(page, a)
  const pb = await pagePoint(page, b)
  await page.mouse.move(pa.x, pa.y)
  await page.mouse.down()
  await page.mouse.move(pb.x, pb.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(50)
}

async function clickWorld(page: Page, w: V3): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

async function moveToWorld(page: Page, w: V3): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x, p.y, { steps: 6 })
}

async function soleSketch(page: Page): Promise<string> {
  const ids = await page.evaluate(() => window.__hew_test!.getSketchIds())
  expect(ids).toHaveLength(1)
  return ids[0]
}

async function segments(page: Page, sketch: string): Promise<number[][]> {
  return page.evaluate((s) => window.__hew_test!.getSketchSegmentsExact(s), sketch)
}

/** XY bounds of every edge of `sketch`. */
async function xyBounds(page: Page, sketch: string): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const segs = await segments(page, sketch)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of segs) {
    for (const [x, y] of [[s[0], s[1]], [s[3], s[4]]]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return { minX, minY, maxX, maxY }
}

async function boundsOf(page: Page, id: string): Promise<[number, number, number, number, number, number]> {
  return page.evaluate((id) => window.__hew_test!.getObjectBounds(id), id)
}

test.describe('click-drag-release (#52b)', () => {
  test('Line: a drag draws one segment and ends the chain; a typed length then resizes it', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('l')
    await dragWorld(page, [0, 0, 0], [1, 0, 0])
    const sketch = await soleSketch(page)
    let segs = await segments(page, sketch)
    expect(segs).toHaveLength(1)
    expect(segs[0][0]).toBeCloseTo(0, 6)
    expect(segs[0][3]).toBeCloseTo(1, 2)

    // A typed length straight after the release resizes the line just drawn.
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)
    segs = await segments(page, await soleSketch(page))
    expect(segs).toHaveLength(1)
    expect(Math.hypot(segs[0][3] - segs[0][0], segs[0][4] - segs[0][1])).toBeCloseTo(2, 6)

    // The chain is over: moving on shows the idle hint, and a click starts a
    // new line (nothing is drawn from the old end).
    await moveToWorld(page, [1, 2, 0])
    await expect(page.locator('text=Click to start a line').first()).toBeVisible()
    await clickWorld(page, [1, 2, 0])
    await moveToWorld(page, [2, 2, 0])
    segs = await segments(page, await soleSketch(page))
    expect(segs).toHaveLength(1)
  })

  test('Line: a drag at a chain\'s later point is ignored; the chain continues click-click', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('l')
    await clickWorld(page, [0, 0, 0])
    // Press on (1, 0, 0), drag away, release: the press is the click.
    await dragWorld(page, [1, 0, 0], [1, 1.5, 0])
    const sketch = await soleSketch(page)
    let segs = await segments(page, sketch)
    expect(segs).toHaveLength(1)
    expect(segs[0][3]).toBeCloseTo(1, 2)
    expect(segs[0][4]).toBeCloseTo(0, 2)
    // Still chaining: the next click draws from (1, 0, 0).
    await clickWorld(page, [1, 1, 0])
    segs = await segments(page, sketch)
    expect(segs).toHaveLength(2)
    await page.keyboard.press('Escape')
  })

  test('Rectangle: a drag draws the rectangle; typed W,D afterwards resizes it', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('r')
    await dragWorld(page, [0, 0, 0], [1, 1, 0])
    const sketch = await soleSketch(page)
    expect(await segments(page, sketch)).toHaveLength(4)
    let b = await xyBounds(page, sketch)
    expect(b.minX).toBeCloseTo(0, 2)
    expect(b.minY).toBeCloseTo(0, 2)
    expect(b.maxX).toBeCloseTo(1, 1)
    expect(b.maxY).toBeCloseTo(1, 1)

    await page.keyboard.type('2,3')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)
    b = await xyBounds(page, await soleSketch(page))
    expect(b.maxX - b.minX).toBeCloseTo(2, 6)
    expect(b.maxY - b.minY).toBeCloseTo(3, 6)
  })

  test('Rectangle: a short press is still a plain click, so click-click works unchanged', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('r')
    const p = await pagePoint(page, [0, 0, 0])
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 2, p.y + 1) // a hand's jitter, under the threshold
    await page.mouse.up()
    expect(await page.evaluate(() => window.__hew_test!.getSketchIds())).toHaveLength(0)
    await clickWorld(page, [1, 1, 0])
    const sketch = await soleSketch(page)
    expect(await segments(page, sketch)).toHaveLength(4)
  })

  test('Circle: a drag from the center sets the radius at the release', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('c')
    await dragWorld(page, [0, 0, 0], [1, 0, 0])
    const b = await xyBounds(page, await soleSketch(page))
    expect(b.maxX).toBeCloseTo(1, 1)
    expect(b.minX).toBeCloseTo(-1, 1)
    expect(b.maxY - b.minY).toBeCloseTo(2, 1)
  })

  test('Push/Pull: a drag pulls the face; a typed distance afterwards redoes it', async ({ page }) => {
    await setup(page)
    const id = await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [2, 2, 0], 1))
    await page.keyboard.press('p')
    await dragWorld(page, [1, 1, 1], [1, 1, 1.6])
    let ids = await page.evaluate(() => window.__hew_test!.getObjectIds())
    expect(ids).toHaveLength(1)
    let b = await boundsOf(page, ids[0])
    expect(b[2]).toBeCloseTo(0, 6)
    expect(b[5]).toBeGreaterThan(1.2) // pulled up by the drag
    expect(id).toBe(ids[0])

    await page.keyboard.type('0.5')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)
    ids = await page.evaluate(() => window.__hew_test!.getObjectIds())
    b = await boundsOf(page, ids[0])
    expect(b[5] - b[2]).toBeCloseTo(1.5, 5)
  })

  test('Move: a drag moves the selection; a typed distance afterwards redoes it', async ({ page }) => {
    await setup(page)
    const id = await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1))
    await page.evaluate((id) => window.__hew_test!.selectObjects([id]), id)
    await page.keyboard.press('m')
    await dragWorld(page, [1, 0, 0], [3, 0, 0])
    let b = await boundsOf(page, id)
    expect(b[0]).toBeGreaterThan(1) // moved along +X by the drag
    expect(b[1]).toBeCloseTo(0, 2)
    expect(b[2]).toBeCloseTo(0, 6)

    await page.keyboard.type('4')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)
    b = await boundsOf(page, id)
    expect(b[0]).toBeCloseTo(4, 5)
    expect(b[1]).toBeCloseTo(0, 5)
  })

  test('touch: a one-finger drag draws the rectangle and never orbits the camera', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'CDP touch dispatch is Chromium-only')
    await setup(page)
    await page.keyboard.press('r')
    const before = await page.evaluate(() => window.__hew_test!.getCamera())
    const a = await pagePoint(page, [0, 0, 0])
    const b = await pagePoint(page, [1, 1, 0])
    const client = await page.context().newCDPSession(page)
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] })
    for (let i = 1; i <= 10; i++) {
      const t = i / 10
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }],
      })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(100)
    const after = await page.evaluate(() => window.__hew_test!.getCamera())
    for (let i = 0; i < 3; i++) {
      expect(after.position[i]).toBeCloseTo(before.position[i], 6)
      expect(after.target[i]).toBeCloseTo(before.target[i], 6)
    }
    const sketch = await soleSketch(page)
    expect(await segments(page, sketch)).toHaveLength(4)
    const bb = await xyBounds(page, sketch)
    expect(bb.maxX - bb.minX).toBeCloseTo(1, 1)
    expect(bb.maxY - bb.minY).toBeCloseTo(1, 1)
  })

  test('Line: a length typed with Enter DURING the drag commits that segment; the release adds nothing', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('l')
    const a = await pagePoint(page, [0, 0, 0])
    const b = await pagePoint(page, [1, 0, 0])
    const c = await pagePoint(page, [1.5, 1, 0])
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 10 })
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await page.mouse.move(c.x, c.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(80)
    const segs = await segments(page, await soleSketch(page))
    expect(segs).toHaveLength(1)
    expect(Math.hypot(segs[0][3] - segs[0][0], segs[0][4] - segs[0][1])).toBeCloseTo(2, 6)
    await page.keyboard.press('Escape')
  })

  test('touch: a second finger during a drag is ignored; the first finger\'s release still draws', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'CDP touch dispatch is Chromium-only')
    await setup(page)
    await page.keyboard.press('r')
    const before = await page.evaluate(() => window.__hew_test!.getCamera())
    const a = await pagePoint(page, [0, 0, 0])
    const b = await pagePoint(page, [1, 1, 0])
    const far = await pagePoint(page, [3, -1, 0])
    const client = await page.context().newCDPSession(page)
    const t1 = (x: number, y: number) => ({ x, y, id: 1 })
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [t1(a.x, a.y)] })
    for (let i = 1; i <= 6; i++) {
      const t = i / 10
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [t1(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)] })
    }
    const mid = t1(a.x + (b.x - a.x) * 0.6, a.y + (b.y - a.y) * 0.6)
    // Finger 2 lands, wanders and lifts while finger 1 holds.
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [mid, { x: far.x, y: far.y, id: 2 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [mid, { x: far.x + 40, y: far.y + 30, id: 2 }] })
    // CDP lists the points that LIFT on a touchEnd: finger 2 only.
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: far.x + 40, y: far.y + 30, id: 2 }] })
    for (let i = 7; i <= 10; i++) {
      const t = i / 10
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [t1(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)] })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(100)
    const after = await page.evaluate(() => window.__hew_test!.getCamera())
    for (let i = 0; i < 3; i++) expect(after.position[i]).toBeCloseTo(before.position[i], 6)
    const sketch = await soleSketch(page)
    expect(await segments(page, sketch)).toHaveLength(4)
    const bb = await xyBounds(page, sketch)
    expect(bb.minX).toBeCloseTo(0, 1)
    expect(bb.maxX).toBeCloseTo(1, 1)
    expect(bb.maxY - bb.minY).toBeCloseTo(1, 1)
  })

  test('touch: a tap right after a short drag is a fresh click, not half of a double-click', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'CDP touch dispatch is Chromium-only')
    await setup(page)
    await page.keyboard.press('l')
    const a = await pagePoint(page, [0, 0, 0])
    const d = await pagePoint(page, [1, 1, 0])
    const client = await page.context().newCDPSession(page)
    // A 15 px drag: past the drag threshold, inside the touch double-click slop.
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] })
    for (let i = 1; i <= 5; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + i * 3, y: a.y }] })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // A quick tap 8 px on: starts a new line.
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x + 23, y: a.y }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // A tap far away ends that new line's first segment.
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: d.x, y: d.y }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(100)
    expect(await segments(page, await soleSketch(page))).toHaveLength(2)
  })

  for (const exit of ['pointercancel', 'window blur', 'tool switch'] as const) {
    test(`touch: the camera comes back after a drawing touch ends by ${exit}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium', 'CDP touch dispatch is Chromium-only')
      await setup(page)
      await page.keyboard.press('r')
      const a = await pagePoint(page, [0, 0, 0])
      const client = await page.context().newCDPSession(page)
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 40, y: a.y + 20, id: 1 }] })
      // While the finger draws, its moves never orbit the camera…
      const held = await page.evaluate(() => window.__hew_test!.getCamera())
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 120, y: a.y + 60, id: 1 }] })
      await page.waitForTimeout(80)
      const stillHeld = await page.evaluate(() => window.__hew_test!.getCamera())
      for (let i = 0; i < 3; i++) expect(stillHeld.position[i]).toBeCloseTo(held.position[i], 6)
      if (exit === 'pointercancel') {
        await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      } else if (exit === 'window blur') {
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      } else {
        // The rail, not a shortcut: mid-gesture the tool owns letter keys (`c` is centimeters).
        await page.getByRole('radio', { name: 'Circle', exact: true }).first().click()
      }
      // …and once the gesture is over the camera answers again: the still-held
      // finger orbits, or (after a cancel lifted it) the wheel zooms.
      if (exit === 'pointercancel') {
        const box = (await page.locator('canvas').first().boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, -300)
      } else {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 220, y: a.y + 100, id: 1 }] })
      }
      await page.waitForTimeout(150)
      const freed = await page.evaluate(() => window.__hew_test!.getCamera())
      const moved = [0, 1, 2].some((i) => Math.abs(freed.position[i] - held.position[i]) > 1e-3)
      expect(moved).toBe(true)
      if (exit !== 'pointercancel') {
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      // Nothing was drawn by the abandoned drag.
      expect(await page.evaluate(() => window.__hew_test!.getSketchIds())).toHaveLength(0)
    })
  }

  test('Tape Measure: a drag from an edge places the parallel guide at the release', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [2, 2, 0], 1))
    await page.keyboard.press('t')
    await page.locator('text=Click a point to measure from').first().waitFor({ timeout: 5000 })
    expect(await page.evaluate(() => window.__hew_test!.getGuideIds())).toHaveLength(0)
    // The front-top edge's midpoint, dragged straight down the front face.
    await dragWorld(page, [1, 0, 1], [1, 0, 0.4])
    const guides = await page.evaluate(() => window.__hew_test!.getGuideIds())
    expect(guides).toHaveLength(1)
    // Back to idle: the tool asks for a new first point.
    await expect(page.locator('text=Click a point to measure from').first()).toBeVisible()
  })
})
