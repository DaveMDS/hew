/**
 * The desktop save panel with the format choice in it (the shell's
 * `pick_save_target`, `shells/tauri/src-tauri/src/save_panel.rs`): macOS's
 * "Format:" popup, Windows' "Save as type" list, GTK's file-type filter,
 * with the chosen format's options beside it — the convention every
 * desktop app follows, SketchUp's own Save As and Export included.
 *
 * The browser has no such panel (Chrome's picker never says which type
 * was picked, and Safari/Firefox only download), so there the in-app
 * Save As format step and Export dialog stay. Both read their formats and
 * options from here, so the two offer exactly the same things.
 */

import type { DocFormat } from './fileHost'
import { isTauri } from './fileHost'
import { SAVE_FORMAT_CHOICES, extensionFor } from './docFormat'
import { VIEW_LABEL, type PrintViewKind } from '../print/printJob'
import { scaleDisplay, scaleHint, scalePresetsFor, type PrintScale } from '../print/scale'
import type { LengthFormat } from '../settings/units'

export interface PanelChoice {
  value: string
  label: string
}

/** One option control the panel shows for a format. */
export type PanelOption =
  | { kind: 'select'; id: string; label: string; choices: PanelChoice[]; value: string }
  | { kind: 'check'; id: string; label: string; value: boolean }

/** One entry of the panel's format list. */
export interface PanelFormat {
  id: string
  label: string
  /** Without the dot. */
  extension: string
  options?: PanelOption[]
}

/** What the user confirmed in the panel. */
export interface PanelResult {
  path: string
  format: string
  options: Record<string, string | boolean>
}

/** Whether this host shows the native panel (every desktop build). */
export function hasNativeSavePanel(): boolean {
  return isTauri
}

/** Show the native panel; `null` when the user canceled. */
export async function pickSaveTarget(
  title: string,
  defaultName: string,
  formats: PanelFormat[],
  initial: string,
): Promise<PanelResult | null> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<PanelResult | null>('pick_save_target', { title, defaultName, formats, initial })
}

// ------------------------------------------------------------------ Save As

/** Save As's formats: the browser's in-app step's, by the same labels. */
export const SAVE_PANEL_FORMATS: PanelFormat[] = SAVE_FORMAT_CHOICES.map((c) => ({
  id: c.format,
  label: c.label,
  extension: extensionFor(c.format).slice(1),
}))

// ------------------------------------------------------------------- Export

/** `skp` is the SketchUp 2026 container, `skp2017` the 2017 format. */
export type ExportFormat = 'glb' | 'stl' | '3mf' | 'usdz' | 'svg' | 'skp' | 'skp2017'

/** SVG line-drawing options (docs/design/printing.md §7b). */
export interface SvgExportOptions {
  view: PrintViewKind
  scale: PrintScale
  hiddenDashed: boolean
  includeDimensions: boolean
}

/** Export's formats: the panel's labels (the in-app dialog adds a hint). */
export const EXPORT_FORMATS: { format: ExportFormat; label: string; extension: string; hint: string }[] = [
  { format: 'glb', label: 'glTF binary (.glb)', extension: 'glb', hint: 'Y-up, meters' },
  { format: 'stl', label: 'STL binary (.stl)', extension: 'stl', hint: 'Z-up, millimeters, for 3D printing' },
  { format: '3mf', label: '3MF (.3mf)', extension: '3mf', hint: 'Z-up, millimeters, keeps part names and colors' },
  { format: 'usdz', label: 'USDZ (.usdz)', extension: 'usdz', hint: 'Y-up, meters, for AR Quick Look and USD pipelines' },
  { format: 'svg', label: 'SVG line drawing (.svg)', extension: 'svg', hint: 'hidden lines removed, true size at a drawing scale' },
  { format: 'skp', label: 'SketchUp (.skp)', extension: 'skp', hint: '' },
  { format: 'skp2017', label: 'SketchUp 2017 (.skp)', extension: 'skp', hint: 'opens in SketchUp Make 2017 and later' },
]

