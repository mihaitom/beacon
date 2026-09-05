import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { MOBILE_ROW_ART_SIZE } from '@/components/mobile/rowMetrics'

/**
 * Beacon shows the same lists on the same phone two ways: the mobile web
 * view (Vue, scoped styles, Vuetify tokens) and the LAN remote (plain HTML
 * and one hand-written stylesheet, deliberately without a build step). They
 * are separate codebases with no shared stylesheet, and they drifted — 40
 * vs 44 vs 48px artwork, a title at 16px on one side and 14px on the other,
 * a separator on one and not the other, one client's mini player matching
 * neither. Every one of those was found by eye, weeks apart.
 *
 * Comments cross-referencing each other did not prevent any of it, so this
 * is the tripwire instead: the handful of values that have to agree,
 * checked against the source text of both sides. It is deliberately not a
 * generator — the numbers stay written where they are used and read, and
 * this only fails when the two stop matching.
 *
 * What it cannot catch: a value only one side has. If the remote grows a
 * control the web view has no counterpart for, nothing here notices — this
 * pins the shared contract, not the whole design.
 */
const ROOT = resolve(__dirname, '../../../..')
const remoteCss = readFileSync(resolve(ROOT, 'connect/static/remote/app.css'), 'utf8')
const baseCss = readFileSync(resolve(ROOT, 'src/renderer/src/assets/base.css'), 'utf8')

/** One declaration out of one rule — tolerant of reordering and reformatting
 * inside the block, unlike matching the whole rule as a string. */
function declaration(css: string, selector: string, property: string): string {
  const rule = new RegExp(`(^|[},/*\\s])${escapeSelector(selector)}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  )
  expect(rule, `no rule for "${selector}"`).not.toBeNull()
  const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'm').exec(rule![2]!)
  expect(value, `"${selector}" declares no ${property}`).not.toBeNull()
  return value![1]!.trim()
}

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A custom property off :root, whichever file it lives in. */
function token(css: string, name: string): string {
  return declaration(css, ':root', name)
}

describe('the mobile web view and the phone remote', () => {
  it('draw list artwork at the same size', () => {
    // The web side's is a JS constant because CoverArt takes a prop; the
    // remote's is plain CSS. Same number either way, or the two lists sit
    // side by side on one phone looking like two products.
    expect(declaration(remoteCss, '.row-art', 'width')).toBe(`${MOBILE_ROW_ART_SIZE}px`)
    expect(declaration(remoteCss, '.row-art', 'height')).toBe(`${MOBILE_ROW_ART_SIZE}px`)
  })

  it('give a list row the same height', () => {
    expect(declaration(remoteCss, '.row', 'min-height')).toBe(
      declaration(baseCss, '.mobile-row', 'min-height'),
    )
  })

  /** Vuetify's own body-medium/body-small, which the web view's rows use by
   * class. The remote has no Vuetify, so it spells the same two values out
   * — and this is what says they are the same two values. */
  it('set the two lines of a row in the same type', () => {
    expect(declaration(remoteCss, '.row-title', 'font-size')).toBe('0.875rem')
    expect(declaration(remoteCss, '.row-subtitle', 'font-size')).toBe('0.75rem')
  })

  it('separate rows the same way, last one included', () => {
    expect(declaration(remoteCss, '.row', 'border-bottom')).toContain('1px solid')
    expect(declaration(baseCss, '.mobile-row', 'border-bottom')).toContain('1px solid')
    // Neither underlines the end of a list.
    expect(declaration(remoteCss, '.row:last-child', 'border-bottom')).toBe('none')
    expect(declaration(baseCss, '.mobile-row:last-child', 'border-bottom')).toBe('none')
  })

  it('use the same chrome colour and the same hairline', () => {
    expect(token(remoteCss, '--chrome').toLowerCase()).toBe(
      token(baseCss, '--beacon-chrome').toLowerCase(),
    )
    expect(token(remoteCss, '--border').replace(/\s/g, '')).toBe(
      token(baseCss, '--beacon-hairline').replace(/\s/g, ''),
    )
  })
})
