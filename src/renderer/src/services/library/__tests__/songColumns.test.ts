import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SONG_COLUMNS,
  OPTIONAL_SONG_COLUMNS,
  SONG_COLUMNS,
  resolveSongColumns,
  songColumn,
  songColumnAvailable,
  type SongColumnKey,
} from '../songColumns'
import { makeSong } from '@/stores/__tests__/fixtures'

function keys(columns: { key: SongColumnKey }[]): SongColumnKey[] {
  return columns.map((column) => column.key)
}

/** What a column actually prints for one song. */
function cell(key: SongColumnKey, song: Parameters<typeof makeSong>[1], locale = 'en'): string {
  const column = songColumn(key)
  if (!column?.text) throw new Error(`${key} is not a text column`)
  return column.text(makeSong('s1', song), locale)
}

describe('songColumns', () => {
  it('keeps the structural columns whatever the selection is', () => {
    // The four a song table is not a song table without - a table of
    // nothing but a checkbox column would be the result of an empty
    // selection if this were a plain filter.
    expect(keys(resolveSongColumns([]))).toEqual(['index', 'title', 'duration', 'actions'])
  })

  it('draws chosen columns in registry order, not in the order they were picked', () => {
    const columns = keys(resolveSongColumns(['format', 'album', 'bpm']))

    expect(columns).toEqual(['index', 'title', 'album', 'bpm', 'format', 'duration', 'actions'])
  })

  it("drops a column the page vetoed without touching the user's own selection", () => {
    const selection: SongColumnKey[] = ['cover', 'album', 'genre']

    // An album's own tracklist: every row has the same cover and the same
    // album name.
    expect(keys(resolveSongColumns(selection, ['cover', 'album']))).toEqual([
      'index',
      'title',
      'genre',
      'duration',
      'actions',
    ])
    expect(selection).toEqual(['cover', 'album', 'genre'])
  })

  it('leaves out a column the connected server cannot fill', () => {
    const selection: SongColumnKey[] = ['bpm', 'size', 'album']

    // Jellyfin's song lists carry neither (asking for the file's own
    // figures costs real time per item - see _SONG_LIST_FIELDS), Plex sends
    // the size but not the BPM, Navidrome sends both.
    expect(keys(resolveSongColumns(selection, [], 'jellyfin'))).toEqual([
      'index',
      'title',
      'album',
      'duration',
      'actions',
    ])
    expect(keys(resolveSongColumns(selection, [], 'plex'))).toContain('size')
    expect(keys(resolveSongColumns(selection, [], 'plex'))).not.toContain('bpm')
    expect(keys(resolveSongColumns(selection, [], 'subsonic'))).toContain('bpm')
    // The selection itself is untouched, so the column is back the moment
    // the account is on a server that reports it.
    expect(selection).toEqual(['bpm', 'size', 'album'])
  })

  it('answers for every column whether a given server reports it', () => {
    for (const column of SONG_COLUMNS) {
      expect(songColumnAvailable(column, 'subsonic')).toBe(true)
      // No server type given at all (a test, an export) filters nothing.
      expect(songColumnAvailable(column, null)).toBe(true)
    }
    expect(songColumnAvailable(songColumn('path')!, 'jellyfin')).toBe(false)
    expect(songColumnAvailable(songColumn('genre')!, 'jellyfin')).toBe(true)
  })

  it('gives every column a width and a floor under it', () => {
    for (const column of SONG_COLUMNS) {
      expect(column.flex, column.key).toMatch(/\d+px$/)
      expect(parseInt(column.minWidth, 10), column.key).toBeGreaterThan(0)
    }
  })

  it('offers every optional column and only those', () => {
    expect(OPTIONAL_SONG_COLUMNS.every((column) => column.optional)).toBe(true)
    expect(keys(SONG_COLUMNS.filter((column) => !column.optional))).toEqual([
      'index',
      'title',
      'duration',
      'actions',
    ])
    expect(DEFAULT_SONG_COLUMNS.every((key) => songColumn(key)?.optional)).toBe(true)
  })

  it('writes a field the server did not report as a blank, not as a zero', () => {
    expect(cell('bpm', { bpm: null })).toBe('—')
    expect(cell('size', { size: null })).toBe('—')
    expect(cell('added', { added: null })).toBe('—')
    expect(cell('genre', { genre: null })).toBe('—')
    // A play count of zero is a real answer, unlike an absent field.
    expect(cell('playCount', { playCount: 0 })).toBe('0')
  })

  it('writes the audio figures the way the info dialog does', () => {
    expect(cell('sampleRate', { sampleRate: 44100, bitDepth: 16 })).toBe('44.1 kHz · 16 bit')
    // A lossy file has a rate but no bit depth - the separator goes too.
    expect(cell('sampleRate', { sampleRate: 48000, bitDepth: null })).toBe('48 kHz')
    expect(cell('format', { format: 'flac', bitRate: 900 })).toBe('FLAC · 900 kbps')
    expect(cell('size', { size: 4 * 1024 * 1024 })).toBe('4.00 MB')
  })

  it("writes a date in the reader's own locale, and only the date", () => {
    const added = { added: '2026-04-25T18:51:26.473Z' }

    expect(cell('added', added, 'de')).toBe(new Date(added.added).toLocaleDateString('de'))
    // The info dialog shows the time of day as well; a column has no room
    // for it.
    expect(cell('added', added, 'en')).not.toContain(':')
  })

  it('sorts an unset date to the end rather than to 1970', () => {
    const column = songColumn('lastPlayed')
    const never = Number(column!.sortValue!(makeSong('a', { lastPlayed: null })))
    const played = Number(column!.sortValue!(makeSong('b', { lastPlayed: '2020-01-01T00:00:00Z' })))

    // Ascending, a track nobody has played yet would otherwise crowd out
    // the ones the sort is actually about.
    expect(never).toBeGreaterThan(played)
  })

  it('sorts the format column by bitrate, which is the ranking underneath it', () => {
    const column = songColumn('format')!

    expect(column.sortValue!(makeSong('a', { format: 'mp3', bitRate: 320 }))).toBe(320)
    expect(column.sortValue!(makeSong('b', { format: 'flac', bitRate: 900 }))).toBe(900)
  })

  it('sorts text columns case-insensitively', () => {
    const column = songColumn('album')!

    expect(column.sortValue!(makeSong('a', { album: 'Zebra' }))).toBe('zebra')
    expect(column.sortValue!(makeSong('b', { album: '' }))).toBe('')
  })

  it('gives every column a label and every sortable one something to sort by', () => {
    for (const column of SONG_COLUMNS) {
      if (column.key !== 'index') expect(column.labelKey).not.toBe('')
      // The cover is the one column with nothing orderable behind it, so
      // its heading is not a sort button.
      expect(column.sortValue === null).toBe(column.key === 'cover' || column.key === 'index')
    }
  })
})
