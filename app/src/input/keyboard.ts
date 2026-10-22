/**
 * Keyboard helpers for input-method-safe shortcuts (docs/LOCALIZATION.md
 * "Keyboard and input methods").
 *
 * Two facts drive these:
 *  - While an input method editor (IME) composes — Japanese, Chinese, Korean
 *    — keydown events arrive with `isComposing` set and `key` equal to
 *    "Process" (Chromium) or `keyCode` 229 (WebKit, which also delivers the
 *    confirming Enter AFTER `compositionend` with `isComposing` false but
 *    `keyCode` still 229). None of those keystrokes are commands.
 *  - `ev.key` is the character the layout produced ("l", "ｌ", "ł"); `ev.code`
 *    is the physical key ("KeyL"). Tool shortcuts follow SketchUp's physical
 *    key positions, so they dispatch on `code` and fall back to `key` only
 *    where a browser or virtual keyboard reports no code.
 */

/** True for any keystroke that belongs to an IME composition. */
export function isComposingKey(ev: {
  key: string
  keyCode: number
  /** Native events carry it directly. */
  isComposing?: boolean
  /** React's synthetic events do not copy `isComposing`; read it off the native one. */
  nativeEvent?: { isComposing: boolean }
}): boolean {
  return ev.isComposing === true || ev.nativeEvent?.isComposing === true || ev.key === 'Process' || ev.keyCode === 229
}

/**
 * The lowercase Latin letter a keydown's physical key stands for ("l" for
 * `KeyL`), or `null` when the key is not a letter key. Independent of the
 * active layout and IME, which is what a bare-letter tool shortcut wants.
 */
export function physicalLetter(ev: Pick<KeyboardEvent, 'code'>): string | null {
  const m = /^Key([A-Z])$/.exec(ev.code)
  return m === null ? null : m[1].toLowerCase()
}

/**
 * The letter a bare-letter shortcut should match. SketchUp binds LETTERS,
 * so when the keystroke produced a plain ASCII letter that letter wins —
 * on AZERTY or Dvorak the key cap the rail advertises is the one that
 * works. Only when the produced character is not an ASCII letter (an IME
 * that is on but idle producing a full-width "ｌ", a dead key, a layout
 * with no Latin letters) does the physical key position stand in.
 */
export function shortcutLetter(ev: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (/^[A-Za-z]$/.test(ev.key)) return ev.key.toLowerCase()
  return physicalLetter(ev) ?? ev.key.toLowerCase()
}
