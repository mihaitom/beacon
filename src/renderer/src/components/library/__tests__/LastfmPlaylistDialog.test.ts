// The Last.fm playlist builder's wiring: which query it sends for the
// chosen source, that the result step reports what the library does and
// doesn't have, and that creating the playlist sends the matched ids. The
// matching itself has its own test next to it
// (services/library/lastfmMatcher.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { SubsonicClient } from '@/services/subsonic/client'
import LastfmPlaylistDialog from '../LastfmPlaylistDialog.vue'
import * as lastfmApi from '@/services/connect/lastfm'
import * as listenbrainzApi from '@/services/connect/listenbrainz'
import { listRadioBrowserCountries } from '@/services/connect/radioBrowser'

vi.mock('@/services/connect/radioBrowser', () => ({
  listRadioBrowserCountries: vi.fn(async () => [
    { name: 'Germany', code: 'DE' },
    { name: 'Spain', code: 'ES' },
  ]),
}))

const vuetify = createVuetify({ components, directives })

const globalOptions = { plugins: [vuetify, i18n], stubs: { CoverArt: true } }

function dialogText(): string {
  return document.body.textContent ?? ''
}

// v-dialog teleports its card out of the component's own tree, so the
// rendered rows are read off the document rather than the wrapper.
function rowTexts(selector: string): string[] {
  return [...document.querySelectorAll(selector)].map((n) => n.textContent?.trim() ?? '')
}

/** Opens the dialog and returns the wrapper plus its component instance,
 * typed loosely enough to drive the form fields directly — the point of
 * each test is what leaves the dialog, not how a v-select is clicked. */
async function openDialog() {
  const wrapper = mount(LastfmPlaylistDialog, { global: globalOptions })
  const vm = wrapper.vm as unknown as Record<string, unknown> & { open: () => void }
  vm.open()
  await flushPromises()
  return { wrapper, vm }
}

function stubSearch(songs: ReturnType<typeof makeSong>[]) {
  const search3 = vi.fn().mockResolvedValue({ songs, albums: [], artists: [] })
  const createPlaylist = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    search3,
    createPlaylist,
  } as unknown as SubsonicClient)
  return { search3, createPlaylist }
}

