// Generate the desktop shell's native-menu label files
// (shells/tauri/src-tauri/locales/menu.<locale>.json) from
// src/i18n/nativeMenu.ts and the gettext catalogs (docs/LOCALIZATION.md
// "Native menus"). One file per SHIPPED locale; an untranslated entry falls
// back to English so a menu never shows a blank.
//
//   node scripts/i18n-menus.mjs          write the files
//   node scripts/i18n-menus.mjs --check  exit 1 if any file is stale
//
// Run from app/. The pure parts live in i18n-menus-lib.mjs so
// nativeMenuParity.test.ts can recompute the files and compare.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PSEUDO_LOCALE, SHIPPED_LOCALES } from '../src/i18n/locales.ts'
import { APP_DIR, MENU_LOCALES_DIR, menuFileFor, readTableRows } from './i18n-menus-lib.mjs'

const check = process.argv.includes('--check')
const rows = readTableRows()
if (rows.length === 0) {
  console.error('i18n-menus: no entries read from src/i18n/nativeMenu.ts — table shape changed?')
  process.exit(1)
}
let stale = false
// The pseudo-locale gets a menu file too (debug aid: lets the native menu
// be checked the way every other surface is), though it is never shipped.
for (const locale of [...SHIPPED_LOCALES, PSEUDO_LOCALE]) {
  const content = menuFileFor(rows, locale)
  const path = resolve(MENU_LOCALES_DIR, `menu.${locale}.json`)
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== content) {
      stale = true
      console.error(`i18n-menus: ${path} is stale; run \`pnpm --dir app i18n:menus\``)
    }
  } else {
    mkdirSync(MENU_LOCALES_DIR, { recursive: true })
    writeFileSync(path, content)
    console.log(`i18n-menus: wrote ${path.replace(APP_DIR + '/', '')} (${rows.length} labels)`)
  }
}
if (check && stale) process.exit(1)
