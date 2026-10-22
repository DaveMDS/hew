/**
 * Settings ▸ View, end to end through the real consumers: the wheel dolly
 * speed and the smooth-camera switch. The persisted values are seeded before
 * load (the same localStorage keys the Settings window writes), then a real
 * wheel event / a real Scene row click is driven and the camera read back.
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

type Vec3 = [number, number, number]
const HOME = { position: [8, 6, 8] as Vec3, target: [1, 1, 1] as Vec3, up: [0, 0, 1] as Vec3, fovDeg: 45 }
const AWAY = { position: [-6, -9, 4] as Vec3, target: [0, 0, 0] as Vec3, up: [0, 0, 1] as Vec3, fovDeg: 45 }
const FOCUS: Vec3 = [1, 1, 1]

async function boot(page: Page, settings: Record<string, string>): Promise<void> {
  await page.addInitScript((s) => {
    localStorage.setItem('hew.settings.trayLayout', JSON.stringify({ modelInfo: true, objectInfo: true, materials: false, tags: true, scenes: true }))
    localStorage.setItem('hew:shellMode', 'editor')
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v)
  }, settings)
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.drawBox([0, 0, 0], [2, 2, 0], 2)
  })
  await page.evaluate((cam) => window.__hew_test!.setCamera(cam), HOME)
  await page.waitForTimeout(250)
}

async function eyeDistance(page: Page, to: Vec3): Promise<number> {
  return page.evaluate((t) => {
    const c = window.__hew_test!.getCameraState()
    return Math.hypot(c.eye[0] - t[0], c.eye[1] - t[1], c.eye[2] - t[2])
  }, to)
}

/** Distance the eye travels toward FOCUS for four real wheel notches. */
async function dollyDistance(page: Page): Promise<number> {
  const before = await eyeDistance(page, FOCUS)
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(30)
  }
  // Let any damping tail finish.
  await page.waitForTimeout(800)
  return before - (await eyeDistance(page, FOCUS))
}

test.describe('View settings reach their consumers', () => {
  test('the zoom wheel speed stop changes how far a real wheel notch dollies', async ({ context }) => {
    const slowPage = await context.newPage()
    await boot(slowPage, { 'hew.settings.zoomWheelSpeed': '0' })
    const slow = await dollyDistance(slowPage)
    await slowPage.close()

    const fastPage = await context.newPage()
    await boot(fastPage, { 'hew.settings.zoomWheelSpeed': '4' })
    const fast = await dollyDistance(fastPage)
    await fastPage.close()

    expect(slow).toBeGreaterThan(0)
    // Stops are 0.5x and 2x of the default: far apart, not a rounding wobble.
    expect(fast).toBeGreaterThan(slow * 2)
  })

  test('smooth camera off lands a Scene activation on its target within a frame', async ({ context }) => {
    const sceneRow = (p: Page) => p.getByTestId('scene-row').first()
    const addScene = async (p: Page): Promise<void> => {
      await p.getByRole('button', { name: 'Add Scene' }).first().click()
      await p.keyboard.press('Escape')
      await expect(sceneRow(p)).toHaveAttribute('data-active', 'true')
      await p.evaluate((cam) => window.__hew_test!.setCamera(cam), AWAY)
      await expect(sceneRow(p)).toHaveAttribute('data-drifted', 'true', { timeout: 5_000 })
    }
    const frames = (p: Page, n: number) =>
      p.evaluate(
        (count) =>
          new Promise<void>((resolve) => {
            let left = count
            const tick = (): void => {
              if (--left <= 0) resolve()
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        n,
      )

    // Control: with smooth camera on (the default) the activation animates,
    // so right after the click the eye is still on its way.
    const smooth = await context.newPage()
    await boot(smooth, { 'hew.settings.sceneTransitions': 'true' })
    await addScene(smooth)
    await sceneRow(smooth).click()
    await frames(smooth, 2)
    expect(await eyeDistance(smooth, HOME.position)).toBeGreaterThan(1)
    await expect.poll(() => eyeDistance(smooth, HOME.position), { timeout: 5_000 }).toBeLessThan(1e-3)
    await smooth.close()

    // Off: the same click lands on the target within a couple of frames.
    const instant = await context.newPage()
    await boot(instant, { 'hew.settings.sceneTransitions': 'true', 'hew.settings.smoothCamera': 'false' })
    await addScene(instant)
    await sceneRow(instant).click()
    await frames(instant, 2)
    expect(await eyeDistance(instant, HOME.position)).toBeLessThan(1e-3)
    await instant.close()
  })
})
