// An album's tracks the library does not hold (missingTracks), drawn among
// its songs: where they land, that they never shift which song a row
// plays, that they preview from Deezer and that their menu copies
// "Artist - Title".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { usePlaybackStore } from '@/stores/playback'
import type { DeezerAlbumTrack } from '@/services/connect/deezer'
import type { EditionComparison, MissingTrack } from '@/services/library/missingTracks'
import SongTable from '../SongTable.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function missing(title: string, position: number, extra: Partial<DeezerAlbumTrack> = {}) {
  return {
    position,
    track: {
      title,
      titleShort: title,
      artist: 'Artist',
      duration: 180,
      discNumber: 1,
      trackNumber: 0,
      deezerId: 77,
      album: 'Album (Deluxe)',
      ...extra,
    },
  } satisfies MissingTrack
}

const songs = [
  makeSong('a', { title: 'One', trackNumber: 1 }),
  makeSong('b', { title: 'Three', trackNumber: 3 }),
]

function mountTable(
  missing: MissingTrack[],
  props: Record<string, unknown> = {},
  trackNumbers: Record<string, number> = {},
) {
  const edition: EditionComparison = { missing, trackNumbers }
  return mount(SongTable, {
    props: { songs, defaultSortKey: null, groupByDisc: true, edition, ...props },
    global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } },
  })
}

/** Every row's title, in the order on screen, missing ones marked. */
function rowTitles(wrapper: ReturnType<typeof mountTable>): string[] {
  return wrapper.findAll('.song-row, .missing-row').map((row) => {
    const title = row.find('.text-body-medium').text()
    return row.classes('missing-row') ? `(${title})` : title
  })
}

describe('missing tracks in a song table', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('draws them at their place on the album, before, between and after the songs', () => {
    const wrapper = mountTable([missing('Intro', 0), missing('Two', 1), missing('Bonus', 2)])
    expect(rowTitles(wrapper)).toEqual(['(Intro)', 'One', '(Two)', 'Three', '(Bonus)'])
  })

  it('sorts them in with the songs under a column sort', () => {
    const wrapper = mountTable([missing('Two', 1), missing('Bonus', 2)], {
      defaultSortKey: 'title',
    })
    expect(rowTitles(wrapper)).toEqual(['(Bonus)', 'One', 'Three', '(Two)'])
  })

  it("numbers the songs by the edition's numbering, sorted by number too", () => {
    // "Three" is tagged as track 3 but is track 6 on the edition.
    const tracks = [missing('Four', 1, { trackNumber: 4 }), missing('Two', 1, { trackNumber: 2 })]
    const wrapper = mountTable(tracks, { groupByDisc: false }, { a: 1, b: 6 })
    const numbers = () =>
      wrapper.findAll('.song-row, .missing-row').map((row) => row.find('div').text())
    expect(numbers()).toEqual(['1', '4', '2', '6'])

    const sorted = mountTable(
      tracks,
      { groupByDisc: false, defaultSortKey: 'track' },
      { a: 1, b: 6 },
    )
    expect(rowTitles(sorted)).toEqual(['One', '(Two)', '(Four)', 'Three'])
  })

  it('groups a missing second disc under its own heading', () => {
    const wrapper = mountTable([missing('Disc Two Song', 2, { discNumber: 2 })])
    const text = wrapper.text()
    expect(text).toContain(i18n.global.t('library.disc', { number: 2 }))
    expect(text.indexOf('Disc Two Song')).toBeGreaterThan(
      text.indexOf(i18n.global.t('library.disc', { number: 2 })),
    )
  })

  it('still plays the song a row shows, with only the songs in the queue', async () => {
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const wrapper = mountTable([missing('Intro', 0), missing('Two', 1)])

    await wrapper.findAll('.song-row')[1]!.trigger('dblclick')

    const [queued, position] = play.mock.calls[0]!
    expect(queued.map((song) => song.id)).toEqual(['a', 'b'])
    expect(position).toBe(1)
  })

  it("previews a missing track's Deezer excerpt and stops it on a second click", async () => {
    const playback = usePlaybackStore()
    const start = vi.spyOn(playback, 'startTracksPreview').mockResolvedValue()
    const end = vi.spyOn(playback, 'endPreview').mockImplementation(() => {})
    const wrapper = mountTable([missing('Two', 1)])

    await wrapper.find('.missing-row').trigger('dblclick')
    const [previewed] = start.mock.calls[0]!
    expect(previewed.map((song) => [song.id, song.title, song.album])).toEqual([
      ['deezer:77', 'Two', 'Album (Deluxe)'],
    ])

    playback.preview = { songs: previewed, picks: [0], index: 0, resumeAt: 0, whole: false }
    await wrapper.find('.missing-row').trigger('dblclick')
    expect(end).toHaveBeenCalled()
  })

  it('offers no preview of a track Deezer has none of', async () => {
    const start = vi.spyOn(usePlaybackStore(), 'startTracksPreview').mockResolvedValue()
    const wrapper = mountTable([missing('Two', 1, { deezerId: 0 })])

    await wrapper.find('.missing-row').trigger('dblclick')
    await openMenu(wrapper)
    await menuItem(wrapper, i18n.global.t('builder.noPreview')).trigger('click')
    expect(start).not.toHaveBeenCalled()
  })

  it('previews from its menu', async () => {
    const start = vi.spyOn(usePlaybackStore(), 'startTracksPreview').mockResolvedValue()
    const wrapper = mountTable([missing('Two', 1)])

    await openMenu(wrapper)
    await menuItem(wrapper, i18n.global.t('builder.preview')).trigger('click')

    expect(start.mock.calls[0]![0].map((song) => song.id)).toEqual(['deezer:77'])
  })

  it('copies "Artist - Title" from its menu, to look the song up', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mountTable([missing('Two', 1)])

    await openMenu(wrapper)
    await menuItem(wrapper, i18n.global.t('library.copyArtistTitle')).trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('Artist - Two')
  })
})

async function openMenu(wrapper: ReturnType<typeof mountTable>) {
  await wrapper.get('.missing-row button').trigger('click')
  await flushPromises()
}

function menuItem(wrapper: ReturnType<typeof mountTable>, label: string) {
  return wrapper
    .findAllComponents({ name: 'VListItem' })
    .find((item) => item.text().includes(label))!
}
