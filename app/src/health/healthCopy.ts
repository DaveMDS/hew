/**
 * Every Model Health and Make Solid string, in one place
 * (docs/design/import-health.md, Revisions 2 and 3, "Words"). One name per
 * thing: an object is solid or not; one that isn't has openings, is a flat
 * panel or a curved sheet, is part of a split shape, or can't be closed.
 * Not being solid is normal for a SketchUp model, so nothing here calls it a
 * problem. Kernel terms (rim, planar, manifold, seam, verdict, leaky) never
 * reach the screen.
 */

/** "1 opening" / "3 openings". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------------------------------------------------------------- kinds

/** Group names, in the order the wizard and the panel show them. */
export const KIND_NAME = {
  openings: 'Has openings',
  split: 'Split shapes',
  flatPanels: 'Flat panels',
  curvedSheets: 'Curved sheets',
  closerLook: "Can't be closed",
} as const

export type KindKey = keyof typeof KIND_NAME

/** Why Hew can't close an object (`openReason` in healthReport.ts). */
export type OpenReason = 'branches' | 'notFlat' | 'lip'

/** The short reason under a "can't be closed" item. */
export const REASON_SHORT: Record<OpenReason, string> = {
  branches: 'Open edges branch',
  notFlat: "Open edges don't lie flat",
  lip: 'Open edges run along a lip',
}

/** The full reason, shown for the selected item while its open edges are highlighted. */
export const REASON_SENTENCE: Record<OpenReason, string> = {
  branches: "The highlighted edges are open. They branch or stop short, so Hew can't tell where each opening ends.",
  notFlat: "The highlighted edges are open. They don't lie flat, so one flat face can't close them.",
  lip: 'The highlighted edges are open. They run along a flat lip, so a face there would cover the lip.',
}

/** Follows the reason: what the person can conclude. */
export const REASON_ON_PURPOSE =
  'Shapes like this are usually open on purpose, like a pipe fitting or an electrical box, and work as they are.'

/** A row's detail text in the panel and the wizard lists. */
export function rowDetail(
  kind: KindKey,
  openings: number,
  kept: boolean,
  reason: OpenReason = 'notFlat',
): string {
  switch (kind) {
    case 'openings':
      return count(openings, 'opening', 'openings')
    case 'split':
      return 'Piece of a split shape'
    case 'flatPanels':
      return kept ? 'Flat panel, kept' : 'Flat panel'
    case 'curvedSheets':
      return kept ? 'Curved sheet, kept' : 'Curved sheet'
    case 'closerLook':
      return REASON_SHORT[reason]
  }
}

/** Object Info's Geometry line for an object that isn't solid. */
export function geometryLine(kind: KindKey, openings: number, kept: boolean, reason: OpenReason = 'notFlat'): string {
  switch (kind) {
    case 'openings':
      return `Open: ${count(openings, 'opening', 'openings')}`
    case 'split':
      return 'Open: piece of a split shape'
    case 'flatPanels':
      return kept ? 'Flat panel (kept as is)' : 'Flat panel'
    case 'curvedSheets':
      return kept ? 'Curved sheet (kept as is)' : 'Curved sheet'
    case 'closerLook':
      // "Open edges branch": the reason already says the object is open.
      return REASON_SHORT[reason]
  }
}

/**
 * List labels that stay apart when several items share an imported name:
 * "Group#9", "Group#9 (2)", "Group#9 (3)".
 */
