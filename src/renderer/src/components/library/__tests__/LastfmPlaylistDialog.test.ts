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
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { SubsonicClient } from '@/services/subsonic/client'
import LastfmPlaylistDialog from '../LastfmPlaylistDialog.vue'
import * as lastfmApi from '@/services/connect/lastfm'
import * as listenbrainzApi from '@/services/connect/listenbrainz'

const vuetify = createVuetify({ components, directives })

const globalOptions = {
  plugins: [vuetify, i18n],
  stubs: { CoverArt: true },
  mocks: { $emitter: emitter },
}

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

  it('offers the bundled Last.fm country names, not the directory spelling', async () => {
    // geo.getTopTracks takes a country name, but its accepted spellings are
    // its own: the station directory calls the same country "The United
    // States Of America" and Last.fm rejects that. The picker sends the
    // bundled `value`, never the ISO code or the directory's name.
    stubSearch([])
    const { wrapper } = await openDialog()

    const picker = wrapper.findComponent({ name: 'VAutocomplete' })
    const items = picker.props('items') as { name: string; value: string; code: string }[]
    expect(items.find((item) => item.code === 'US')).toMatchObject({
      name: 'United States',
      value: 'United States',
    })
    expect(picker.props('itemValue')).toBe('value')
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
    // The rest stays alphabetical, and the pinned country is *moved*
    // rather than copied - so it never turns up twice.
    expect(items.filter((item) => item.name === 'Spain')).toHaveLength(1)
    expect(items.findIndex((item) => item.name === 'Germany')).toBeGreaterThan(1)
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

  it('copies one missing track as an "Artist - Title" line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
      { title: 'Missing One', artist: 'Nobody', mbid: '' },
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

    const resolved = vm.resolved as { track: { artist: string; title: string } }[]
    await (
      vm as unknown as { copyTrack: (entry: unknown, index: number) => Promise<void> }
    ).copyTrack(resolved[1], 1)

    expect(writeText).toHaveBeenCalledWith('Nobody - Missing One')
    // The row's button flips to a checkmark, which is the only feedback.
    expect(vm.copiedIndex).toBe(1)
  })

  it('does not write a ListenBrainz name typed in the builder back to settings', async () => {
    // The settings value also fills Home's "Recommended for you" shelf, so
    // looking at someone else's charts from here must not repoint it.
    const store = useListenbrainzStore()
    store.setUsername('settings-name')
    vi.spyOn(listenbrainzApi, 'getListenbrainzTracks').mockResolvedValue([
      { title: 'Anything', artist: 'Anyone', mbid: '', album: '', coverArtUrl: '', duration: 0 },
    ])
    stubSearch([])

    const { vm } = await openDialog()
    ;(vm as unknown as { open: (source: string) => void }).open('listenbrainz')
    vm.op = 'mytop'
    vm.username = 'someone-else'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()

    expect(store.username).toBe('settings-name')
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

  it('sends the found tracks to the queue instead of saving a playlist', async () => {
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
    const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue(undefined)

    const { vm } = await openDialog()
    vm.chartScope = 'global'
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()
    await (vm as unknown as { play: () => Promise<void> }).play()

    // Only the one the library has, and nothing was written as a playlist.
    expect(playSongList).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 's1' })],
      0,
      false,
      false,
    )
    expect(createPlaylist).not.toHaveBeenCalled()
    expect(vm.visible).toBe(false)
  })

  it('appends the found tracks to the queue without replacing it', async () => {
    vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([
      { title: 'Believe', artist: 'Cher', mbid: '' },
      { title: 'Nothing Here', artist: 'Nobody', mbid: '' },
    ])
    const search3 = vi.fn(async (query: string) =>
      query.startsWith('Cher')
        ? { songs: [makeSong('s1', { title: 'Believe', artist: 'Cher' })] }
        : { songs: [] },
    )
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)
    const addToQueue = vi.spyOn(usePlaybackStore(), 'addToQueue').mockImplementation(() => {})

    const { vm } = await openDialog()
    await (vm as unknown as { search: () => Promise<void> }).search()
    await flushPromises()
    ;(vm as unknown as { appendQueue: () => void }).appendQueue()

    // Only the one the library has, and the queue is appended to rather
    // than replaced.
    expect(addToQueue).toHaveBeenCalledWith([expect.objectContaining({ id: 's1' })])
    expect(vm.visible).toBe(false)
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

  it('sends the picked library song as the seed for a similar-tracks list', async () => {
    const getTracks = vi.spyOn(lastfmApi, 'getLastfmTracks').mockResolvedValue([])
    stubSearch([])

    const { vm } = await openDialog()
    vm.op = 'similar'
    vm.seedSong = makeSong('s1', { title: 'Roads', artist: 'Portishead' })
    await (vm as unknown as { search: () => Promise<void> }).search()

    expect(getTracks).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'similar', artist: 'Portishead', track: 'Roads' }),
    )
  })

  it('cannot search for similar tracks until a seed song is picked', async () => {
    stubSearch([])
    const { vm } = await openDialog()
    vm.op = 'similar'

    expect(vm.canSearch).toBe(false)
    vm.seedSong = makeSong('s1', { title: 'Roads', artist: 'Portishead' })
    expect(vm.canSearch).toBe(true)
  })

  it('looks the seed up in the library and drops it when the query changes', async () => {
    const songs = [makeSong('s1', { title: 'Roads', artist: 'Portishead' })]
    const search3 = vi.fn().mockResolvedValue({ songs })
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      search3,
    } as unknown as SubsonicClient)

    const { vm } = await openDialog()
    vm.op = 'similar'
    // Let the picker mount first: mounting it emits its own (empty)
    // search, which would otherwise supersede the query armed below.
    await flushPromises()
    const call = vm as unknown as { onSeedSearch: (value: string) => void }
    call.onSeedSearch('roads')
    // Debounced: a keystroke does not search on its own.
    expect(search3).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(search3).toHaveBeenCalledWith('roads', 15, 0, 0)
    expect(vm.seedOptions).toEqual(songs)

    // Typing over the picked track clears it; the label it would show does
    // not.
    vm.seedSong = songs[0]
    const label = (vm as unknown as { songLabel: (song: unknown) => string }).songLabel(songs[0])
    call.onSeedSearch(label)
    expect(vm.seedSong).toEqual(songs[0])
    call.onSeedSearch('something else')
    expect(vm.seedSong).toBeNull()
    // Let the trailing debounce fire while the mock is still in place.
    await new Promise((resolve) => setTimeout(resolve, 350))
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
