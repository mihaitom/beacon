import { describe, expect, it } from 'vitest'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Song } from '@/types/library'
import { previewRules, type PreviewContext } from '../preview'
import { parseRules } from '../smartRules'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const context: PreviewContext = { now: NOW }

function ids(json: unknown, catalogue: Song[], extra: Partial<PreviewContext> = {}): string[] {
  return previewRules(parseRules(json), catalogue, { ...context, ...extra }).songs.map(
    (song) => song.id,
  )
}

const kindOfBlue = makeSong('kob', {
  title: 'So What',
  artist: 'Miles Davis',
  album: 'Kind of Blue',
  genre: 'Jazz',
  year: 1959,
  starred: true,
  rating: 5,
  playCount: 40,
  bpm: 136,
  format: 'flac',
  added: '2020-03-01T10:00:00Z',
  lastPlayed: '2026-10-01T20:00:00Z',
})
const duet = makeSong('duet', {
  title: 'Under Pressure',
  artist: 'Queen & David Bowie',
  album: 'Hot Space',
  genre: 'Rock',
  year: 1982,
  playCount: 3,
  format: 'mp3',
  added: '2026-10-05T10:00:00Z',
  lastPlayed: '2025-01-01T10:00:00Z',
})
const neverPlayed = makeSong('new', {
  title: 'Untitled',
  artist: 'Nobody',
  album: '',
  genre: null,
  year: null,
  added: '2026-10-10T10:00:00Z',
  lastPlayed: null,
})
const catalogue = [kindOfBlue, duet, neverPlayed]

describe('text rules', () => {
  it.each([
    [{ contains: { genre: 'JAZ' } }, ['kob']],
    [{ notContains: { genre: 'jazz' } }, ['duet', 'new']],
    [{ is: { album: 'kind of blue' } }, ['kob']],
    [{ isNot: { album: 'Kind of Blue' } }, ['duet', 'new']],
    [{ startsWith: { title: 'under' } }, ['duet']],
    [{ endsWith: { title: 'what' } }, ['kob']],
    [{ is: { filetype: 'MP3' } }, ['duet']],
  ])('%j picks %j', (rule, expected) => {
    expect(ids({ all: [rule] }, catalogue)).toEqual(expected)
  })

  it('finds each performer of a shared credit, as Navidrome does', () => {
    expect(ids({ all: [{ is: { artist: 'David Bowie' } }] }, catalogue)).toEqual(['duet'])
  })
})

describe('number rules', () => {
  it.each([
    [{ gt: { rating: 3 } }, ['kob']],
    [{ lt: { playcount: 5 } }, ['duet', 'new']],
    [{ is: { year: 1982 } }, ['duet']],
    [{ inTheRange: { year: [1950, 1960] } }, ['kob']],
    [{ inTheRange: { year: [1959, 1959] } }, ['kob']],
  ])('%j picks %j', (rule, expected) => {
    expect(ids({ all: [rule] }, catalogue)).toEqual(expected)
  })

  it('never matches a comparison with a song that has no value, like SQL', () => {
    const preview = previewRules(
      parseRules({ all: [{ isNot: { year: 1959 } }] }),
      catalogue,
      context,
    )

    expect(preview.songs.map((song) => song.id)).toEqual(['duet'])
    // A definite no, not a song left in doubt.
    expect(preview.uncertain).toBe(0)
  })
})

describe('date rules', () => {
  it('counts whole days back for "in the last"', () => {
    expect(ids({ all: [{ inTheLast: { dateadded: 7 } }] }, catalogue)).toEqual(['duet', 'new'])
  })

  it('includes what never happened in "not in the last", as Navidrome does', () => {
    expect(ids({ all: [{ notInTheLast: { lastplayed: 30 } }] }, catalogue)).toEqual(['duet', 'new'])
  })

  it('compares before and after by day', () => {
    expect(ids({ all: [{ before: { dateadded: '2021-01-01' } }] }, catalogue)).toEqual(['kob'])
    expect(ids({ all: [{ after: { lastplayed: '2026-01-01' } }] }, catalogue)).toEqual(['kob'])
  })
})