export function distinctLabels(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name} (${n})`
  })
}

/** " in all 4 copies" for a component used more than once, else "". */
export function copiesSuffix(placements: number): string {
  return placements > 1 ? ` in all ${placements} copies` : ''
}

// --------------------------------------------------------------- actions

export const ACTION = {
  close: 'Close',
  closeThis: 'Close this opening',
  closeAll: 'Close all',
  keep: 'Keep as is',
  keepAll: 'Keep all',
  unkeep: "Don't keep",
  addThickness: 'Add thickness…',
  rejoin: 'Rejoin',
  keepInsideWalls: 'Keep the inside walls',
  previousOpening: 'Previous opening',
  nextOpening: 'Next opening',
  showInList: 'Show in list',
  makeSolid: 'Make Solid…',
  ok: 'OK',
} as const

export const TOOLTIP = {
  close: (placements: number) => `Close every opening with a flat face${copiesSuffix(placements)}`,
  closeThis: (placements: number) => `Close the opening shown in the model${copiesSuffix(placements)}`,
  keep: (placements: number) => `Leave this as it is and hide it from this list${copiesSuffix(placements)}`,
  unkeep: (placements: number) => `List this again${copiesSuffix(placements)}`,
  addThickness: 'Give this panel a thickness so it becomes solid',
  closeAll: (n: number) => `Close the openings of ${count(n, 'object', 'objects')} in one step`,
  keepAll: (n: number) => `Keep ${count(n, 'object', 'objects')} as ${n === 1 ? 'it is' : 'they are'}, in one step`,
  addThicknessAll: 'Give these panels a thickness so they become solid',
  noCurvedThickness: "Hew can't add thickness to curved sheets yet",
  rejoin: 'Close the pieces where they meet and remove the inside walls between them',
  rejoinKeepingWalls: 'Close the pieces where they meet and keep the inside walls',
  previousOpening: 'Previous opening (Shift+Tab)',
  nextOpening: 'Next opening (Tab)',
} as const

// ----------------------------------------------------------------- panel

export const PANEL = {
  title: 'Model Health',
  scopeLastImport: 'Last import',
  scopeSelection: 'Selection',
  scopeModel: 'Whole model',
  useSelection: 'Use current selection',
  search: 'Search',
  showKept: 'Show kept panels and sheets',
  allSolid: 'Every object in the model is solid.',
  nothingSelected: 'Select something in the model first.',
  nothingImported: 'Nothing has been imported yet.',
  isSolid: 'This object is solid.',
  noMatches: 'Nothing matches your search.',
  showingOne: 'Showing one object',
  showAllObjects: 'Show all objects',
  useSelectionTitle: 'List the objects that are selected now',
  working: 'Working…',
} as const

/** The line under a row an action refused. */
export function rowWarning(action: 'close' | 'thicken' | 'keep', reason: string): string {
  const verb = action === 'close' ? "Couldn't close" : action === 'thicken' ? "Couldn't add thickness" : "Couldn't keep"
  return `${verb}: ${reason}`
}

/** Under a split-shape piece left alone because another piece refused. */
export const SPLIT_PIECE_LEFT = "Left as is, because another piece of this shape couldn't be closed."

// --------------------------------------------------------- undo and toasts

/** Undo-menu labels for the app's batches. */
export const UNDO_LABEL = {
  close: (n: number) => `Close ${count(n, 'object', 'objects')}`,
  keep: (n: number) => `Keep ${count(n, 'object', 'objects')} as is`,
  thicken: (n: number) => `Add thickness to ${count(n, 'panel', 'panels')}`,
  rejoin: (n: number) => `Rejoin ${count(n, 'split shape', 'split shapes')}`,
  makeSolid: 'Make Solid',
} as const

/**
 * A batch's toast: "Closed 11 objects." / "Closed 11 objects. 1 couldn't be
 * closed; see the list." / "Nothing was closed. 2 couldn't be closed; see
 * the list."
 */
export function batchToast(done: string, failedVerb: string, ok: number, failed: number): string {
  const head = ok > 0 ? `${done} ${count(ok, 'object', 'objects')}.` : `Nothing was ${failedVerb}.`
  if (failed === 0) return head
  return `${head} ${failed} couldn't be ${failedVerb}; see the list.`
}

// ---------------------------------------------------- import report, badge

/**
 * The import report's text. `verb` is "Imported" or "Opened". Objects that
 * aren't solid are stated as normal: SketchUp models are full of panels,
 * sheets and open shapes that work as they are.
 */
export function importSummary(verb: 'Imported' | 'Opened', objects: number, solid: number): string {
  const parts = [`${verb} ${count(objects, 'object', 'objects')}.`]
  if (solid === objects) {
    parts.push(objects === 1 ? 'It is solid.' : 'All of them are solid.')
    return parts.join(' ')
  }
  const rest = objects - solid
  if (solid > 0) parts.push(`${solid} ${solid === 1 ? 'is' : 'are'} solid.`)
  const lead = solid > 0 ? (rest === 1 ? 'The other one' : `The other ${rest}`) : rest === 1 ? 'It' : `All ${rest}`
  parts.push(
    rest === 1
      ? `${lead} is a panel, a sheet, or an open shape, like glass, terrain, or a pipe, which SketchUp models often have. It works as it is.`
      : `${lead} are panels, sheets, and open shapes, like glass, terrain, and pipes, which SketchUp models often have. They work as they are.`,
  )
  parts.push('To push, pull, combine, or 3D print one, make it solid first with Make Solid.')
  return parts.join(' ')
}

