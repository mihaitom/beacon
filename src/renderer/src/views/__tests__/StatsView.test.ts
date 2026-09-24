import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Artist, Song } from '@/types/library'
import type { RankedItem } from '@/components/library/RankedList.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import StatsView from '../StatsView.vue'

const vuetify = createVuetify({ components, directives })

/** The computed rankings and totals these tests read. Everything on this
 * view is derived from libraryStore.allSongs — there is no local state. */
interface StatsVm {
  readonly totalSongs: number
  readonly totalArtists: number
  readonly totalAlbums: number
  readonly totalGenres: number
  readonly libraryDuration: number
  readonly totalPlays: number
  readonly listeningTime: number
  readonly topSongs: RankedItem[]
  readonly topArtists: RankedItem[]
  readonly topAlbums: RankedItem[]
  readonly topGenres: RankedItem[]
  readonly formatBreakdown: RankedItem[]
  readonly decadeBreakdown: RankedItem[]
  readonly qualityBreakdown: RankedItem[]
  readonly largestArtists: RankedItem[]
  readonly storageBytes: number
  readonly playedShare: number
  readonly hasLastPlayed: boolean
  readonly recentlyPlayedCount: number
  readonly ratings: { count: number; average: number }
  formatBigDuration(totalSeconds: number): string
}

