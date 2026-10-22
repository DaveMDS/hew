// Verify-gate completeness check for shipped catalogs (docs/LOCALIZATION.md).
//
// A locale is offered to users only when every message in its catalog has
// a translation. `lingui compile --strict` cannot express "strict for the
// shipped locales, lenient for the ones still being translated", so this
// reads the .po files directly: any entry in a SHIPPED locale's catalog
// whose msgstr is empty fails the gate. The source locale is exempt (its
// msgstr is its msgid by definition).
//
// Run from app/: `node scripts/i18n-check.mjs`.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SHIPPED_LOCALES, SOURCE_LOCALE } from '../src/i18n/locales.ts'
import { parsePo } from './po.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failed = false
for (const locale of SHIPPED_LOCALES) {
  if (locale === SOURCE_LOCALE) continue
  const path = resolve(root, 'src/locales', locale, 'messages.po')
  const entries = parsePo(readFileSync(path, 'utf8'))
  const missing = entries.filter((e) => e.untranslated)
  if (missing.length > 0) {
    failed = true
    console.error(`i18n-check: ${locale} is shipped but ${missing.length} of ${entries.length} messages are untranslated:`)
    for (const e of missing.slice(0, 20)) console.error(`  ${JSON.stringify(e.msgid)}`)
    if (missing.length > 20) console.error(`  … and ${missing.length - 20} more`)
  } else {
    console.log(`i18n-check: ${locale} complete (${entries.length} messages)`)
  }
}
if (failed) process.exit(1)