/** STL curve-resolution choices: segments per full turn (0 = stored facets). */
export const STL_RESOLUTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'As modeled (stored facets)' },
  { value: 24, label: 'Draft (24 segments per turn)' },
  { value: 48, label: 'Standard (48 segments per turn)' },
  { value: 96, label: 'Fine (96 segments per turn)' },
  { value: 192, label: 'Ultra (192 segments per turn)' },
]

/** The STL resolution an export starts on. */
export const DEFAULT_STL_SEGMENTS = 48

/** The SVG scale an export starts on: 1:1 (laser/CNC read true size). */
export function defaultSvgScaleIndex(presets: PrintScale[]): number {
  return Math.max(0, presets.findIndex((p) => Math.abs(p.paperMeters / p.modelMeters - 1) < 1e-9))
}

/** A scale preset's label, with its metric hint when it has one. */
export function svgScaleLabel(p: PrintScale, unit: LengthFormat): string {
  const hint = scaleHint(p, unit)
  return hint === null ? scaleDisplay(p) : `${p.label}  (${hint})`
}

/** Export's formats for the native panel, each with its options. */
export function exportPanelFormats(unit: LengthFormat): PanelFormat[] {
  const presets = scalePresetsFor(unit)
  const options: Partial<Record<ExportFormat, PanelOption[]>> = {
    stl: [
      {
        kind: 'select',
        id: 'segments',
        label: 'Curve resolution',
        choices: STL_RESOLUTIONS.map((r) => ({ value: String(r.value), label: r.label })),
        value: String(DEFAULT_STL_SEGMENTS),
      },
    ],
    svg: [
      {
        kind: 'select',
        id: 'view',
        label: 'View',
        choices: (Object.keys(VIEW_LABEL) as PrintViewKind[]).map((v) => ({ value: v, label: VIEW_LABEL[v] })),
        value: 'current',
      },
      {
        kind: 'select',
        id: 'scale',
        label: 'Scale',
        choices: presets.map((p, i) => ({ value: String(i), label: svgScaleLabel(p, unit) })),
        value: String(defaultSvgScaleIndex(presets)),
      },
      { kind: 'check', id: 'hidden', label: 'Hidden lines dashed', value: false },
      { kind: 'check', id: 'dimensions', label: 'Dimensions & text', value: true },
    ],
  }
  return EXPORT_FORMATS.map((f) => ({
    id: f.format,
    label: f.label,
    extension: f.extension,
    options: options[f.format] ?? [],
  }))
}

/** What an export does, read back from the panel's answer. */
export interface ExportChoice {
  format: ExportFormat
  stlSegmentsPerTurn: number
  svg?: SvgExportOptions
}

/** Turn the panel's answer into an export; `null` for an unknown format. */
export function exportChoiceFrom(result: PanelResult, unit: LengthFormat): ExportChoice | null {
  const format = EXPORT_FORMATS.find((f) => f.format === result.format)?.format
  if (format === undefined) return null
  const o = result.options
  const segments = Number(o.segments ?? DEFAULT_STL_SEGMENTS)
  const choice: ExportChoice = {
    format,
    stlSegmentsPerTurn: Number.isFinite(segments) ? segments : DEFAULT_STL_SEGMENTS,
  }
  if (format === 'svg') {
    const presets = scalePresetsFor(unit)
    const view = (typeof o.view === 'string' && o.view in VIEW_LABEL ? o.view : 'current') as PrintViewKind
    const at = Number(o.scale)
    const scale = presets[Number.isInteger(at) && at >= 0 && at < presets.length ? at : defaultSvgScaleIndex(presets)]
    choice.svg = {
      view,
      scale: scale as PrintScale,
      hiddenDashed: o.hidden === true,
      includeDimensions: o.dimensions !== false,
    }
  }
  return choice
}

/** Save As's format from the panel's answer (anything else is `.hew`). */
export function saveFormatFrom(result: PanelResult): DocFormat {
  return result.format === 'skp2026' || result.format === 'skp2017' ? result.format : 'hew'
}
