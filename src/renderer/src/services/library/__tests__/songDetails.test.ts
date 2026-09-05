import { describe, expect, it } from 'vitest'
import { songDetailSections, type SongDetailRow } from '../songDetails'
import type { RawSongDetail } from '@/services/subsonic/types'

/** Every row of every section, flattened — most assertions here are about
 * what is and is not in the sheet at all.
 *
 * Takes a partial record on purpose: each case below stands for a server
 * that answered with exactly those fields and nothing else, which is the
 * situation the whole module exists for. */
function rows(detail: Partial<RawSongDetail>, locale = 'en'): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const row of Object.values(rowObjects(detail, locale))) flat[row.labelKey] = row.value
  return flat
}

/** The same, keeping the whole row - for the assertions that are about
 * more than its text. */
function rowObjects(detail: Partial<RawSongDetail>, locale = 'en'): Record<string, SongDetailRow> {
  const flat: Record<string, SongDetailRow> = {}
  for (const section of songDetailSections(detail as RawSongDetail, locale)) {
    for (const row of section.rows) flat[row.labelKey] = row
  }
  return flat
}

describe('songDetailSections', () => {
  it('shows only what the server actually answered with', () => {
    // The whole point of the sheet: a Subsonic server sends a handful of
    // these, Navidrome most of them, the Jellyfin/Plex bridges their own
    // subset. An empty row would read as "this track has no sample rate"
    // rather than "your server does not report one".
    const sections = songDetailSections({ id: 's1', title: 'Slow Return', suffix: 'flac' })

    const labels = sections.flatMap((section) => section.rows.map((row) => row.labelKey))
    expect(labels).toEqual(['songInfo.title', 'songInfo.format'])
    // The three sections with nothing in them are gone, not empty.
    expect(sections).toHaveLength(2)
  })

  it('formats the audio figures the way they are written on a sleeve', () => {
    const flat = rows({
      id: 's1',
      title: 'Slow Return',
      duration: 245,
      suffix: 'flac',
      bitRate: 921,
      samplingRate: 44100,
      bitDepth: 24,
      channelCount: 2,
      size: 27_262_976,
    })

    expect(flat['songInfo.duration']).toBe('4:05')
    expect(flat['songInfo.format']).toBe('FLAC')
    expect(flat['songInfo.bitrate']).toBe('921 kbps')
    expect(flat['songInfo.sampleRate']).toBe('44.1 kHz')
    expect(flat['songInfo.bitDepth']).toBe('24 bit')
    expect(flat['songInfo.channels']).toBe('2')
    expect(flat['songInfo.size']).toBe('26 MB')
  })

  it('drops the trailing zero from a whole-number sample rate', () => {
    expect(rows({ id: 's1', samplingRate: 48000 })['songInfo.sampleRate']).toBe('48 kHz')
  })

  it('keeps two decimals on a file small enough for them to matter', () => {
    expect(rows({ id: 's1', size: 5_452_595 })['songInfo.size']).toBe('5.20 MB')
  })

  it('signs a ReplayGain value, since the sign is the whole reading', () => {
    const flat = rows({
      id: 's1',
      replayGain: { trackGain: -7.2, albumGain: 1.5 },
    })

    expect(flat['songInfo.replayGainTrack']).toBe('-7.20 dB')
    expect(flat['songInfo.replayGainAlbum']).toBe('+1.50 dB')
  })

  it('prefers the tag as written over the split-apart artist list', () => {
    // "A feat. B" is what the file says; the list is the server's own
    // parse of it, and the parse is the lossy one.
    const flat = rows({
      id: 's1',
      artist: 'A',
      displayArtist: 'A feat. B',
      artists: [{ name: 'A' }, { name: 'B' }],
    })

    expect(flat['songInfo.artist']).toBe('A feat. B')
  })

  it('falls back through the artist list to the plain field', () => {
    expect(rows({ id: 's1', artists: [{ name: 'A' }, { name: 'B' }] })['songInfo.artist']).toBe(
      'A, B',
    )
    expect(rows({ id: 's1', artist: 'A' })['songInfo.artist']).toBe('A')
  })

  it('leaves out an album artist that just repeats the artist', () => {
    const flat = rows({ id: 's1', artist: 'A', displayAlbumArtist: 'A' })

    expect(flat['songInfo.artist']).toBe('A')
    expect(flat).not.toHaveProperty('songInfo.albumArtist')
  })

  it('leaves out a sort name that just repeats the title', () => {
    expect(rows({ id: 's1', title: 'Slow Return', sortName: 'Slow Return' })).not.toHaveProperty(
      'songInfo.sortName',
    )
    expect(rows({ id: 's1', title: 'The Return', sortName: 'Return, The' })).toHaveProperty(
      'songInfo.sortName',
      'Return, The',
    )
  })

  it('joins the genre list, and takes the plain field when there is none', () => {
    expect(rows({ id: 's1', genres: [{ name: 'Rock' }, { name: 'Pop' }] })['songInfo.genre']).toBe(
      'Rock, Pop',
    )
    expect(rows({ id: 's1', genre: 'Rock' })['songInfo.genre']).toBe('Rock')
  })

  /** The two tag fields also carry their entries separately, which is what
   * lets the dialog give each one its own chip. An identifier list (ISRC)
   * deliberately does not - it is text to copy, not tags to read. */
  it('keeps genres and moods as a list beside their joined form', () => {
    const flat = rowObjects({
      id: 's1',
      genres: [{ name: 'Rock' }, { name: 'Pop' }],
      moods: ['Melancholic', 'Warm'],
      isrc: ['DEA123456789', 'DEA987654321'],
    })

    expect(flat['songInfo.genre']!.values).toEqual(['Rock', 'Pop'])
    expect(flat['songInfo.mood']!.values).toEqual(['Melancholic', 'Warm'])
    expect(flat['songInfo.isrc']!.values).toBeUndefined()
  })

  it('drops a tag list the server left empty rather than showing a bare label', () => {
    expect(rows({ id: 's1', moods: [] })).not.toHaveProperty('songInfo.mood')
    expect(rows({ id: 's1', genres: [] })).not.toHaveProperty('songInfo.genre')
  })

  it('treats an unrated track as unrated rather than as zero stars', () => {
    expect(rows({ id: 's1', userRating: 0 })).not.toHaveProperty('songInfo.rating')
    expect(rows({ id: 's1', userRating: 4 })['songInfo.rating']).toBe('4/5')
  })

  it('shows timestamps in the reader own locale', () => {
    const german = rows({ id: 's1', created: '2026-01-02T03:04:05Z' }, 'de-DE')
    const american = rows({ id: 's1', created: '2026-01-02T03:04:05Z' }, 'en-US')

    expect(german['songInfo.added']).toContain('2.1.2026')
    expect(american['songInfo.added']).toContain('1/2/2026')
  })

  it('leaves out a timestamp it cannot read rather than printing Invalid Date', () => {
    expect(rows({ id: 's1', created: 'whenever' })).not.toHaveProperty('songInfo.added')
  })
})
