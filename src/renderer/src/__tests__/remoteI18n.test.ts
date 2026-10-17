import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES } from '@/i18n'

/** The Remote Control's translations (connect/static/remote/js/locales/)
 * are plain JS with no build step and no type check of their own - this is
 * what `satisfies typeof de` does for the app's: every language has every
 * key, and every key the page asks for exists. */

const REMOTE = resolve(__dirname, '../../../../connect/static/remote')
const locales: Record<string, Record<string, string>> = {}

beforeAll(async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const url = pathToFileURL(resolve(REMOTE, `js/locales/${locale}.js`)).href
    locales[locale] = (await import(/* @vite-ignore */ url)).default
  }
})

function sources(): string[] {
  const files = ['index.html', 'app.js']
  for (const dir of ['js', 'js/views']) {
    for (const name of readdirSync(resolve(REMOTE, dir))) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`)
    }
  }
  return files.map((file) => readFileSync(resolve(REMOTE, file), 'utf8'))
}

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("the Remote Control's translations", () => {
  it('cover the same keys in every language, none of them empty', () => {
    const english = Object.keys(locales.en!).sort()
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(locales[locale]!).sort(), locale).toEqual(english)
      for (const [key, message] of Object.entries(locales[locale]!)) {
        expect(message.trim(), `${locale} ${key}`).not.toBe('')
        expect(placeholders(message), `${locale} ${key}`).toEqual(placeholders(locales.en![key]!))
      }
    }
  })

  it('have every key the page asks for', () => {
    const used = new Set<string>()
    for (const source of sources()) {
      for (const m of source.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]!)
      for (const m of source.matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) used.add(m[1]!)
      // Keys picked from a table (library.js's VIEWS, favorites.js's EMPTY).
      for (const m of source.matchAll(/:\s*'((?:library|favorites)\.[\w]+)'/g)) used.add(m[1]!)
    }
    expect(used.size).toBeGreaterThan(40)
    const missing = [...used].filter((key) => !(key in locales.en!))
    expect(missing).toEqual([])
  })
})
