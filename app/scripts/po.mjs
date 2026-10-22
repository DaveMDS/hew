// Minimal gettext .po reader shared by the i18n scripts: enough of the
// format to read msgctxt/msgid/msgstr (multi-line strings concatenated,
// header and obsolete `#~` entries skipped). Not a general parser.

export function parsePo(text) {
  const entries = []
  let cur = null
  let field = null
  const flush = () => {
    if (cur && cur.msgid !== '') entries.push(cur)
    cur = null
    field = null
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('#')) continue
    const m = /^(msgctxt|msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+"(.*)"$/.exec(line)
    if (m) {
      cur ??= { msgctxt: '', msgid: '', msgstr: '', forms: [] }
      if (m[1].startsWith('msgstr')) {
        // Each msgstr[n] is its own form: a plural counts as translated only
        // when every form is filled, so the check keeps them apart.
        cur.forms.push('')
        field = 'msgstr'
      } else {
        field = m[1] === 'msgid' ? 'msgid' : m[1] === 'msgctxt' ? 'msgctxt' : null
      }
      if (field === 'msgstr') cur.forms[cur.forms.length - 1] += unescape(m[2])
      else if (field) cur[field] += unescape(m[2])
      continue
    }
    const s = /^"(.*)"$/.exec(line)
    if (s && cur && field === 'msgstr') cur.forms[cur.forms.length - 1] += unescape(s[1])
    else if (s && cur && field) cur[field] += unescape(s[1])
  }
  flush()
  for (const e of entries) {
    // `msgstr` stays the joined text for lookups; `untranslated` is true when
    // any form is empty.
    e.msgstr = e.forms.join('')
    e.untranslated = e.forms.length === 0 || e.forms.some((f) => f === '')
  }
  return entries
}

function unescape(s) {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/** Map "<msgctxt>\u0004<msgid>" → msgstr for quick lookup. */
export function poLookup(entries) {
  const map = new Map()
  for (const e of entries) map.set(`${e.msgctxt}\u0004${e.msgid}`, e.msgstr)
  return map
}
