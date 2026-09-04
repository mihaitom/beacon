import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

/** The four places that lay out the same fixed-width cards. Each pairs a
 * JS constant (used to work out how many cards fit per row) with the CSS
 * rule that actually spaces them — and the two have to agree, or the
 * column maths describes a layout the browser isn't drawing. The constants
 * don't always live in the same file as the rule any more: the two shelves
 * share theirs (see components/library/cardRowFit.ts), which is what makes
 * them count the same number of cards into a row of the same width.
 *
 * Checked against the source text because the relationship is invisible to
 * a mounted test: jsdom computes no layout at all, so a stylesheet that
 * drifts from its constant renders "correctly" under every component test
 * in this suite. That drift is not hypothetical — the albums grid sat at a
 * 16px gap while the shelves and the artists grid used 20px, showing the
 * very same AlbumCards at two different spacings. */
const GRIDS = [
  {
    file: 'src/renderer/src/views/ArtistsView.vue',
    constant: 'ARTIST_GAP',
    rule: '.artist-grid',
    widthConstant: 'ARTIST_ITEM_WIDTH',
  },
  {
    file: 'src/renderer/src/views/AlbumsView.vue',
    constant: 'ALBUM_GAP',
    rule: '.album-grid',
    widthConstant: 'ALBUM_ITEM_WIDTH',
  },
  {
    file: 'src/renderer/src/components/library/AlbumShelf.vue',
    constants: 'src/renderer/src/components/library/cardRowFit.ts',
    constant: 'CARD_GAP',
    rule: '.album-shelf-row',
    widthConstant: 'CARD_WIDTH',
  },
  {
    file: 'src/renderer/src/components/library/CardShelf.vue',
    constants: 'src/renderer/src/components/library/cardRowFit.ts',
    constant: 'CARD_GAP',
    rule: '.card-shelf__row',
    widthConstant: 'CARD_WIDTH',
  },
] as const

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8')
}

function constantValue(text: string, name: string): number {
  const match = text.match(new RegExp(`const ${name} = (\\d+)`))
  if (!match?.[1]) throw new Error(`no "const ${name}" in source`)
  return Number(match[1])
}

/** The `gap` of one CSS rule, read from the block that follows its selector. */
function ruleGap(text: string, selector: string): number {
  const start = text.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no "${selector}" rule in source`)
  const block = text.slice(start, text.indexOf('}', start))
  const match = block.match(/gap:\s*(\d+)px/)
  if (!match?.[1]) throw new Error(`no gap in "${selector}"`)
  return Number(match[1])
}

/** Where a grid's constants live — the same file as its CSS unless it says
 * otherwise. */
function constantsSource(grid: (typeof GRIDS)[number]): string {
  return source('constants' in grid ? grid.constants : grid.file)
}

describe('card grid spacing', () => {
  it.each(GRIDS)('$rule spaces cards the way its constant claims', (grid) => {
    expect(ruleGap(source(grid.file), grid.rule)).toBe(
      constantValue(constantsSource(grid), grid.constant),
    )
  })

  it('spaces the same cards identically everywhere they appear', () => {
    const gaps = GRIDS.map((g) => constantValue(constantsSource(g), g.constant))
    const widths = GRIDS.map((g) => constantValue(constantsSource(g), g.widthConstant))

    // Same card, same rhythm — a grid and a shelf of AlbumCards sitting
    // side by side in the app must not use different spacing.
    expect(new Set(gaps).size).toBe(1)
    expect(new Set(widths).size).toBe(1)
  })
})
