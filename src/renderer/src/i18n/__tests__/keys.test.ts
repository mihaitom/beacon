import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import de from '../locales/de'
import en from '../locales/en'
import es from '../locales/es'
import fr from '../locales/fr'
// Aliased: an unaliased `it` here shadows vitest's own `it`, and the whole
// file then fails to collect with "default is not a function".
import italian from '../locales/it'

const messages = { de, en, es, fr, it: italian }

/** Every translation key the app asks for, checked against every language
 * it offers.
 *
 * vue-i18n answers a key it doesn't have with the key itself, so a typo (or
 * a key put in the wrong section) renders as `library.playAll` in the
 * middle of the UI and nothing anywhere fails. That is exactly how one
 * reached a released-looking build: a context-menu entry showed its own key
 * because the string it wanted lives under `home`, not `library`.
 *
 * Read out of the source text rather than by mounting anything: a component
 * test only ever exercises the branches it happens to render, and the entry
 * in question sits behind a right-click on one kind of tile. */
const SRC = resolve(__dirname, '../..')

// $t('key'), t('key'), i18n.global.t('key') — literal keys only. A key
// built at runtime (`$t(entry.labelKey)`, `$t(\`library.${kind}\`)`) is not
// something this can resolve, and is deliberately left to the components
// that do that (see KeyboardShortcutsDialog's SHORTCUT_HELP, whose keys are
// literals in a table of its own and so are caught here anyway).
const KEY_CALL = /(?:^|[^\w$])\$?t\(\s*'([a-zA-Z][\w.]*)'/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      // The locales themselves are the answer key, not a caller of it.
      if (entry === '__tests__' || entry === 'locales') return []
      return sourceFiles(path)
    }
    return /\.(vue|ts)$/.test(entry) ? [path] : []
  })
}

function usedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(KEY_CALL)) {
      const key = match[1]!
      // A key is always section.name here; a bare word is some other t().
      if (!key.includes('.')) continue
      const users = keys.get(key) ?? []
      users.push(file.slice(SRC.length + 1))
      keys.set(key, users)
    }
  }
  return keys
}

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([name, child]) =>
    flatten(child, prefix ? `${prefix}.${name}` : name),
  )
}

const locales = Object.keys(messages) as (keyof typeof messages)[]

describe('translation keys', () => {
  it('has every key the app asks for', () => {
    const available = new Set(flatten(messages.en))
    const missing = [...usedKeys()]
      .filter(([key]) => !available.has(key))
      .map(([key, users]) => `${key} (used in ${users.join(', ')})`)

    expect(missing).toEqual([])
  })

  it('offers the same keys in every language', () => {
    // A key only some languages have is the same failure as a missing one,
    // just for whoever picked that language.
    const english = flatten(messages.en).sort()
    for (const locale of locales) {
      expect({ locale, keys: flatten(messages[locale]).sort() }).toEqual({ locale, keys: english })
    }
  })
})
