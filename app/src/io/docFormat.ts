/**
 * docFormat — pure helpers for the document formats a file can be bound to
 * (`DocFormat`, fileHost.ts): file extensions, names, and the labels the
 * Save As format dialog shows. UI-free and wasm-free so it unit-tests
 * without a DOM.
 */

import { t } from '@lingui/core/macro'
import type { DocFormat } from './fileHost'

/** Every extension Hew opens or imports; stripped from a name before a new
 * one is appended (`Model.skp` suggests `Model`, never `Model.skp.hew`). */
const KNOWN_EXTENSION = /\.(hew|skp|dae|stl|glb|gltf)$/i

/** `Model.skp` -> `Model`. Only one trailing known extension is removed. */
export function stripKnownExtension(name: string): string {
  return name.replace(KNOWN_EXTENSION, '')
}

/** True for the two SketchUp document formats. */
export function isSkpFormat(format: DocFormat): boolean {
  return format !== 'hew'
}

/** File extension (with the dot) a format is written with. */
export function extensionFor(format: DocFormat): '.hew' | '.skp' {
  return format === 'hew' ? '.hew' : '.skp'
}

/** `name` with its known extension replaced by the format's. */
export function nameForFormat(name: string, format: DocFormat): string {
  return stripKnownExtension(name) + extensionFor(format)
}

/** The `Scene.save_skp` / `export_skp` target for a SketchUp format. */
export function skpTarget(format: DocFormat): 'skp2026' | 'skp2017' {
  return format === 'skp2017' ? 'skp2017' : 'skp2026'
}

/** Normalize a persisted or externally supplied format value; anything
 * unrecognized (including a missing field from an older record) is `hew`. */
export function normalizeDocFormat(value: unknown): DocFormat {
  return value === 'skp2026' || value === 'skp2017' ? value : 'hew'
}

/** Picker filter description for a format. */
/**
 * The format a save to `path` writes: the API's `format` when it names one
 * (`"hew"`, `"skp"` for the 2026 container, `"skp2017"`), else the path's
 * extension — a `.skp` keeps the document's own SketchUp container (the
 * 2026 one for a document that did not come from a `.skp`), anything else
 * is `.hew`. `null` when a named format contradicts the extension: one
 * format's bytes never go under the other's.
 */
export function saveFormatForPath(path: string, apiFormat: unknown, current: DocFormat | undefined): DocFormat | null {
  const skpPath = /\.skp$/i.test(path)
  if (apiFormat === undefined || apiFormat === null) {
    if (!skpPath) return 'hew'
    return current !== undefined && isSkpFormat(current) ? current : 'skp2026'
  }
  const named: DocFormat | null =
    apiFormat === 'hew' ? 'hew' : apiFormat === 'skp' ? 'skp2026' : apiFormat === 'skp2017' ? 'skp2017' : null
  if (named === null || isSkpFormat(named) !== skpPath) return null
  return named
}

export function formatDescription(format: DocFormat): string {
  switch (format) {
    case 'skp2026':
      return t`SketchUp model`
    case 'skp2017':
      return t`SketchUp 2017 model`
    default:
      return t`Hew model`
  }
}

export interface SaveFormatChoice {
  format: DocFormat
  label: string
  hint: string
}

/** The three options of the Save As format dialog, in display order. */
export const SAVE_FORMAT_CHOICES: readonly SaveFormatChoice[] = [
  // `label` and `hint` are getters so the text resolves in the active locale
  // at read time, not at module load.
  {
    format: 'hew',
    get label() {
      return t`Hew document (.hew)`
    },
    get hint() {
      return t`Keeps everything Hew stores.`
    },
  },
  {
    format: 'skp2026',
    get label() {
      return t`SketchUp (.skp)`
    },
    get hint() {
      return t`The current SketchUp file format.`
    },
  },
  {
    format: 'skp2017',
    get label() {
      return t`SketchUp 2017 (.skp)`
    },
    get hint() {
      return t`Opens in SketchUp Make 2017 and later.`
    },
  },
]
