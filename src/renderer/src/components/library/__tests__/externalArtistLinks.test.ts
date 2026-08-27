import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_LINK_META,
  EXTERNAL_LINK_ORDER,
  type ExternalLinkKey,
} from '../externalArtistLinks'

describe('EXTERNAL_LINK_META', () => {
  /** The packaged desktop build serves index.html over file://, where an
   * absolute '/x.svg' resolves against the filesystem root rather than the
   * app directory, so every icon renders empty. Vite rewrites index.html's
   * own asset references to './' for exactly this reason but never touches
   * a path written as a string in TypeScript, which is what these are. */
  it('addresses every icon relative to index.html, never from the root', () => {
    for (const [key, meta] of Object.entries(EXTERNAL_LINK_META)) {
      expect(meta.icon, `${key}'s icon must not start with '/'`).toMatch(/^\.\//)
    }
  })

  it('points every icon at a file that is actually in public/', () => {
    for (const [key, meta] of Object.entries(EXTERNAL_LINK_META)) {
      const file = resolve('src/renderer/public', meta.icon.replace(/^\.\//, ''))
      expect(existsSync(file), `${key}: ${meta.icon} is missing from public/`).toBe(true)
    }
  })

  it('covers every service in the render order', () => {
    for (const key of EXTERNAL_LINK_ORDER) {
      expect(EXTERNAL_LINK_META[key as ExternalLinkKey]).toBeDefined()
    }
  })
})