describe('LastfmPlaylistDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // open() loads the playlist names in the background. Stubbed for every
    // test: without it the ones that stub a client with only search3 would
    // reject on the missing getPlaylists(), and the ones that stub no
    // client at all would reach the real one and its localhost URL.
    vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue(undefined)
    // The recent-countries list lives here and would otherwise leak from
    // one test into the next.
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('asks for the global chart when the scope is worldwide', async () => {
    const getTracks = vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { vm } = await openDialog()
    // A country left in the field from before switching to worldwide is
    // what makes this worth asserting: sending it anyway would quietly
    // fetch that country's chart instead.
    vm.country = 'spain'
    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()

    expect(getTracks).toHaveBeenCalledWith(expect.objectContaining({ op: 'charts', country: '' }))
  })

  it('sends the country for a country chart', async () => {
    const getTracks = vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { vm } = await openDialog()
    vm.chartScope = 'country'
    vm.country = 'Spain'
    await (vm as unknown as { search: () => Promise<void> }).search()

    expect(getTracks).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'charts', country: 'Spain' }),
    )
  })

  it('offers the country names from the station directory', async () => {
    // geo.getTopTracks wants an ISO 3166-1 country *name*, which is
    // exactly what Radio Browser's country list hands over - so the two
    // share one list rather than this keeping a second copy of it.
    stubSearch([])
    const { wrapper } = await openDialog()

    expect(listRadioBrowserCountries).toHaveBeenCalled()
    const picker = wrapper.findComponent({ name: 'VAutocomplete' })
    expect(picker.props('items')).toEqual([
      { name: 'Germany', code: 'DE' },
      { name: 'Spain', code: 'ES' },
    ])
    // The name, not the code: Last.fm rejects "DE".
    expect(picker.props('itemValue')).toBe('name')
  })

  it('pins countries picked before above the rest', async () => {
    // The same list the radio station directory keeps, so a country
    // picked there is one glance away here too.
    localStorage.setItem('beacon.radioDiscoverRecentCountries', JSON.stringify(['ES']))
    stubSearch([])
    const { wrapper } = await openDialog()

    const items = wrapper.findComponent({ name: 'VAutocomplete' }).props('items') as {
      name?: string
      type?: string
    }[]
    expect(items[0]?.name).toBe('Spain')
    expect(items[1]?.type).toBe('divider')
    expect(items[2]?.name).toBe('Germany')
  })

  it('remembers the country it actually searched with', async () => {
    stubSearch([])
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    const { vm } = await openDialog()

    vm.chartScope = 'country'
    vm.country = 'Germany'
    await (vm as unknown as { search: () => Promise<void> }).search()

    // Stored as the ISO code, which is what the radio dialog's list holds.
    expect(JSON.parse(localStorage.getItem('beacon.radioDiscoverRecentCountries') ?? '[]')).toEqual(
      ['DE'],
    )
  })

  it('does not remember a country for a worldwide chart', async () => {
    // The field can still hold a name from before the scope was switched.
    stubSearch([])
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    const { vm } = await openDialog()

    vm.country = 'Germany'
    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()

    expect(localStorage.getItem('beacon.radioDiscoverRecentCountries')).toBeNull()
  })

  it('survives the country field being cleared', async () => {
    stubSearch([])
    const { vm } = await openDialog()
    vm.countryValue = 'Germany'
    vm.countryValue = null

    expect(vm.country).toBe('')
    expect(vm.canSearch).toBe(false)
  })

  it('still works when the country list cannot be loaded', async () => {
    // The worldwide chart and every other source are unaffected; only the
    // picker stays empty.
    vi.mocked(listRadioBrowserCountries).mockRejectedValue(new Error('offline'))
    const getTracks = vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { vm } = await openDialog()
    // The failure is swallowed rather than left as an unhandled rejection
    // (open() calls this with `void`), and the picker simply stays empty.
    await expect(
      (vm as unknown as { loadCountries: () => Promise<void> }).loadCountries(),
    ).resolves.toBeUndefined()
    expect(vm.countryOptions).toEqual([])
    expect(vm.countriesLoading).toBe(false)

    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()
    expect(getTracks).toHaveBeenCalled()
  })

  it('reports how much of the list the library has', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
      { title: 'Nothing Here', artist: 'Nobody', mbid: '' },
    ])
    // Only the first has a match in the library.
    const search3 = vi.fn(async (query: string) =>
      query.startsWith('Cher')
        ? { songs: [makeSong('s1', { title: 'Believe', artist: 'Cher' })] }
        : { songs: [] },
    )
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)

    const { vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(vm.foundCount).toBe(1)
    expect(dialogText()).toContain('not in library')
  })

  it('numbers every entry by chart position, gaps included', async () => {
    // Renumbering around the misses would claim a ranking Last.fm never
    // gave: the third chart entry stays 3 even if the library lacks 1.
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Missing One', artist: 'Nobody', mbid: '' },
      { title: 'Missing Two', artist: 'Nobody', mbid: '' },
      { title: 'Believe', artist: 'Cher', mbid: '' },
    ])
    const search3 = vi.fn(async (query: string) =>
      query.startsWith('Cher')
        ? { songs: [makeSong('s1', { title: 'Believe', artist: 'Cher' })] }
        : { songs: [] },
    )
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)

    const { vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(rowTexts('.track__rank')).toEqual(['1', '2', '3'])
  })

  it('puts the library song next to the Last.fm one, with its album', async () => {
    // The whole point of the comparison: a close match is either
    // recognised as the right song here, or spotted as the wrong one.
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
    ])
    const search3 = vi.fn(async () => ({
      songs: [
        makeSong('s1', {
          title: 'Believe - Radio Edit',
          artist: 'Cher',
          album: 'The Greatest Hits',
          coverArtId: 'cover-1',
        }),
      ],
    }))
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)

    const { wrapper, vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    const found = rowTexts('.track__side--found').join(' ')
    expect(found).toContain('Believe - Radio Edit')
    // A distinct album name, so this cannot pass on the title alone.
    expect(found).toContain('The Greatest Hits')
    // The artwork is what makes a wrong match obvious at a glance. Read
    // off the component tree, which the teleport leaves intact.
    expect(wrapper.findComponent({ name: 'CoverArt' }).props('coverArtId')).toBe('cover-1')
  })

  it('shows the Last.fm side even for a track the library does not have', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Obscurity', artist: 'Nobody', mbid: '' },
    ])
    stubSearch([])

    const { vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(dialogText()).toContain('Obscurity')
    expect(rowTexts('.track__side--missing')).toHaveLength(1)
    expect(rowTexts('.track__side--found')).toHaveLength(0)
  })

  it('labels the two columns, so which side is which is not a guess', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
    ])
    stubSearch([makeSong('s1', { title: 'Believe', artist: 'Cher' })])

    const { wrapper, vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    const head = document.querySelector('.tracks-head')?.textContent ?? ''
    expect(head).toContain(wrapper.vm.$t('lastfm.columnLastfm'))
    expect(head).toContain(wrapper.vm.$t('lastfm.columnLibrary'))
  })

  it('creates the playlist with the matched song ids only', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
      { title: 'Nothing Here', artist: 'Nobody', mbid: '' },
    ])
    const search3 = vi.fn(async (query: string) =>
      query.startsWith('Cher')
        ? { songs: [makeSong('s1', { title: 'Believe', artist: 'Cher' })] }
        : { songs: [] },
    )
    const createPlaylist = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
      createPlaylist,
    } as unknown as SubsonicClient)

    const { vm } = await openDialog()
    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()
    await (vm as unknown as { create: () => Promise<void> }).create()

    expect(createPlaylist).toHaveBeenCalledWith(expect.any(String), ['s1'])
  })

  it('offers genre suggestions but takes a tag that is not among them', async () => {
    const getTracks = vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { wrapper, vm } = await openDialog()
    vm.op = 'genre'
    await wrapper.vm.$nextTick()

    const combobox = wrapper.findComponent({ name: 'VCombobox' })
    expect(combobox.props('items')).toContain('Trance')
    // Last.fm has a tag for nearly anything, so the list must not be the
    // only thing that can be searched for.
    vm.genreTag = 'vaporwave'
    await (vm as unknown as { search: () => Promise<void> }).search()

    expect(getTracks).toHaveBeenCalledWith(expect.objectContaining({ tag: 'vaporwave' }))
  })

  it('survives the genre field being cleared', async () => {
    // v-combobox emits null when its field is cleared, and every trim()
    // downstream would throw on it.
    const { vm } = await openDialog()
    vm.op = 'genre'
    vm.genreTag = 'Trance'
    vm.genreTag = null

    expect(vm.tag).toBe('')
    expect(vm.canSearch).toBe(false)
  })

  describe('an existing playlist of the same name', () => {
    /** Runs a search that finds two songs, with `playlists` already in the
     * store, and returns the dialog ready at the result step. */
    async function searchWithPlaylists(playlists: { id: string; name: string }[]) {
      vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
        { title: 'Believe', artist: 'Cher', mbid: '' },
        { title: 'Roads', artist: 'Portishead', mbid: '' },
      ])
      const search3 = vi.fn(async (query: string) =>
        query.startsWith('Cher')
          ? { songs: [makeSong('s1', { title: 'Believe', artist: 'Cher' })] }
          : { songs: [makeSong('s2', { title: 'Roads', artist: 'Portishead' })] },
      )
      const store = useLibraryStore()
      vi.spyOn(store, 'client').mockReturnValue({ search3 } as unknown as SubsonicClient)
      store.playlists = playlists as never

      const { wrapper, vm } = await openDialog()
      await (vm as unknown as { search: () => Promise<void> }).search()
      await flushPromises()
      return { wrapper, vm, store }
    }

    it('creates a new playlist when the name is not taken', async () => {
      const { vm, store } = await searchWithPlaylists([])
      const createPlaylist = vi.spyOn(store, 'createPlaylist').mockResolvedValue(undefined)

      vm.playlistName = 'Something New'
      await (vm as unknown as { create: () => Promise<void> }).create()

      expect(createPlaylist).toHaveBeenCalledWith('Something New', ['s1', 's2'])
    })

    it('offers the choice only once the name really is an existing one', async () => {
      const { vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])

      vm.playlistName = 'Something New'
      expect(vm.existingPlaylist).toBeNull()

      vm.playlistName = 'Weekly Charts'
      expect((vm.existingPlaylist as { id: string }).id).toBe('p1')
    })

    it('matches the name regardless of case and padding', async () => {
      // Creating a second playlist differing only in case is never what
      // was meant, and reads as a duplicate in the list.
      const { vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])

      vm.playlistName = '  weekly CHARTS '
      expect((vm.existingPlaylist as { id: string }).id).toBe('p1')
    })

    it('replaces the contents when asked to', async () => {
      const { vm, store } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      const restore = vi.spyOn(store, 'restorePlaylistSongs').mockResolvedValue(undefined)

      vm.playlistName = 'Weekly Charts'
      vm.updateMode = 'replace'
      await (vm as unknown as { create: () => Promise<void> }).create()

      expect(restore).toHaveBeenCalledWith('p1', ['s1', 's2'])
    })

    it('adds only the songs the playlist does not already hold', async () => {
      // A chart overlaps heavily with the one imported last week; adding
      // it wholesale would duplicate every song already in there.
      const { vm, store } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      vi.spyOn(store, 'fetchPlaylist').mockResolvedValue({
        id: 'p1',
        name: 'Weekly Charts',
        songs: [makeSong('s1')],
      } as never)
      const addTo = vi.spyOn(store, 'addToPlaylist').mockResolvedValue(undefined)

      vm.playlistName = 'Weekly Charts'
      vm.updateMode = 'append'
      await (vm as unknown as { create: () => Promise<void> }).create()

      expect(addTo).toHaveBeenCalledWith('p1', ['s2'])
    })

    it('writes nothing when the playlist already holds everything', async () => {
      const { vm, store } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      vi.spyOn(store, 'fetchPlaylist').mockResolvedValue({
        id: 'p1',
        name: 'Weekly Charts',
        songs: [makeSong('s1'), makeSong('s2')],
      } as never)
      const addTo = vi.spyOn(store, 'addToPlaylist').mockResolvedValue(undefined)

      vm.playlistName = 'Weekly Charts'
      await (vm as unknown as { create: () => Promise<void> }).create()

      expect(addTo).not.toHaveBeenCalled()
    })

    it('defaults to adding rather than replacing', async () => {
      // The destructive one is never the default.
      const { vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      expect(vm.updateMode).toBe('append')
    })

    it('says on the button what it is about to do', async () => {
      const { wrapper, vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])

      vm.playlistName = 'Something New'
      expect(vm.createLabel).toBe(wrapper.vm.$t('common.create'))

      vm.playlistName = 'Weekly Charts'
      expect(vm.createLabel).toBe(wrapper.vm.$t('lastfm.appendAction'))

      vm.updateMode = 'replace'
      expect(vm.createLabel).toBe(wrapper.vm.$t('lastfm.replaceAction'))
    })

    it('offers the existing playlist names to pick from', async () => {
      const { vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      expect(vm.playlistNames).toContain('Weekly Charts')
    })

    it('survives the name field being cleared', async () => {
      const { vm } = await searchWithPlaylists([{ id: 'p1', name: 'Weekly Charts' }])
      vm.playlistNameValue = null

      expect(vm.playlistName).toBe('')
      expect(vm.existingPlaylist).toBeNull()
    })
  })

  it('shows the backend reason for a failed lookup and stays on the form', async () => {
    const { ConnectApiError } = await import('@/services/connect/http')
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockRejectedValue(
      new ConnectApiError('failed', { detail: 'User not found' }),
    )
    stubSearch([])

    const { vm } = await openDialog()
    vm.op = 'mytop'
    vm.username = 'nobody'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(vm.error).toBe('User not found')
    expect(vm.step).toBe('form')
  })

  it('says so when Last.fm returned nothing rather than opening an empty result', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { vm } = await openDialog()
    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(vm.step).toBe('form')
    expect(vm.error).toBeTruthy()
  })

  it('stops searching when the dialog is closed mid-run', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, artist: 'A', mbid: '' })),
    )
    const { vm } = await openDialog()
    const search3 = vi.fn(async () => {
      // Close the dialog as soon as the first lookup goes out.
      vm.visible = false
      return { songs: [] }
    })
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)

    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(search3.mock.calls.length).toBeLessThan(30)
  })

  // The ListenBrainz half shares the matcher, the result step and the
  // playlist creation with Last.fm — these only pin what is genuinely
  // different: which backend is asked, and which sources are offered.
  describe('opened for ListenBrainz', () => {
    async function openWith(source: 'lastfm' | 'listenbrainz') {
      const wrapper = mount(LastfmPlaylistDialog, { global: globalOptions })
      const vm = wrapper.vm as unknown as Record<string, unknown> & {
        open: (s?: string) => void
      }
      vm.open(source)
      await flushPromises()
      return { wrapper, vm }
    }

    function lbTrack(title: string, artist: string) {
      return { title, artist, mbid: '', album: '', coverArtUrl: '', duration: 0 }
    }

    it('offers the ListenBrainz sources, not the Last.fm ones', async () => {
      stubSearch([])
      const { vm } = await openWith('listenbrainz')

      const values = (vm.sourceOptions as { value: string }[]).map((option) => option.value)
      expect(values).toEqual(['charts', 'genre', 'artist', 'mytop', 'recommended'])
    })

    it('asks ListenBrainz for the chart and labels the column with it', async () => {
      const getTracks = vi
        .spyOn(listenbrainzApi, 'getListenbrainzTracks')
        .mockResolvedValue([lbTrack('Believe', 'Cher')])
      stubSearch([makeSong('s1', { title: 'Believe', artist: 'Cher' })])

      const { wrapper, vm } = await openWith('listenbrainz')
      await (vm as unknown as { search: () => Promise<void> }).search()
      await flushPromises()

      expect(getTracks).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'charts', period: 'month' }),
      )
      const head = document.querySelector('.tracks-head')?.textContent ?? ''
      expect(head).toContain(wrapper.vm.$t('listenbrainz.columnListenbrainz'))
    })

    it('has no country picker — ListenBrainz has no per-country charts', async () => {
      stubSearch([])
      const { wrapper } = await openWith('listenbrainz')
      expect(wrapper.findComponent({ name: 'VAutocomplete' }).exists()).toBe(false)
    })

    it('sends the username and range for a listening history', async () => {
      const getTracks = vi.spyOn(listenbrainzApi, 'getListenbrainzTracks').mockResolvedValue([])
      stubSearch([])

      const { vm } = await openWith('listenbrainz')
      vm.op = 'mytop'
      vm.username = 'listener'
      vm.lbPeriod = 'year'
      await (vm as unknown as { search: () => Promise<void> }).search()

      expect(getTracks).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'mytop', username: 'listener', period: 'year' }),
      )
    })

    it('sends the recommended op for the personalized feed', async () => {
      const getTracks = vi.spyOn(listenbrainzApi, 'getListenbrainzTracks').mockResolvedValue([])
      stubSearch([])

      const { vm } = await openWith('listenbrainz')
      vm.op = 'recommended'
      vm.username = 'listener'
      await (vm as unknown as { search: () => Promise<void> }).search()

      expect(getTracks).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'recommended', username: 'listener' }),
      )
    })

    it('sends the tag for a ListenBrainz genre', async () => {
      const getTracks = vi.spyOn(listenbrainzApi, 'getListenbrainzTracks').mockResolvedValue([])
      stubSearch([])

      const { vm } = await openWith('listenbrainz')
      vm.op = 'genre'
      vm.genreTag = 'vaporwave'
      await (vm as unknown as { search: () => Promise<void> }).search()

      expect(getTracks).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'genre', tag: 'vaporwave' }),
      )
    })
  })
})
