/**
 * imageInfo — a picture's format and shown size in pixels, read from its
 * header alone (Place Image).
 *
 * Mirrors `crates/image-import`'s `read_info` exactly (PNG `IHDR`, the
 * first JPEG frame header, a JPEG's EXIF orientation turning a picture
 * stored on its side, the 64-megapixel limit), so the placement ghost has
 * the same proportions the kernel gives the placed face, and an unreadable
 * or oversized picture is refused before anything is decoded. Pure — no
 * DOM, no three.js.
 */

/** The largest picture Hew places, in pixels (`image_import::MAX_PIXELS`). */
export const MAX_IMAGE_PIXELS = 64_000_000

/** `Scene.place_image`'s format codes. */
export type ImageFormatCode = 0 | 1

export interface ImageInfo {
  /** 0 = PNG, 1 = JPEG. */
  format: ImageFormatCode
  /** Shown width in pixels (EXIF orientation applied). */
  width: number
  /** Shown height in pixels. */
  height: number
}

/** Why a picture can't be placed — the kernel's codes for the same refusals. */
export type ImageRefusal = 'ImageUnreadable' | 'ImageTooLarge'

export type ImageInfoResult = { ok: true; info: ImageInfo } | { ok: false; code: ImageRefusal }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function be16(b: Uint8Array, at: number): number | null {
  if (at + 2 > b.length) return null
  return (b[at] << 8) | b[at + 1]
}

function be32(b: Uint8Array, at: number): number | null {
  if (at + 4 > b.length) return null
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
}

function pngInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 16 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null
  const w = be32(b, 16)
  const h = be32(b, 20)
  if (w === null || h === null) return null
  return { format: 0, width: w, height: h }
}

/** The orientation tag (0x0112) of an Exif block's first directory. */
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null
  const le = t[0] === 0x49 && t[1] === 0x49
  const be = t[0] === 0x4d && t[1] === 0x4d
  if (!le && !be) return null
  const u16 = (at: number): number | null => {
    if (at + 2 > t.length) return null
    return le ? t[at] | (t[at + 1] << 8) : (t[at] << 8) | t[at + 1]
  }
  const u32 = (at: number): number | null => {
    if (at + 4 > t.length) return null
    return le
      ? (t[at] | (t[at + 1] << 8) | (t[at + 2] << 16)) + ((t[at + 3] << 24) >>> 0)
      : ((t[at] << 24) >>> 0) + (t[at + 1] << 16) + (t[at + 2] << 8) + t[at + 3]
  }
  if (u16(2) !== 42) return null
  const ifd = u32(4)
  if (ifd === null) return null
  const count = u16(ifd)
  if (count === null) return null
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + 12 * k
    if (u16(e) === 0x0112 && u16(e + 2) === 3) return u16(e + 8)
  }
  return null
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let i = 2
  let turned = false
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return null
    while (i < b.length && b[i] === 0xff) i++
    if (i >= b.length) return null
    const marker = b[i]
    i++
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    const len = be16(b, i)
    if (len === null || len < 2 || i + len > b.length) return null
    const seg = b.subarray(i + 2, i + len)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = be16(seg, 1)
      const w = be16(seg, 3)
      if (h === null || w === null) return null
      return turned ? { format: 1, width: h, height: w } : { format: 1, width: w, height: h }
    }
    if (
      marker === 0xe1 && seg.length >= 6 &&
      seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66 && seg[4] === 0 && seg[5] === 0
    ) {
      const o = exifOrientation(seg.subarray(6))
      turned = o !== null && o >= 5 && o <= 8
    }
    i += len
  }
}

/** The picture's format and shown size, or why it can't be placed. */
export function readImageInfo(bytes: Uint8Array): ImageInfoResult {
  let info: ImageInfo | null = null
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, k) => bytes[k] === v)) info = pngInfo(bytes)
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) info = jpegInfo(bytes)
  if (info === null || info.width === 0 || info.height === 0) return { ok: false, code: 'ImageUnreadable' }
  if (info.width * info.height > MAX_IMAGE_PIXELS) return { ok: false, code: 'ImageTooLarge' }
  return { ok: true, info }
}

/** Whether a file name is a picture Place Image takes (`.png`/`.jpg`/`.jpeg`). */
export function isPictureFileName(name: string): boolean {
  return /\.(png|jpe?g)$/i.test(name)
}

/** The definition name a picture gets from its file name
 *  (`image_import::picture_name`): the base name without its extension,
 *  or "Image" for none. */
export function pictureName(fileName: string): string {
  const base = (fileName.split(/[/\\]/).pop() ?? fileName).trim()
  const stem = base.replace(/\.(png|jpe?g)$/i, '').trim()
  // oxlint-disable-next-line lingui/no-unlocalized-strings -- stored default name, matches the Rust side
  return stem === '' ? 'Image' : stem
}
