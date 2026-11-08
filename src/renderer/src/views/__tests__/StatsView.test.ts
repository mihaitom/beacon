import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import type { Artist, Song } from '@/types/library'
import type { ChartItem, ChartKind } from '@/components/stats/StatsCharts.vue'
import * as playHistory from '@/services/connect/playHistory'
import { useAuthStore } from '@/stores/auth'
import { useLastfmStore } from '@/stores/lastfm'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import { usePlaybackStore } from '@/stores/playback'
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
  readonly topSongs: ChartItem[]
  readonly topArtists: ChartItem[]
  readonly topAlbums: ChartItem[]
  readonly topGenres: ChartItem[]
  readonly formatBreakdown: ChartItem[]
  readonly decadeBreakdown: ChartItem[]
  readonly qualityBreakdown: ChartItem[]
  readonly storageBytes: number
  readonly playedCount: number
  readonly ratings: { count: number; average: number }
  formatBigDuration(totalSeconds: number): string
  formatShare(part: number, whole: number): string
}

vi.mock('@/services/connect/playHistory', () => ({
  recordListen: vi.fn(),
  getPlayHistorySummary: vi.fn(),
  getPlayHistoryAccounts: vi.fn(),
  saveMilestones: vi.fn(),
  getImportStatus: vi.fn(),
  startImport: vi.fn(),
}))

function summary(
  over: Partial<playHistory.PlayHistorySummary> = {},
): playHistory.PlayHistorySummary {
  return {
    available: true,
    total: 0,
    timestamps: [],
    live_since: null,
    recent_plays: {},
    top: { songs: [], artists: [], albums: [], genres: [] },
    milestones: { plays: 0, hours: 0, streak: 0 },
    ...over,
  }
}

const STUBS = {
  StatsHero: true,
  StatsCharts: true,
  StatsYear: true,
  StatsCollection: true,
  StatsMoment: true,
  PageLoader: true,
}

function mountView(songs: Song[], artists: Artist[] = []): VueWrapper {
  const store = useLibraryStore()
  // created() kicks all three off; the tests supply the state directly.
  store.fetchAllSongs = vi.fn()
  store.allSongsLoaded = true
  store.fetchStarred = vi.fn()
  store.fetchArtists = vi.fn()
  store.allSongs = songs
  store.artists = artists
  return mount(StatsView, { global: { plugins: [vuetify, i18n], stubs: STUBS } })
}

