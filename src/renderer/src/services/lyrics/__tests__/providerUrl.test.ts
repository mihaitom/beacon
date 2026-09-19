import { describe, expect, it } from 'vitest'
import { lyricsPageUrl } from '../providerUrl'

describe('lyricsPageUrl', () => {
  it.each([
    ['lrclib.net', '19058030', 'https://lrclib.net/tracks/19058030'],
    ['NetEase', '2310569', 'https://music.163.com/#/song?id=2310569'],
    ['SimpMusic', 'lLN-dhBuoWo', 'https://lyrics.simpmusic.org/#/video/lLN-dhBuoWo'],
  ])('points %s at its own page for the sheet', (source, id, url) => {
    expect(lyricsPageUrl(source, id)).toBe(url)
  })

  it('has nothing to point at for the file, or without an id', () => {
    expect(lyricsPageUrl('file', null)).toBeNull()
    expect(lyricsPageUrl('lrclib.net', null)).toBeNull()
  })

  it('has nothing to point at for a source it does not know', () => {
    expect(lyricsPageUrl('SomeFutureProvider', '1')).toBeNull()
  })
})
