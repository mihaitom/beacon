// Real-browser test for the person segmenter - run via `pnpm test:layout`.
// It is WebAssembly plus a model file served as build assets, none of
// which jsdom can load; this is what shows the wiring works where the
// app runs.
import { describe, expect, it } from 'vitest'
import { loadSegmenter, personAtLeftEdge } from '../personAtEdge'

/** A plain grey 1920x1080 picture with a dark block in the middle -
 * nothing a segmenter would take for a person. */
function plainUrl(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgb(120, 120, 120)'
  ctx.fillRect(0, 0, 1920, 1080)
  ctx.fillStyle = 'rgb(30, 30, 30)'
  ctx.fillRect(760, 200, 400, 880)
  return canvas.toDataURL()
}

describe('personAtLeftEdge', () => {
  it('loads the segmenter from the bundled files', async () => {
    expect(await loadSegmenter()).not.toBeNull()
  }, 30000)

  it('finds no person at the edge of a picture with none', async () => {
    expect(await personAtLeftEdge(plainUrl(), { ratio: 16 / 9, positionY: 0.5 })).toBe(false)
  }, 30000)
})
