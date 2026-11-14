// The page's play message comes from code Beacon does not control: these
// pin what gets through and what is dropped, not the wording of anything.
import { describe, expect, it } from 'vitest'
import { MAX_PLAY_ITEMS, isExternalSourceSong, parsePlayMessage } from '../externalSource'

describe('parsePlayMessage', () => {
  it('reads a complete message', () => {
    expect(
      parsePlayMessage({
        type: 'beacon.play',
        mode: 'next',
        item: {
          audioUrl: 'a.mp3',
          title: 'T',
          artist: 'A',
          album: 'B',
          coverUrl: 'c.jpg',
          duration: 201,
        },
      }),
    ).toEqual({
      mode: 'next',
      items: [
        {
          audioUrl: 'a.mp3',
          title: 'T',
          artist: 'A',
          album: 'B',
          coverUrl: 'c.jpg',
          duration: 201,
        },
      ],
    })
  })

  it('reads several songs in their order', () => {
    const parsed = parsePlayMessage({
      type: 'beacon.play',
      items: [{ audioUrl: '2.mp3' }, { audioUrl: '1.mp3' }],
    })
    expect(parsed?.items.map((item) => item.audioUrl)).toEqual(['2.mp3', '1.mp3'])
  })

  it('plays now when the mode is missing or unknown', () => {
    expect(parsePlayMessage({ type: 'beacon.play', item: { audioUrl: 'a' } })?.mode).toBe('now')
    expect(
      parsePlayMessage({ type: 'beacon.play', mode: 'replace-library', item: { audioUrl: 'a' } })
        ?.mode,
    ).toBe('now')
  })

  it.each([
    null,
    'beacon.play',
    { type: 'beacon.other', item: { audioUrl: 'a' } },
    { type: 'beacon.play' },
    { type: 'beacon.play', item: { title: 'no audio' } },
    { type: 'beacon.play', item: { audioUrl: 42 } },
    { type: 'beacon.play', item: { audioUrl: '' } },
    { type: 'beacon.play', items: [] },
    // One bad song spoils the lot: half an album would be a surprise.
    { type: 'beacon.play', items: [{ audioUrl: 'a' }, { title: 'no audio' }] },
    {
      type: 'beacon.play',
      items: Array.from({ length: MAX_PLAY_ITEMS + 1 }, () => ({ audioUrl: 'a' })),
    },
  ])('ignores %j', (data) => {
    expect(parsePlayMessage(data)).toBeNull()
  })

  it('drops fields of the wrong type and a duration that is no length', () => {
    const parsed = parsePlayMessage({
      type: 'beacon.play',
      item: { audioUrl: 'a', title: { html: '<b>' }, duration: 'soon' },
    })
    expect(parsed?.items[0]?.title).toBeUndefined()
    expect(parsed?.items[0]?.duration).toBeUndefined()
  })

  it('cuts overlong text', () => {
    const parsed = parsePlayMessage({
      type: 'beacon.play',
      item: { audioUrl: 'a', title: 'x'.repeat(5000) },
    })
    expect(parsed?.items[0]?.title).toHaveLength(500)
  })
})

describe('isExternalSourceSong', () => {
  it('tells an external song from a library one', () => {
    expect(isExternalSourceSong({ id: 'ext:abc' })).toBe(true)
    expect(isExternalSourceSong({ id: 'abc' })).toBe(false)
    expect(isExternalSourceSong(null)).toBe(false)
  })
})