function mountStats(songs: Song[], artists: Artist[] = []): StatsVm {
  return mountView(songs, artists).vm as unknown as StatsVm
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(summary())
  vi.mocked(playHistory.getPlayHistoryAccounts).mockResolvedValue([])
  vi.mocked(playHistory.getImportStatus).mockResolvedValue({ status: 'done' })
  vi.mocked(playHistory.saveMilestones).mockResolvedValue({})
  useLastfmStore().configured = true
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
  })

  it('uses null, not undefined, while the artist list is still loading', () => {
    const vm = mountStats([makeSong('1', { artistId: 'a', artist: 'A', playCount: 2 })], [])

    // null keeps the chart's art column reserved; undefined would drop
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

describe('StatsView record label', () => {
  type LabelVm = { recordLabel: string | null }

  it('plays the song that is on', async () => {
    const wrapper = mountView([])
    usePlaybackStore().setQueue([makeSong('1', { coverArtId: 'on-now' })], 0)
    await flushPromises()

    expect((wrapper.vm as unknown as LabelVm).recordLabel).toContain('on-now')
  })

  it('has nothing of its own with nothing on', () => {
    expect((mountStats([]) as unknown as LabelVm).recordLabel).toBeNull()
  })

  it("keeps away from another account's page", async () => {
    const wrapper = mountView([])
    usePlaybackStore().setQueue([makeSong('1', { coverArtId: 'on-now' })], 0)
    await wrapper.setData({ viewedAccount: 'bob' })

    expect((wrapper.vm as unknown as LabelVm).recordLabel).toBeNull()
  })
})

describe('StatsView genre crate', () => {
  it('stands the number one genre on its records, the most played in front', () => {
    const vm = mountStats([
      makeSong('1', { genre: 'Rock', coverArtId: 'quiet', playCount: 1 }),
      makeSong('2', { genre: 'Rock', coverArtId: 'loud', playCount: 9 }),
      makeSong('3', { genre: 'Rock', coverArtId: 'quiet', playCount: 1 }),
      makeSong('4', { genre: 'Jazz', coverArtId: 'other', playCount: 2 }),
    ]) as StatsVm & { charts: Record<ChartKind, ChartItem[]> }

    expect(vm.charts.genres[0]?.covers).toEqual(['loud', 'quiet'])
    expect(vm.charts.genres[1]?.covers).toBeUndefined()
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
    expect(byLabel).toEqual([
      ['1990', 2],
      ['2000', 1],
    ])
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
  it('reports how much of the library was ever played', () => {
    const vm = mountStats([
      makeSong('1', { playCount: 5 }),
      makeSong('2', { playCount: 0 }),
      makeSong('3', { playCount: 0 }),
      makeSong('4', { playCount: 1 }),
    ])

    // Songs, not plays: five plays of one song still count once.
    expect(vm.playedCount).toBe(2)
    expect(vm.formatShare(vm.playedCount, 4)).toBe('50%')
  })

  it('never rounds a share to a figure that says something else', () => {
    const vm = mountStats([])

    // 50 of 19,529 heard is not "0%" - that reads as nothing at all.
    expect(vm.formatShare(50, 19529)).toBe('< 1%')
    expect(vm.formatShare(19500, 19529)).toBe('> 99%')
    expect(vm.formatShare(0, 19529)).toBe('0%')
    expect(vm.formatShare(19529, 19529)).toBe('100%')
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

    expect(vm.playedCount).toBe(0)
    expect(vm.ratings.count).toBe(0)
    expect(vm.qualityBreakdown).toEqual([])
  })
})

describe('StatsView milestones', () => {
  const thousandPlays = [makeSong('1', { playCount: 1000, duration: 60 })]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function moment(wrapper: VueWrapper): unknown {
    return (wrapper.vm as unknown as { moment: unknown }).moment
  }

  async function settle(): Promise<void> {
    await flushPromises()
    vi.advanceTimersByTime(2100)
    await flushPromises()
  }

  it('celebrates a milestone passed since the last visit', async () => {
    const wrapper = mountView(thousandPlays)
    await settle()

    expect(moment(wrapper)).toMatchObject({ kind: 'plays', value: 1000 })
    expect(playHistory.saveMilestones).toHaveBeenCalledWith({
      plays: 1000,
      hours: 0,
      streak: 0,
      records: 0,
    })
  })

  it('stays silent the first time and only sets the baseline', async () => {
    vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(summary({ milestones: null }))
    const wrapper = mountView(thousandPlays)
    await settle()

    expect(moment(wrapper)).toBeNull()
    expect(playHistory.saveMilestones).toHaveBeenCalledWith({
      plays: 1000,
      hours: 0,
      streak: 0,
      records: 0,
    })
  })

  it('waits for the whole library before comparing', async () => {
    vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(
      summary({ milestones: { plays: 1000, hours: 0, streak: 0, records: 0 } }),
    )
    const wrapper = mountView([makeSong('1', { playCount: 1800, duration: 60 })])
    useLibraryStore().allSongsLoaded = false
    await settle()

    expect(moment(wrapper)).toBeNull()
    expect(playHistory.saveMilestones).not.toHaveBeenCalled()
  })

  it('announces a new pressing when another record is full', async () => {
    vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(
      summary({ milestones: { plays: 1000, hours: 0, streak: 0, records: 0 } }),
    )
    const wrapper = mountView([makeSong('1', { playCount: 2500, duration: 60 })])
    await settle()

    expect(moment(wrapper)).toMatchObject({ kind: 'pressing', value: 1 })
  })

  it('takes on the count silently when what was saved has none', async () => {
    vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(
      summary({ milestones: { plays: 2000, hours: 0, streak: 0 } }),
    )
    const wrapper = mountView([makeSong('1', { playCount: 2500, duration: 60 })])
    await settle()

    expect(moment(wrapper)).toBeNull()
    expect(playHistory.saveMilestones).toHaveBeenCalledWith(expect.objectContaining({ records: 1 }))
  })

  it('does not show it while looking at another account', async () => {
    const wrapper = mountView(thousandPlays)
    await flushPromises()
    await wrapper.setData({ viewedAccount: 'bob' })
    await settle()

    expect(moment(wrapper)).toBeNull()
  })
})

describe('StatsView other accounts', () => {
  function admin(accounts: string[]): void {
    const auth = useAuthStore()
    auth.username = 'me'
    auth.isAdmin = true
    vi.mocked(playHistory.getPlayHistoryAccounts).mockResolvedValue(accounts)
  }

  it('offers the picker to an administrator, without listing them twice', async () => {
    admin(['bob', 'me'])
    const wrapper = mountView([])
    await flushPromises()

    const items = (wrapper.vm as unknown as { accountItems: { value: string | null }[] })
      .accountItems
    expect(items.map((item) => item.value)).toEqual([null, 'bob'])
  })

  it('does not ask for accounts as a regular user', async () => {
    useAuthStore().isAdmin = false
    mountView([])
    await flushPromises()

    expect(playHistory.getPlayHistoryAccounts).not.toHaveBeenCalled()
  })

  it("shows the other account's log, and the own library's plays no longer", async () => {
    admin(['bob'])
    const line = { id: 'x', value: 4, label: 'Song', album_id: 'alb', cover_art_id: 'c' }
    vi.mocked(playHistory.getPlayHistorySummary).mockImplementation(async (name) =>
      name === 'bob'
        ? summary({ total: 4, timestamps: [1000], top: { ...summary().top, songs: [line] } })
        : summary(),
    )
    const wrapper = mountView([makeSong('1', { playCount: 99 })])
    await flushPromises()
    await wrapper.setData({ viewedAccount: 'bob' })
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      heroPlays: number
      charts: Record<ChartKind, ChartItem[]>
    }
    expect(vm.heroPlays).toBe(4)
    expect(vm.charts.songs[0]).toMatchObject({ label: 'Song', to: '/albums/alb', coverArtId: 'c' })
  })

  it('does not link a line that came from an import', async () => {
    admin(['bob'])
    const line = { id: 'x', value: 4, label: 'Song', album_id: '', cover_art_id: '' }
    vi.mocked(playHistory.getPlayHistorySummary).mockResolvedValue(
      summary({ top: { ...summary().top, songs: [line] } }),
    )
    const wrapper = mountView([])
    await wrapper.setData({ viewedAccount: 'bob' })
    await flushPromises()

    const { charts } = wrapper.vm as unknown as { charts: Record<ChartKind, ChartItem[]> }
    expect(charts.songs[0]?.to).toBeUndefined()
  })

  it('keeps a late answer for one account off the page of another', async () => {
    admin(['bob', 'eve'])
    let answerBob: (value: playHistory.PlayHistorySummary) => void = () => {}
    vi.mocked(playHistory.getPlayHistorySummary).mockImplementation((name) => {
      if (name === 'bob') return new Promise((resolve) => (answerBob = resolve))
      return Promise.resolve(summary({ total: name === 'eve' ? 7 : 0 }))
    })
    const wrapper = mountView([])
    await wrapper.setData({ viewedAccount: 'bob' })
    await wrapper.setData({ viewedAccount: 'eve' })
    await flushPromises()
    answerBob(summary({ total: 1 }))
    await flushPromises()

    expect((wrapper.vm as unknown as { heroPlays: number }).heroPlays).toBe(7)
  })
})

describe('StatsView import', () => {
  function offered(wrapper: VueWrapper): unknown[] {
    return (wrapper.vm as unknown as { offeredImports: unknown[] }).offeredImports
  }

  beforeEach(() => {
    vi.mocked(playHistory.startImport).mockResolvedValue({ status: 'done' })
  })

  it('starts by itself with a single profile', async () => {
    useListenbrainzStore().username = 'me-lb'
    useLastfmStore().username = ''
    vi.mocked(playHistory.getImportStatus).mockResolvedValue({ status: 'none' })
    mountView([])
    await flushPromises()

    expect(playHistory.startImport).toHaveBeenCalledWith('listenbrainz', 'me-lb')
  })

  it('waits for a choice with two profiles', async () => {
    useListenbrainzStore().username = 'me-lb'
    useLastfmStore().username = 'me-fm'
    vi.mocked(playHistory.getImportStatus).mockResolvedValue({ status: 'none' })
    const wrapper = mountView([])
    await flushPromises()

    expect(playHistory.startImport).not.toHaveBeenCalled()
    expect(offered(wrapper)).toHaveLength(2)
  })

  it('does nothing without a profile', async () => {
    useListenbrainzStore().username = ''
    useLastfmStore().username = ''
    vi.mocked(playHistory.getImportStatus).mockResolvedValue({ status: 'none' })
    const wrapper = mountView([])
    await flushPromises()

    expect(playHistory.startImport).not.toHaveBeenCalled()
    expect(offered(wrapper)).toEqual([])
  })

  it('does not ask a failed profile again on its own', async () => {
    useListenbrainzStore().username = 'me-lb'
    useLastfmStore().username = ''
    vi.mocked(playHistory.getImportStatus).mockResolvedValue({
      status: 'failed',
      source: 'listenbrainz',
      error: 'not_found',
    })
    const wrapper = mountView([])
    await flushPromises()

    expect(playHistory.startImport).not.toHaveBeenCalled()
    expect(offered(wrapper)).toHaveLength(1)
  })
})

describe('StatsView when connect cannot answer', () => {
  it('still shows what the media server knows', async () => {
    vi.mocked(playHistory.getPlayHistorySummary).mockRejectedValue(new Error('down'))
    const vm = mountStats([makeSong('1', { playCount: 3 })])
    await flushPromises()

    expect(vm.totalPlays).toBe(3)
  })
})