describe('other rules', () => {
  it('reads loved from the favourite flag', () => {
    expect(ids({ all: [{ is: { loved: true } }] }, catalogue)).toEqual(['kob'])
    expect(ids({ all: [{ is: { loved: false } }] }, catalogue)).toEqual(['duet', 'new'])
  })

  it.each([
    [{ isMissing: { genre: true } }, ['new']],
    [{ isPresent: { genre: true } }, ['duet', 'kob']],
    [{ isMissing: { album: true } }, ['new']],
    [{ isMissing: { bpm: true } }, ['new', 'duet']],
  ])('%j picks %j', (rule, expected) => {
    expect(ids({ all: [rule] }, catalogue).sort()).toEqual([...expected].sort())
  })

  it('reads a playlist rule from the songs it was given', () => {
    const playlistSongs = new Map([['pl-1', new Set(['duet'])]])

    expect(ids({ all: [{ inPlaylist: { id: 'pl-1' } }] }, catalogue, { playlistSongs })).toEqual([
      'duet',
    ])
    expect(
      ids({ all: [{ notInPlaylist: { id: 'pl-1' } }] }, catalogue, { playlistSongs }).sort(),
    ).toEqual(['kob', 'new'])
  })
})

describe('what the preview cannot tell', () => {
  it.each([
    ['the album artist', { contains: { albumartist: 'Miles' } }],
    ['the compilation flag', { is: { compilation: true } }],
    ['a rule it does not know', { contains: { mood: 'calm' } }],
    ['a playlist whose songs it was not given', { inPlaylist: { id: 'unknown' } }],
  ])('counts songs apart for %s instead of guessing', (_label, rule) => {
    const preview = previewRules(parseRules({ all: [rule] }), catalogue, context)

    expect(preview.matched).toBe(0)
    expect(preview.uncertain).toBe(3)
  })

  it('lets a definite "no" settle an all-rule despite an unknown part', () => {
    const rules = parseRules({ all: [{ is: { loved: true } }, { is: { compilation: true } }] })

    const preview = previewRules(rules, catalogue, context)

    // Only the loved song is left in doubt; the other two are definitely out.
    expect(preview).toMatchObject({ matched: 0, uncertain: 1 })
  })

  it('lets a definite "yes" settle an any-rule despite an unknown part', () => {
    const rules = parseRules({ any: [{ is: { loved: true } }, { is: { compilation: true } }] })

    expect(previewRules(rules, catalogue, context)).toMatchObject({ matched: 1, uncertain: 2 })
  })
})

describe('groups', () => {
  it('combines a group under the top-level rule', () => {
    const json = {
      all: [
        { gt: { year: 1950 } },
        { any: [{ contains: { genre: 'jazz' } }, { lt: { playcount: 5 } }] },
      ],
    }

    expect(ids(json, catalogue)).toEqual(['kob', 'duet'])
  })
})

describe('order and size', () => {
  it('sorts by title when the rules name no order, as Navidrome does', () => {
    expect(ids({ all: [] }, catalogue)).toEqual(['kob', 'duet', 'new'])
  })

  it('sorts by the field asked for, in either direction, empty values last', () => {
    // The song without a year first in, so it has to be moved.
    const shuffled = [neverPlayed, kindOfBlue, duet]

    expect(ids({ all: [], sort: 'year' }, shuffled)).toEqual(['kob', 'duet', 'new'])
    expect(ids({ all: [], sort: '-year' }, shuffled)).toEqual(['duet', 'kob', 'new'])
  })

  it('keeps a random order stable while the rules are being edited', () => {
    const first = ids({ all: [], sort: 'random' }, catalogue)

    expect(ids({ all: [], sort: 'random' }, [...catalogue].reverse())).toEqual(first)
  })

  it('cuts to the limit after sorting but counts every match', () => {
    const preview = previewRules(
      parseRules({ all: [], sort: '-playcount', limit: 1 }),
      catalogue,
      context,
    )

    expect(preview.songs.map((song) => song.id)).toEqual(['kob'])
    expect(preview.matched).toBe(3)
  })
})

describe('an empty result', () => {
  it('names the rule that emptied it', () => {
    const rules = parseRules({ all: [{ is: { loved: true } }, { contains: { genre: 'polka' } }] })

    expect(previewRules(rules, catalogue, context).emptiedBy).toBe(rules.children[1]!.key)
  })

  it('names none while songs still match', () => {
    const rules = parseRules({ all: [{ is: { loved: true } }] })

    expect(previewRules(rules, catalogue, context).emptiedBy).toBeNull()
  })

  it('names none when the rules only clash in combination', () => {
    const rules = parseRules({ all: [{ is: { loved: true } }, { is: { year: 1982 } }] })

    const preview = previewRules(rules, catalogue, context)

    expect(preview.songs).toEqual([])
    expect(preview.emptiedBy).toBeNull()
  })
})
