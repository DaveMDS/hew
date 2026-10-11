import type { Scene as WasmScene } from '../wasm/loader'

/** The annotations the viewport draws and picks: every live one whose tags
 * are all shown (an annotation on a hidden tag hides with it). A scene
 * without the queries (a test double) shows what it has. */
export function shownAnnotationIds(scene: WasmScene): BigUint64Array {
  if (typeof scene.shown_annotation_ids === 'function') return scene.shown_annotation_ids()
  if (typeof scene.annotation_ids === 'function') return scene.annotation_ids()
  return new BigUint64Array()
}
