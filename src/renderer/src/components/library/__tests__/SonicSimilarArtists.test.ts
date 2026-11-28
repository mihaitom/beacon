import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { sonicSimilarArtists } from '@/services/connect/audiomuse'
import type { Artist } from '@/types/library'
import SonicSimilarArtists from '../SonicSimilarArtists.vue'

vi.mock('@/services/connect/audiomuse', () => ({
  getAudioMuseStatus: vi.fn().mockResolvedValue({ available: false, reason: 'not-configured' }),
  sonicSimilarArtists: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

function artist(id: string): Artist {
  return { id, name: `Artist ${id}`, albumCount: 1 } as Artist
}

const ArtistCardStub = { name: 'ArtistCard', props: ['artist'], template: '<i>{{ artist.id }}</i>' }
const CardShelfStub = {
  name: 'CardShelf',
  props: ['title'],
  template: '<div class="shelf"><slot /></div>',
}

function mountRow(artistId = 'seed') {
  return mount(SonicSimilarArtists, {
    props: { artistId },
    global: {
      plugins: [vuetify, i18n],
      stubs: { ArtistCard: ArtistCardStub, CardShelf: CardShelfStub },
    },
  })
}

describe('SonicSimilarArtists', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sonicSimilarArtists).mockReset()
    useAudioMuseStore().status = { available: true }
    useAudioMuseStore().checkedAt = Date.now()
  })

  it('shows the artists AudioMuse hears as close', async () => {
    vi.mocked(sonicSimilarArtists).mockResolvedValue([artist('x'), artist('y')])
    const wrapper = mountRow()
    await flushPromises()

    expect(sonicSimilarArtists).toHaveBeenCalledWith('seed', expect.any(Number))
    expect(wrapper.get('.shelf').text()).toBe('xy')
  })

  it('is not there without AudioMuse, or with nobody found', async () => {
    useAudioMuseStore().status = { available: false, reason: 'unreachable' }
    const without = mountRow()
    await flushPromises()
    expect(sonicSimilarArtists).not.toHaveBeenCalled()
    expect(without.find('.shelf').exists()).toBe(false)

    useAudioMuseStore().status = { available: true }
    vi.mocked(sonicSimilarArtists).mockResolvedValue([])
    const nobody = mountRow()
    await flushPromises()
    expect(nobody.find('.shelf').exists()).toBe(false)
  })

  it("never shows the previous artist's neighbours on the next artist's page", async () => {
    let answerFirst!: (artists: Artist[]) => void
    vi.mocked(sonicSimilarArtists)
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([artist('second')])
    const wrapper = mountRow('first')
    await wrapper.setProps({ artistId: 'next' })
    await flushPromises()

    answerFirst([artist('stale')])
    await flushPromises()

    expect(wrapper.get('.shelf').text()).toBe('second')
  })
})
