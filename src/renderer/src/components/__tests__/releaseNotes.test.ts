import { describe, expect, it } from 'vitest'
import { renderNotes } from '../releaseNotes.vue'

describe('release notes', () => {
  it('opens a link in a window of its own, not in place of the app', () => {
    const html = renderNotes('Please [open an issue](https://github.com/mihaitom/beacon/issues).')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does the same for a bare address', () => {
    expect(renderNotes('See https://example.com for more.')).toContain('target="_blank"')
  })
})
