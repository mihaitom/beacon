// The track-info sheet and the row entry that opens it. The mapping from a
// server's answer to the rows shown has its own test next to it
// (services/library/songDetails.ts) — what is covered here is the wiring:
// the menu entry, the fetch, and the three states the dialog can be in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { RawSongDetail } from '@/services/subsonic/types'
import type { Song } from '@/types/library'
import SongRow from '../SongRow.vue'
import SongInfoDialog from '../SongInfoDialog.vue'

const vuetify = createVuetify({ components, directives })

const globalOptions = {
  plugins: [vuetify, i18n],
  stubs: { CoverArt: true, RouterLink: true },
  // main.ts installs this as a global property for the whole app; a bare
  // mount has no such app, and SongRow reaches for it by name.
  mocks: { $emitter: emitter },
}

/** Points the store's client at a stub, so nothing here reaches a real
 * server. Returns the getSongDetails mock to drive per test. */
function stubClient(): ReturnType<typeof vi.fn> {
  const getSongDetails = vi.fn()
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    getSongDetails,
    // Opening a row's menu warms the Add-to-playlist submenu (see
    // SongRow.openMenu) — not what is under test, but it goes through the
    // same client.
    getPlaylists: vi.fn().mockResolvedValue([]),
    // The dialog's header backdrop asks the client for the cover's URL —
    // the artwork itself is stubbed out below, so an empty string is
    // enough to keep the computed off a real server.
    coverArtUrl: vi.fn(() => ''),
  } as unknown as SubsonicClient)
  return getSongDetails
}

// Every mount creates its own Vuetify app and with it its own overlay
// container, so these read the document rather than one container - and
// afterEach clears them out so a test never sees the last one's leftovers.
function sheetText(): string {
  return document.body.textContent ?? ''
}

function labelledRows(): Record<string, string> {
  const labels = [...document.querySelectorAll('.song-info__label')]
  const values = [...document.querySelectorAll('.song-info__value')]
  const pairs: Record<string, string> = {}
  labels.forEach((label, index) => {
    pairs[label.textContent?.trim() ?? ''] = values[index]?.textContent?.trim() ?? ''
  })
  return pairs
}

/** The rendered entries of an open context menu, which Vuetify teleports
 * out of the row's own tree. */
function menuEntry(label: string): DOMWrapper<Element> | undefined {
  const element = [...document.querySelectorAll('.v-list-item')].find(
    (item) => item.textContent?.trim() === label,
  )
  return element ? new DOMWrapper(element) : undefined
}

const detail: RawSongDetail = {
  id: 's1',
  title: 'Slow Return',
  suffix: 'flac',
  samplingRate: 44100,
  path: '/music/Slow Return.flac',
}

const mounted: { unmount: () => void }[] = []

function openRow(props: { song: Song; index: number }) {
  const wrapper = mount(SongRow, { props, global: globalOptions })
  mounted.push(wrapper)
  return wrapper
}

function openDialog() {
  const wrapper = mount(SongInfoDialog, { global: globalOptions })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.querySelectorAll('.v-overlay-container').forEach((element) => element.remove())
  emitter.all.clear()
  vi.restoreAllMocks()
})

describe('the Info entry on a song row', () => {
  it('asks the app-wide sheet to open for that one song', async () => {
    stubClient()
    const opened: Song[] = []
    emitter.on('showSongInfo', (value) => opened.push(value))
    const wrapper = openRow({ song: makeSong('s1'), index: 0 })

    await wrapper.trigger('contextmenu', { clientX: 10, clientY: 10 })
    await menuEntry('Info')!.trigger('click')
    await flushPromises()

    expect(opened).toHaveLength(1)
    expect(opened[0]!.id).toBe('s1')
  })

  /** Unlike Play Next or Add to Queue, this one stays about the row that
   * was right-clicked however many others happen to be selected — it shows
   * one track's fields. */
  it('is offered even for a track with no artwork, unlike Show image', async () => {
    stubClient()
    const wrapper = openRow({ song: makeSong('s1', { coverArtId: null }), index: 0 })

    await wrapper.trigger('contextmenu', { clientX: 10, clientY: 10 })

    const labels = [...document.querySelectorAll('.v-list-item-title')].map((item) =>
      item.textContent?.trim(),
    )
    expect(labels).toContain('Info')
    expect(labels).not.toContain('Show image')
  })
})

describe('SongInfoDialog', () => {
  it('names the track straight away and fills in the server answer', async () => {
    const getSongDetails = stubClient()
    getSongDetails.mockResolvedValue(detail)
    openDialog()

    emitter.emit('showSongInfo', makeSong('s1', { title: 'Slow Return' }))
    await flushPromises()

    expect(sheetText()).toContain('Slow Return')
    expect(getSongDetails).toHaveBeenCalledWith('s1')
    expect(labelledRows()).toMatchObject({ Format: 'FLAC', 'Sample rate': '44.1 kHz' })
  })

  /** Several genres on one track is the norm, and they read as tags rather
   * than as a sentence - so the sheet gives each one its own chip while the
   * scalar rows stay plain text. */
  it('shows a genre list as one chip each', async () => {
    const getSongDetails = stubClient()
    getSongDetails.mockResolvedValue({
      id: 's1',
      genres: [{ name: 'Indie Rock' }, { name: 'Shoegaze' }],
      suffix: 'flac',
    })
    openDialog()

    emitter.emit('showSongInfo', makeSong('s1'))
    await flushPromises()

    const chips = [...document.querySelectorAll('.song-info__chips .v-chip')].map((chip) =>
      chip.textContent?.trim(),
    )
    expect(chips).toEqual(['Indie Rock', 'Shoegaze'])
    // The format row beside it stays plain text rather than becoming a
    // chip of its own.
    expect(document.querySelectorAll('.v-chip').length).toBe(2)
    expect(labelledRows()).toMatchObject({ Format: 'FLAC' })
  })

  it('says so when the server could not answer, instead of an empty sheet', async () => {
    const getSongDetails = stubClient()
    getSongDetails.mockRejectedValue(new Error('offline'))
    openDialog()

    emitter.emit('showSongInfo', makeSong('s1'))
    await flushPromises()

    expect(sheetText()).toContain('Could not load the details')
  })

  it('says so when the server holds nothing beyond the row itself', async () => {
    const getSongDetails = stubClient()
    getSongDetails.mockResolvedValue({ id: 's1' })
    openDialog()

    emitter.emit('showSongInfo', makeSong('s1'))
    await flushPromises()

    expect(sheetText()).toContain('beyond what the list already shows')
  })

  /** Opening a second track while the first request is still in flight
   * must not paint the first one's fields under the second one's name. */
  it('ignores an answer for a track that is no longer the one being shown', async () => {
    const getSongDetails = stubClient()
    let resolveFirst: (value: RawSongDetail) => void = () => {}
    getSongDetails.mockImplementationOnce(
      () =>
        new Promise<RawSongDetail>((resolve) => {
          resolveFirst = resolve
        }),
    )
    getSongDetails.mockResolvedValueOnce({ id: 's2', title: 'Second', suffix: 'mp3' })
    openDialog()

    emitter.emit('showSongInfo', makeSong('s1'))
    emitter.emit('showSongInfo', makeSong('s2', { title: 'Second' }))
    await flushPromises()
    resolveFirst({ id: 's1', title: 'First', suffix: 'flac' })
    await flushPromises()

    expect(labelledRows()).toMatchObject({ Format: 'MP3' })
  })
})
