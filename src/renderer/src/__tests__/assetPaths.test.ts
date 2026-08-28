import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = resolve('src/renderer/src')
const PUBLIC_DIR = resolve('src/renderer/public')

const ASSET_EXTENSIONS = 'svg|png|jpe?g|webp|gif|ico|avif|woff2?|mp3|webmanifest'

/** An asset path written as a string literal (or a CSS url()) that starts
 * at the root: `'/spotify.svg'`, `src="/logo.png"`, `url(/bg.webp)`. The
 * opening quote or paren right before the slash is what keeps real URLs
 * ('https://host/x.svg') and API routes ('/rest/ping.view') out of it. */
const ROOT_ABSOLUTE_ASSET = new RegExp(`["'\`(]/[A-Za-z0-9_@./-]+\\.(?:${ASSET_EXTENSIONS})`, 'g')

/** The same thing written the way it belongs — used to check the file it
 * names is actually there. */
const RELATIVE_ASSET = new RegExp(`["'\`(]\\./([A-Za-z0-9_@-]+\\.(?:${ASSET_EXTENSIONS}))`, 'g')

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      // Test files legitimately spell out the broken form (this one does).
      if (entry === '__tests__' || entry === 'node_modules') continue
      found.push(...sourceFiles(path))
      continue
    }
    if (/\.(ts|vue|css)$/.test(entry)) found.push(path)
  }
  return found
}

/** Strips comments before scanning: several of them spell out an example
 * path (including the one right below), and a comment cannot break a build.
 * `//` is only treated as one when it isn't the '//' of a URL. */
function withoutComments(contents: string): string {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function matchesIn(regex: RegExp, contents: string): string[] {
  return Array.from(withoutComments(contents).matchAll(regex), (match) => match[0].slice(1))
}

describe('asset paths across the renderer', () => {
  const files = sourceFiles(RENDERER_SRC)

  it('has sources to check in the first place', () => {
    // Guards the two tests below against silently passing on an empty list
    // if the walk above ever stops finding anything.
    expect(files.length).toBeGreaterThan(100)
  })

  /** The packaged desktop build serves index.html over file://, where an
   * absolute '/x.svg' resolves against the filesystem root instead of the
   * app directory and the asset just renders empty — no error anywhere.
   * Vite rewrites index.html's own references to './' for exactly this
   * reason, but never touches a path written as a string in TypeScript or
   * in a template attribute. That is how the seven service logos went
   * missing from every desktop build from 0.1.4 on, visible on the Home
   * view as well as the artist page, until 2026-08-28. */
  it('addresses every asset relative to index.html, never from the root', () => {
    const offenders: string[] = []
    for (const file of files) {
      for (const match of matchesIn(ROOT_ABSOLUTE_ASSET, readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(`${RENDERER_SRC}/`, '')}: ${match}`)
      }
    }

    expect(offenders, `write these as './…' instead:\n${offenders.join('\n')}`).toEqual([])
  })

  it('names a file that is actually in public/', () => {
    // The other half of the same failure: a relative path is only as good
    // as the file it points at, and a renamed asset fails just as quietly.
    const missing: string[] = []
    for (const file of files) {
      for (const match of matchesIn(RELATIVE_ASSET, readFileSync(file, 'utf8'))) {
        const asset = match.replace(/^\.\//, '')
        if (!existsSync(join(PUBLIC_DIR, asset))) {
          missing.push(`${file.replace(`${RENDERER_SRC}/`, '')}: ${match}`)
        }
      }
    }

    expect(missing, `missing from src/renderer/public:\n${missing.join('\n')}`).toEqual([])
  })
})
