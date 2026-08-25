import { describe, expect, it } from 'vitest'
import { createBackdropLayers, showBackdrop } from '../crossfadeBackdrop'

describe('crossfadeBackdrop', () => {
  it('starts with two empty layers so nothing renders before the first artwork', () => {
    const layers = createBackdropLayers()

    expect(layers.urls).toEqual([null, null])
    expect(layers.urls[layers.active]).toBeNull()
  })

  it('shows the first artwork by making a layer active, so it fades in', () => {
    const layers = createBackdropLayers()

    showBackdrop(layers, 'one.jpg')

    expect(layers.urls[layers.active]).toBe('one.jpg')
  })

  it('keeps the previous artwork on the other layer to fade out of', () => {
    const layers = createBackdropLayers()
    showBackdrop(layers, 'one.jpg')
    const previous = layers.active

    showBackdrop(layers, 'two.jpg')

    // The whole point: both images exist at once for the length of the
    // transition. Overwriting the active layer instead would cut.
    expect(layers.active).not.toBe(previous)
    expect(layers.urls[layers.active]).toBe('two.jpg')
    expect(layers.urls[previous]).toBe('one.jpg')
  })

  it('alternates rather than growing, however many changes go through it', () => {
    const layers = createBackdropLayers()
    const seen = new Set<number>()

    for (const url of ['a', 'b', 'c', 'd', 'e']) {
      showBackdrop(layers, url)
      seen.add(layers.active)
    }

    expect(layers.urls).toHaveLength(2)
    expect([...seen].sort()).toEqual([0, 1])
    expect(layers.urls[layers.active]).toBe('e')
  })

  it('handles losing the artwork entirely — it fades out, it does not freeze', () => {
    // e.g. navigating to an album with no cover art at all.
    const layers = createBackdropLayers()
    showBackdrop(layers, 'one.jpg')

    showBackdrop(layers, null)

    expect(layers.urls[layers.active]).toBeNull()
  })
})
