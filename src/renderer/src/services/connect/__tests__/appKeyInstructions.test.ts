// What gets pasted into an AI assistant: it has to fit the key it is for.
import { describe, expect, it } from 'vitest'
import { appKeyInstructions } from '../appKeyInstructions'

const ORIGIN = 'https://beacon.example'

describe('appKeyInstructions', () => {
  it('points at the description on this server', () => {
    expect(appKeyInstructions(ORIGIN, ['history'])).toContain(
      'https://beacon.example/device-link/v1/openapi.json',
    )
  })

  it('tells the assistant only about what the key can reach', () => {
    const text = appKeyInstructions(ORIGIN, ['stats'])
    expect(text).toContain('timestamps')
    expect(text).not.toContain('next_cursor')
    expect(text).not.toContain('position')
  })

  it('names how lyrics line up when the key may read them', () => {
    expect(appKeyInstructions(ORIGIN, ['now_playing', 'lyrics'])).toContain('position - offset')
    expect(appKeyInstructions(ORIGIN, ['now_playing'])).not.toContain('position - offset')
  })
})
