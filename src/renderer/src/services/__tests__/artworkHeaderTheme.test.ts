import { describe, expect, it } from 'vitest'
import { artworkHeaderTheme } from '../artworkHeaderTheme'
import type { EdgeFills } from '../edgeFill'

const themes = { theme: 'glacier', nightTheme: 'glacier-night', dayTheme: 'glacier' }

function edge(flat: string): EdgeFills {
  return { left: { gradient: 'none', flat }, right: { gradient: 'none', flat: 'rgb(0, 0, 0)' } }
}

describe('artworkHeaderTheme', () => {
  it('draws a card over art with a dark left edge dark, even on a light theme', () => {
    expect(artworkHeaderTheme(true, edge('rgb(12, 14, 20)'), themes)).toBe('glacier-night')
  })

  it('draws a card over art with a light left edge light, even on a dark theme', () => {
    const dark = { theme: 'beacon', nightTheme: 'beacon', dayTheme: 'beacon-day' }
    expect(artworkHeaderTheme(true, edge('rgb(240, 236, 228)'), dark)).toBe('beacon-day')
  })

  it('goes by the left edge, which is the one under the text', () => {
    const fills = {
      left: { gradient: 'none', flat: 'rgb(250, 250, 250)' },
      right: edge('rgb(0, 0, 0)').right,
    }
    expect(artworkHeaderTheme(true, fills, themes)).toBe('glacier')
  })

  it("keeps the page's theme over the blurred cover and while the edge is unread", () => {
    expect(artworkHeaderTheme(false, edge('rgb(0, 0, 0)'), themes)).toBe('glacier')
    expect(artworkHeaderTheme(true, null, themes)).toBe('glacier')
  })
})