/** The import report's section labels. */
export const REPORT = {
  leftOut: (n: number) => `Parts left out (${n})`,
  missingTextures: (n: number) => `Missing textures (${n})`,
  details: (n: number) => `Details (${n})`,
} as const

/** The log line for an import ("12 solid, 5 not solid"). */
export function importLogSplit(solid: number, notSolid: number): string {
  return `${solid} solid, ${notSolid} not solid`
}

/** The status-bar badge's text: neutral either way. */
export function badgeText(objects: number, notSolid: number): string {
  if (notSolid > 0) return `${count(objects, 'object', 'objects')} · ${notSolid} not solid`
  return `${count(objects, 'object', 'objects')} ✓ solid`
}

/** The badge's tooltip when some objects aren't solid (clicking opens Model Health). */
export const BADGE_TOOLTIP_LIST = "List the objects that aren't solid"

export const OUTLINER_TOOLTIP = {
  open: 'Open shape: not solid',
  panel: 'Flat panel or curved sheet',
} as const

export const MENU = {
  makeSolid: 'Make Solid…',
  makeSolidHelp: 'Turn open shapes into solids so you can push, pull, combine, or 3D print them.',
  modelHealth: 'Model Health',
  modelHealthItem: 'Model Health…',
  modelHealthHelp: "Open the list of every object that isn't solid.",
} as const

/**
 * The line a not-solid refusal ends with (Push/Pull, Union/Subtract/
 * Intersect, Slice) and the STL/3MF warning's hint.
 */
export const MAKE_SOLID_HINT = 'To make it solid, select it and choose Object ▸ Make Solid…'

/** The STL/3MF export warning (`format` is "STL" or "3MF"). */
export const EXPORT_NOT_SOLID = {
  title: (format: string) => `Export ${format} Anyway?`,
  body: (format: string) => `These objects aren't solid, so the ${format} may not print cleanly:`,
  hint: 'Make Solid can close what can be closed.',
  makeSolid: 'Make Solid…',
  cancel: 'Cancel',
  exportAnyway: 'Export Anyway',
} as const

// ------------------------------------------------------- add thickness dialog

export const THICKNESS = {
  title: (n: number) => (n === 1 ? 'Add thickness' : `Add thickness to ${count(n, 'panel', 'panels')}`),
  field: 'Thickness',
  inFront: 'In front',
  behind: 'Behind',
  centered: 'Centered',
  confirm: 'Add thickness',
  cancel: 'Cancel',
  needValue: 'Enter a thickness, such as 3 mm.',
  needPositive: 'The thickness must be more than zero.',
} as const

// --------------------------------------------------------------- isolation

export function isolationBar(n: number): string {
  return `Showing ${count(n, 'object', 'objects')}`
}
export const SHOW_EVERYTHING = 'Show everything'

// ------------------------------------------------------------------ wizard

/** Where Make Solid runs: the last import, the selection, or the whole model. */
export type WizardScope = 'import' | 'selection' | 'model'