function mountStats(songs: Song[], artists: Artist[] = []): StatsVm {
  const store = useLibraryStore()
  // created() kicks all three off; the tests supply the state directly.
  store.fetchAllSongs = vi.fn()
  store.fetchStarred = vi.fn()
  store.fetchArtists = vi.fn()
  store.allSongs = songs
  store.artists = artists

  const wrapper = mount(StatsView, {
    global: { plugins: [vuetify, i18n], stubs: { RankedList: true, PageLoader: true } },
  })
  return wrapper.vm as unknown as StatsVm
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('StatsView rankings', () => {
  it('sums plays across every song of the same artist', () => {
    const vm = mountStats([
      makeSong('1', { artistId: 'a', artist: 'A', playCount: 3 }),
      makeSong('2', { artistId: 'a', artist: 'A', playCount: 4 }),
      makeSong('3', { artistId: 'b', artist: 'B', playCount: 5 }),
    ])

    // A totals 7 and must outrank B's single 5 — a ranking that compared
    // per-song counts would put B first.
    expect(vm.topArtists.map((i) => [i.label, i.value])).toEqual([
      ['A', 7],
      ['B', 5],
    ])
  })

  it('leaves out songs with no grouping key instead of making a null bucket', () => {
    const vm = mountStats([
      makeSong('1', { artistId: '', artist: '', playCount: 9 }),
      makeSong('2', { artistId: 'a', artist: 'A', playCount: 1 }),
    ])

    expect(vm.topArtists).toHaveLength(1)
    expect(vm.topArtists[0]?.label).toBe('A')
  })

  it('leaves out groups nobody ever played', () => {
    const vm = mountStats([
      makeSong('1', { artistId: 'a', artist: 'A', playCount: 0 }),
      makeSong('2', { artistId: 'b', artist: 'B', playCount: 2 }),
    ])

    // A never-played artist is not a "top" artist with value 0; the list
    // should simply be shorter.
    expect(vm.topArtists.map((i) => i.label)).toEqual(['B'])
  })

  it('shows only the top five', () => {
    const vm = mountStats(
      Array.from({ length: 9 }, (_, i) =>
        makeSong(`s${i}`, { artistId: `a${i}`, artist: `A${i}`, playCount: i + 1 }),
      ),
    )

    expect(vm.topArtists).toHaveLength(5)
    // Highest first: a8 (9 plays) down to a4 (5).
    expect(vm.topArtists[0]?.label).toBe('A8')
    expect(vm.topArtists[4]?.label).toBe('A4')
  })

  it('ranks songs by their own play count and links to the album', () => {
    const vm = mountStats([
      makeSong('quiet', { playCount: 0 }),
      makeSong('loud', { playCount: 12, albumId: 'alb-9' }),
    ])

    expect(vm.topSongs).toHaveLength(1)
    expect(vm.topSongs[0]?.id).toBe('loud')
    // There is no standalone song page in this app.
    expect(vm.topSongs[0]?.to).toBe('/albums/alb-9')
  })

  it('escapes a genre name in the link it builds', () => {
    const vm = mountStats([makeSong('1', { genre: 'Drum & Bass/Jungle', playCount: 4 })])

    // An unescaped name would produce a path segment with a stray slash,
    // routing to /genres/Drum & Bass/Jungle instead of the genre.
    expect(vm.topGenres[0]?.to).toBe('/genres/Drum%20%26%20Bass%2FJungle')
  })
})

describe('StatsView artist artwork', () => {
  const artist = (id: string, over: Partial<Artist> = {}): Artist =>
    ({ id, name: id, coverArtId: `cover-${id}`, imageUrl: null, ...over }) as Artist

  it('takes artist art from the artist, not from one of their albums', () => {
    const vm = mountStats(
      [makeSong('1', { artistId: 'a', artist: 'A', playCount: 2, coverArtId: 'album-cover' })],
      [artist('a')],
    )

    // A song's cover is its *album's* art — showing that next to an
    // artist's name would be misleading.
    expect(vm.topArtists[0]?.coverArtId).toBe('cover-a')
  })

  it('names the artist, not the full credit of a song with features', () => {
    const songs = [
      makeSong('1', { artistId: 'a', artist: 'A, B & C', playCount: 2 }),
      makeSong('2', { artistId: 'a', artist: 'A', playCount: 1 }),
    ]
    const vm = mountStats(songs, [artist('a', { name: 'A' })])

    expect(vm.topArtists[0]?.label).toBe('A')
    expect(vm.largestArtists[0]?.label).toBe('A')
  })

  it('falls back to the shortest credit while the artist list is loading', () => {
    // Credits on both sides of the plain name, so neither first- nor
    // last-seen picks it by luck.
    const vm = mountStats([
      makeSong('1', { artistId: 'a', artist: 'A, B & C' }),
      makeSong('2', { artistId: 'a', artist: 'A' }),
      makeSong('3', { artistId: 'a', artist: 'A & D' }),
    ])

    expect(vm.largestArtists[0]?.label).toBe('A')
  })

  it('uses null, not undefined, while the artist list is still loading', () => {
    const vm = mountStats([makeSong('1', { artistId: 'a', artist: 'A', playCount: 2 })], [])

    // null keeps RankedList reserving the art column; undefined would drop
    // it and make the whole row reflow once artists arrive.
    expect(vm.topArtists[0]?.coverArtId).toBeNull()
    expect(vm.topArtists[0]?.imageUrl).toBeNull()
  })

  it('carries album art on albums but not on genres', () => {
    const vm = mountStats([
      makeSong('1', {
        albumId: 'alb',
        album: 'Alb',
        genre: 'Rock',
        playCount: 3,
        coverArtId: 'c1',
      }),
    ])

    expect(vm.topAlbums[0]?.coverArtId).toBe('c1')
    // A genre has no artwork of its own to show.
    expect(vm.topGenres[0]?.coverArtId).toBeUndefined()
  })
})

describe('StatsView library composition', () => {
  it('folds formats together case-insensitively', () => {
    const vm = mountStats([
      makeSong('1', { format: 'flac' }),
      makeSong('2', { format: 'FLAC' }),
      makeSong('3', { format: 'mp3' }),
    ])

    expect(vm.formatBreakdown.map((i) => [i.label, i.value])).toEqual([
      ['FLAC', 2],
      ['MP3', 1],
    ])
  })

  it('labels an untagged format rather than dropping the song', () => {
    const vm = mountStats([makeSong('1', { format: '' })])

    expect(vm.formatBreakdown[0]?.label).toBe('—')
    expect(vm.formatBreakdown[0]?.valueLabel).toBe('100%')
  })

  it('groups years into decades', () => {
    const vm = mountStats([
      makeSong('1', { year: 1999 }),
      makeSong('2', { year: 1990 }),
      makeSong('3', { year: 2000 }),
    ])

    const byLabel = vm.decadeBreakdown.map((i) => [i.id, i.value])
    // 1999 belongs to the 1990s, 2000 starts the next one.
    expect(byLabel).toContainEqual(['1990', 2])
    expect(byLabel).toContainEqual(['2000', 1])
  })

  it('omits untagged years instead of inventing an unknown decade', () => {
    const vm = mountStats([makeSong('1', { year: 1985 }), makeSong('2', { year: 0 })])

    // A bucket sized by tagging gaps would say nothing about the music.
    expect(vm.decadeBreakdown).toHaveLength(1)
    expect(vm.decadeBreakdown[0]?.id).toBe('1980')
  })

  it('ranks artists by how many songs they have, played or not', () => {
    const vm = mountStats([
      makeSong('1', { artistId: 'a', artist: 'A', playCount: 0 }),
      makeSong('2', { artistId: 'a', artist: 'A', playCount: 0 }),
      makeSong('3', { artistId: 'b', artist: 'B', playCount: 50 }),
      makeSong('4', { artistId: '', artist: '' }),
    ])

    // Plays don't matter here - that is what the top-artists list is for.
    expect(vm.largestArtists.map((i) => [i.label, i.value])).toEqual([
      ['A', 2],
      ['B', 1],
    ])
    expect(vm.largestArtists[0]?.to).toBe('/artists/a')
  })

  it('reports percentages against the whole library, not just the ranked rows', () => {
    const vm = mountStats([
      makeSong('1', { format: 'flac' }),
      makeSong('2', { format: 'flac' }),
      makeSong('3', { format: 'mp3' }),
      makeSong('4', { format: 'aac' }),
    ])

    expect(vm.formatBreakdown[0]?.valueLabel).toBe('50%')
  })

  it('survives an empty library without dividing by zero', () => {
    const vm = mountStats([])

    expect(vm.formatBreakdown).toEqual([])
    expect(vm.decadeBreakdown).toEqual([])
    expect(vm.totalSongs).toBe(0)
    expect(vm.listeningTime).toBe(0)
  })
})

describe('StatsView totals', () => {
  it('counts distinct artists, albums and genres', () => {
    const vm = mountStats([
      makeSong('1', { artistId: 'a', albumId: 'x', genre: 'Rock' }),
      makeSong('2', { artistId: 'a', albumId: 'y', genre: 'Rock' }),
      makeSong('3', { artistId: 'b', albumId: 'y', genre: 'Jazz' }),
    ])

    expect(vm.totalArtists).toBe(2)
    expect(vm.totalAlbums).toBe(2)
    expect(vm.totalGenres).toBe(2)
  })

  it('does not count a missing id or genre as its own entry', () => {
    const vm = mountStats([
      makeSong('1', { artistId: 'a', genre: 'Rock' }),
      makeSong('2', { artistId: '', genre: null }),
    ])

    expect(vm.totalArtists).toBe(1)
    expect(vm.totalGenres).toBe(1)
  })

  it('estimates listening time as duration times plays', () => {
    const vm = mountStats([
      makeSong('1', { duration: 100, playCount: 3 }),
      makeSong('2', { duration: 50, playCount: 2 }),
    ])

    expect(vm.listeningTime).toBe(400)
    // Shelf length is the plain sum, unaffected by how often it was played.
    expect(vm.libraryDuration).toBe(150)
    expect(vm.totalPlays).toBe(5)
  })

  it('treats fields a server left out as zero rather than producing NaN', () => {
    // Not every backend fills every field; the view guards each sum with
    // `|| 0` and this is what that guard is for.
    const partial = { ...makeSong('1'), duration: undefined, playCount: undefined }
    const vm = mountStats([
      partial as unknown as Song,
      makeSong('2', { duration: 60, playCount: 1 }),
    ])

    expect(vm.libraryDuration).toBe(60)
    expect(vm.totalPlays).toBe(1)
    expect(vm.listeningTime).toBe(60)
  })
})

describe('StatsView duration wording', () => {
  it('switches unit as the total grows', () => {
    const vm = mountStats([])

    const minutes = vm.formatBigDuration(90 * 60)
    const hours = vm.formatBigDuration(5 * 3600)
    const days = vm.formatBigDuration(50 * 3600)

    // Each step has to actually change wording — an always-minutes label
    // would read "3000 minutes" for two days of music.
    expect(minutes).not.toBe(hours)
    expect(hours).not.toBe(days)
    expect(days).toContain('2')
  })

  it('switches to days at the first full day, not the second', () => {
    const vm = mountStats([])

    // Compared against the rendered message rather than a substring: an
    // off-by-one at this boundary falls through to the hours wording,
    // which for 25h reads "1h 0m" and still contains a "1".
    expect(vm.formatBigDuration(25 * 3600)).toBe(i18n.global.t('stats.days', { days: 1, hours: 1 }))
    expect(vm.formatBigDuration(23 * 3600)).toBe(
      i18n.global.t('stats.hours', { hours: 23, minutes: 0 }),
    )
  })

  it('rounds down to whole minutes rather than showing seconds', () => {
    const vm = mountStats([])

    expect(vm.formatBigDuration(59)).toContain('0')
    expect(vm.formatBigDuration(119)).toContain('1')
  })
})

describe('StatsView audio quality', () => {
  const quality = (vm: StatsVm) =>
    Object.fromEntries(vm.qualityBreakdown.map((i) => [i.id, i.value]))

  it('splits lossless into CD and Hi-Res by bit depth and sample rate', () => {
    const vm = mountStats([
      makeSong('cd', { format: 'flac', bitDepth: 16, sampleRate: 44100 }),
      makeSong('deep', { format: 'flac', bitDepth: 24, sampleRate: 44100 }),
      makeSong('fast', { format: 'flac', bitDepth: 16, sampleRate: 96000 }),
      // 48 kHz is DVD/studio standard, not Hi-Res on its own.
      makeSong('dvd', { format: 'flac', bitDepth: 16, sampleRate: 48000 }),
      makeSong('mp3', { format: 'mp3', bitRate: 320 }),
    ])

    expect(quality(vm)).toEqual({ lossless: 2, hires: 2, lossy: 1 })
  })

  it('tells ALAC from AAC inside .m4a by bitrate', () => {
    const vm = mountStats([
      makeSong('aac', { format: 'm4a', bitRate: 256 }),
      makeSong('alac', { format: 'm4a', bitRate: 900 }),
    ])

    expect(quality(vm)).toEqual({ lossy: 1, lossless: 1 })
  })

  it('counts DSD as Hi-Res and leaves out songs with no format', () => {
    const vm = mountStats([makeSong('dsd', { format: 'dsf' }), makeSong('x', { format: null })])

    expect(quality(vm)).toEqual({ hires: 1 })
  })
})

describe('StatsView listening facts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts songs last played inside the 30-day window only', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    const vm = mountStats([
      makeSong('1', { lastPlayed: '2026-09-23T10:00:00Z' }),
      makeSong('2', { lastPlayed: '2026-08-25T13:00:00Z' }),
      // One hour past the window.
      makeSong('3', { lastPlayed: '2026-08-25T11:00:00Z' }),
      makeSong('4', { lastPlayed: null }),
    ])

    expect(vm.recentlyPlayedCount).toBe(2)
    expect(vm.hasLastPlayed).toBe(true)
  })

  it('hides the recent-plays fact on a server that reports no dates', () => {
    const vm = mountStats([makeSong('1', { playCount: 3 })])

    expect(vm.hasLastPlayed).toBe(false)
  })

  it('reports how much of the library was ever played', () => {
    const vm = mountStats([
      makeSong('1', { playCount: 5 }),
      makeSong('2', { playCount: 0 }),
      makeSong('3', { playCount: 0 }),
      makeSong('4', { playCount: 1 }),
    ])

    // Songs, not plays: five plays of one song still count once.
    expect(vm.playedShare).toBe(50)
  })

  it('averages ratings over rated songs only', () => {
    const vm = mountStats([
      makeSong('1', { rating: 5 }),
      makeSong('2', { rating: 3 }),
      makeSong('3', { rating: 0 }),
    ])

    // Unrated songs are 0 in the model; counting them would drag this to 2.7.
    expect(vm.ratings).toEqual({ count: 2, average: 4 })
  })

  it('sums file sizes and ignores songs without one', () => {
    const vm = mountStats([makeSong('1', { size: 1000 }), makeSong('2', { size: null })])

    expect(vm.storageBytes).toBe(1000)
  })

  it('survives an empty library', () => {
    const vm = mountStats([])

    expect(vm.playedShare).toBe(0)
    expect(vm.ratings.count).toBe(0)
    expect(vm.qualityBreakdown).toEqual([])
  })
})
