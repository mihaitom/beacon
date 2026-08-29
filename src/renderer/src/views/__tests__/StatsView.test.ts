import { beforeEach, describe, expect, it, vi } from 'vitest'
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