export const WIZARD = {
  title: 'Make Solid',
  back: 'Back',
  accept: 'Accept',
  showAll: 'Show all',
  chooseEach: 'Choose for each item',
  makeThisSolid: 'Make solid',
  showMore: 'Show 200 more',
  close: 'Close',
  doneButton: 'Done',

  overviewTitle: (scope: WizardScope): string =>
    scope === 'selection' ? 'Make the selection solid' : scope === 'import' ? 'Make this import solid' : 'Make this model solid',
  overview: (scope: WizardScope, objects: number, solid: number): string => {
    const where = scope === 'import' ? 'in this import' : scope === 'selection' ? 'you selected' : 'in this model'
    const parts = [objects === 1 ? `Hew checked the object ${where}.` : `Hew checked the ${objects} objects ${where}.`]
    parts.push(solid === objects ? (objects === 1 ? 'It is solid.' : 'All of them are solid.') : `${solid} ${solid === 1 ? 'is' : 'are'} solid.`)
    if (solid < objects) parts.push('Open shapes work for most things; a solid can also be pushed, pulled, combined, and 3D printed.')
    return parts.join(' ')
  },
  acceptRecommended: 'Use recommended choices',
  stepByStep: 'Go step by step',
  nothingToFix: 'Every object here is solid.',

  // One overview line per page, with what Hew recommends.
  overviewLine: {
    openings: (n: number, close: boolean) =>
      `${count(n, 'shape has', 'shapes have')} openings: ${close ? 'close them' : 'leave them open'}.`,
    split: (n: number) => `${count(n, 'shape was', 'shapes were')} split into pieces: rejoin them.`,
    flatPanels: (n: number) => `${count(n, 'flat panel', 'flat panels')}: leave as ${n === 1 ? 'it is' : 'they are'}.`,
    curvedSheets: (n: number) => `${count(n, 'curved sheet', 'curved sheets')}: Hew can't make ${n === 1 ? 'it' : 'these'} solid yet.`,
    closerLook: (n: number) => `${count(n, 'shape', 'shapes')} can't be closed with flat faces.`,
  },

  openingsTitle: 'Openings',
  openingsBody:
    'These shapes have open sides or gaps. Most are open on purpose, like a duct, a pipe, or a box without a lid. Closing one adds a flat face across each opening, which makes it solid.',
  openingsClose: 'Close the openings',
  openingsLeave: 'Leave them open',

  splitTitle: 'Rejoin split shapes',
  splitBody:
    'SketchUp drew each of these as one shape with a wall inside it, and they arrived as separate pieces. Hew can close the pieces where they meet and remove the wall between them. Openings the shape was drawn with stay open.',
  splitRejoin: 'Rejoin the pieces and remove the inside walls',
  splitKeepWalls: 'Rejoin the pieces and keep the inside walls',
  splitLeave: 'Leave them as they are',

  panelsTitle: 'Flat panels',
  panelsBody: 'These are single flat faces, such as glass, signs, or a drawn floor. To make one solid, give it a thickness.',
  panelsKeep: 'Leave them as panels',
  panelsThicken: 'Add thickness',

  sheetsTitle: 'Curved sheets',
  sheetsBody:
    "These are single curved sheets, such as terrain or fabric. Hew can't add thickness to curved sheets yet, so they stay as they are.",
  sheetsKeep: 'Leave them as sheets',

  closerTitle: "Can't be closed",
  closerBody:
    "Hew can't close these with flat faces. Most are open on purpose, like a pipe fitting or an electrical box, and work as they are. Click one to see its open edges and why.",

  recommended: 'Recommended',
  copies: (n: number) => (n > 1 ? `${n} copies` : ''),

  readyTitle: 'Ready',
  ready: {
    close: (n: number) => `Close the openings in ${count(n, 'shape', 'shapes')}.`,
    rejoin: (n: number, keepWalls: boolean) =>
      keepWalls
        ? `Rejoin ${count(n, 'split shape', 'split shapes')} and keep the inside walls.`
        : `Rejoin ${count(n, 'split shape', 'split shapes')}.`,
    thicken: (n: number, thickness: string) => `Give ${count(n, 'flat panel', 'flat panels')} a thickness of ${thickness}.`,
    leave: (n: number) => `Leave ${count(n, 'object', 'objects')} as ${n === 1 ? 'it is' : 'they are'}.`,
    nothing: 'Nothing will change. Go back to make a choice, or close this window.',
  },
  fix: 'Make Solid',
  working: 'Working…',

  doneTitle: 'Done',
  done: (solidNow: number): string =>
    solidNow === 0
      ? 'No object became solid. To undo what did change, choose Edit ▸ Undo.'
      : `${count(solidNow, 'object is', 'objects are')} solid now. To undo all of it, choose Edit ▸ Undo.`,
  stillOpen: (n: number) => `${count(n, 'shape', 'shapes')} can't be closed:`,
  couldntFix: (n: number) => `Hew couldn't make ${n === 1 ? 'this one' : `these ${n}`} solid:`,
  leftAsChosen: (n: number) => `${count(n, 'object was', 'objects were')} left as you chose.`,
  nothingChangedTitle: 'Nothing changed',
  nothingChanged: 'Nothing was changed, so there is nothing to undo.',
} as const
