import { describe, it, expect } from 'vitest'
import { readImageInfo, pictureName, isPictureFileName } from './imageInfo'

/** The first bytes of a PNG `w` x `h` (signature + IHDR start). */
function pngHeader(w: number, h: number): Uint8Array {
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
  return new Uint8Array([...b, ...be32(w), ...be32(h), 8, 6, 0, 0, 0])
}

/** A JPEG header with an optional Exif orientation, then SOF0 `w` x `h`
 *  (the same shape `crates/image-import`'s tests build). */
function jpegHeader(w: number, h: number, orientation: number | null, bigEndian: boolean): Uint8Array {
  const out: number[] = [0xff, 0xd8]
  const p16 = (v: number) => (bigEndian ? [(v >> 8) & 255, v & 255] : [v & 255, (v >> 8) & 255])
  const p32 = (v: number) => (bigEndian
    ? [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
    : [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])
  if (orientation !== null) {
    const tiff = [
      ...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]), ...p16(42), ...p32(8), ...p16(2),
      ...p16(0x0100), ...p16(4), ...p32(1), ...p32(640),
      ...p16(0x0112), ...p16(3), ...p32(1), ...p16(orientation), 0, 0,
      ...p32(0),
    ]
    const seg = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    out.push(0xff, 0xe1, ((seg.length + 2) >> 8) & 255, (seg.length + 2) & 255, ...seg)
  }
  out.push(0xff, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00)
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255)
  out.push(3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9)
  return new Uint8Array(out)
}

describe('readImageInfo (mirrors image_import::read_info)', () => {
  it('reads a PNG and a JPEG size from the header', () => {
    expect(readImageInfo(pngHeader(640, 480))).toEqual({ ok: true, info: { format: 0, width: 640, height: 480 } })
    expect(readImageInfo(jpegHeader(1024, 768, null, false))).toEqual({ ok: true, info: { format: 1, width: 1024, height: 768 } })
  })

  it('measures a JPEG stored on its side as it is shown', () => {
    for (const be of [false, true]) {
      for (const o of [5, 6, 7, 8]) {
        const r = readImageInfo(jpegHeader(4000, 3000, o, be))
        expect(r.ok && [r.info.width, r.info.height]).toEqual([3000, 4000])
      }
      for (const o of [1, 2, 3, 4]) {
        const r = readImageInfo(jpegHeader(4000, 3000, o, be))
        expect(r.ok && [r.info.width, r.info.height]).toEqual([4000, 3000])
      }
    }
  })

  it('refuses bytes that are not a picture, and pictures over 64 megapixels', () => {
    for (const bytes of [
      new TextEncoder().encode('GIF89a....'),
      new Uint8Array(),
      pngHeader(10, 10).subarray(0, 20),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00]),
      pngHeader(0, 10),
    ]) {
      expect(readImageInfo(bytes)).toEqual({ ok: false, code: 'ImageUnreadable' })
    }
    expect(readImageInfo(pngHeader(8000, 8000)).ok).toBe(true)
    expect(readImageInfo(pngHeader(8001, 8000))).toEqual({ ok: false, code: 'ImageTooLarge' })
  })
})

describe('pictureName / isPictureFileName', () => {
  it('names the picture after its file, like image_import::picture_name', () => {
    expect(pictureName('Kitchen wall.JPG')).toBe('Kitchen wall')
    expect(pictureName('/tmp/plans/floor.plan.png')).toBe('floor.plan')
    expect(pictureName('C:\\pics\\a.jpeg')).toBe('a')
    expect(pictureName('.png')).toBe('Image')
  })

  it('takes PNG and JPEG names only', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg'].every(isPictureFileName)).toBe(true)
    expect(['a.gif', 'b.hew', 'c.png.txt'].some(isPictureFileName)).toBe(false)
  })
})
