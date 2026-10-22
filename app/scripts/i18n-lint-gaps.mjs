// Companion to `oxlint` for docs/LOCALIZATION.md: `lingui/no-unlocalized-strings`
// checks only `placeholder`, `alt`, `aria-label` and `value` attributes on
// native DOM tags, so a literal `title="…"` tooltip passes it unseen. This
// flags any `title="…"` with real words in the app's JSX (tests excluded).
// Run from app/: `node scripts/i18n-lint-gaps.mjs`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(app, 'src')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'wasm' || name === 'locales' || name === 'test') continue
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) yield p
  }
}

const TITLE_LITERAL = /\btitle="([^"]*[A-Za-z]{3,}[^"]*)"/g
let hits = 0
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (line.includes('oxlint-disable')) return
    for (const m of line.matchAll(TITLE_LITERAL)) {
      hits++
      console.error(`${relative(app, file)}:${i + 1}: title="${m[1]}" is not wrapped for translation (use title={t\`…\`})`)
    }
  })
}
if (hits > 0) {
  console.error(`i18n-lint-gaps: ${hits} unwrapped title attribute(s)`)
  process.exit(1)
}
console.log('i18n-lint-gaps: no unwrapped title attributes')
