/**
 * A construction guide lying exactly in a face's plane stays drawn on that
 * face from every camera angle. A fixed ±50 m guide segment projected its
 * endpoints so far off-screen that the depth test against the face it lies
 * on was decided by rasterizer noise — the guide blinked out as the camera
 * orbited. The drawn stretch now follows the view (viewport/guideWindow.ts).
 *
 * Chromium only: pixel counts are stable on the pinned SwiftShader context.
 */
import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'pixel counts are only stable on pinned SwiftShader')

/** Count the screenshot's pixels within a few levels of the guide grey (0x55). */
async function countGuideGrey(page: import('@playwright/test').Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const cv = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = cv.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 0x55) < 8 && Math.abs(d[i + 1] - 0x55) < 8 && Math.abs(d[i + 2] - 0x55) < 8) n++
    }
    return n
  }, png.toString('base64'))
}

test('guides in a face plane stay visible while the camera orbits that face', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.drawBox([0, 0, 0], [0.022, 0.0275, 0], 0.007)
    h.setAxesVisible(false)
    h.addGuideLine(0.0063, 0, 0.0035, 0, 0, 1) // in the y = 0 face, vertical
    h.addGuideLine(0.011, 0, 0.0022, 1, 0, 0) // in the y = 0 face, horizontal
  })
  const R = 0.07
  for (const deg of [-12, -6, -3, 3, 6, 12]) {
    const a = (deg * Math.PI) / 180
    await page.evaluate(
      (p) => window.__hew_test!.setCamera(p),
      {
        position: [0.011 + R * Math.sin(a), -R * Math.cos(a), 0.0135] as [number, number, number],
        target: [0.011, 0, 0.0035] as [number, number, number],
      },
    )
    await page.waitForTimeout(200)
    const grey = await countGuideGrey(page, await page.screenshot())
    // Both guides drawn: ~220–250 guide-grey pixels with the fix, ~14
    // (neither guide) without it, measured on SwiftShader.
    expect(grey, `guide-grey pixels at ${deg}°`).toBeGreaterThan(100)
  }
})
