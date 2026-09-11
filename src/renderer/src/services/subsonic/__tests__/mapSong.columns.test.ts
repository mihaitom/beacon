// The fields behind the optional song columns, on their way from a list
// response into the Song model. They are only worth having because a list
// entry already carries them (see RawSong's own comment) - nothing here
// fetches anything.
import { describe, expect, it } from 'vitest'
import { mapSong } from '../mappers'

describe('mapSong, column fields', () => {
  it('keeps what an OpenSubsonic list entry carries', () => {
    const song = mapSong({
      id: 's1',
      title: 'Song',
      created: '2026-04-25T18:51:26.473Z',
      played: '2026-09-10T16:45:53.047Z',
      size: 10184585,
      bpm: 128,
      samplingRate: 44100,
      bitDepth: 24,
      comment: 'ripped from vinyl',
      path: 'Artist/Album/01-04 - Song.mp3',
    })

    expect(song.added).toBe('2026-04-25T18:51:26.473Z')
    expect(song.lastPlayed).toBe('2026-09-10T16:45:53.047Z')
    expect(song.size).toBe(10184585)
    expect(song.bpm).toBe(128)
    expect(song.sampleRate).toBe(44100)
    expect(song.bitDepth).toBe(24)
    expect(song.comment).toBe('ripped from vinyl')
    expect(song.path).toBe('Artist/Album/01-04 - Song.mp3')
  })

  it('reads a plain Subsonic entry, which has none of them, as nothing', () => {
    const song = mapSong({ id: 's1', title: 'Song' })

    expect(song.added).toBeNull()
    expect(song.lastPlayed).toBeNull()
    expect(song.size).toBeNull()
    expect(song.bpm).toBeNull()
    expect(song.path).toBeNull()
  })

  it('reads Navidrome\'s zero for an untagged file as "no value"', () => {
    // Navidrome answers with 0 rather than omitting the field for a file
    // that carries no BPM/bit-depth tag at all - taken at face value, the
    // column would print "0" where it should be blank, and sort those
    // tracks as the slowest in the library.
    const song = mapSong({ id: 's1', title: 'Song', bpm: 0, bitDepth: 0, samplingRate: 0 })

    expect(song.bpm).toBeNull()
    expect(song.bitDepth).toBeNull()
    expect(song.sampleRate).toBeNull()
  })

  it('reads an empty comment as no comment', () => {
    expect(mapSong({ id: 's1', title: 'Song', comment: '' }).comment).toBeNull()
  })
})
