// What the viewer shows *while* the full-size picture is still coming.
// The geometry has its own real-browser test next door
// (ArtworkLightbox.layout.browser.test.ts); this is about which URL is
// handed to CoverArt as the stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import type { SubsonicClient } from '@/services/subsonic/client'
import CoverArt from '../CoverArt.vue'
import ArtworkLightbox from '../ArtworkLightbox.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: { unmount: () => void }[] = []

function mountLightbox() {
  const wrapper = mount(ArtworkLightbox, {
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** Stands in for the media server's own URL builder, so the assertions can
 * be about which size was asked for rather than about auth parameters. */
function stubClient() {
  const coverArtUrl = vi.fn((id: string, size: number) => `https://server/art/${id}?size=${size}`)
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    coverArtUrl,
  } as unknown as SubsonicClient)
  return coverArtUrl
}

/** Read off the stub's props rather than its rendered attributes: the
 * dialog teleports its contents, and an empty string prop does not survive
 * as an attribute at all. */
function lazySrc(wrapper: ReturnType<typeof mountLightbox>) {
  return wrapper.findComponent(CoverArt).props('lazySrc')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
  emitter.all.clear()
  vi.restoreAllMocks()
})

describe('ArtworkLightbox placeholder', () => {
  /** Opened from an album, artist, genre or playlist page, where the same
   * 300px copy is already behind the header as its blurred backdrop: the
   * picture is there before the click, so the viewer must not sit on a
   * skeleton over an image the person could already see. */
  it('stands in with the small copy of a library cover while the big one loads', async () => {
    const coverArtUrl = stubClient()
    const wrapper = mountLightbox()

    emitter.emit('showArtwork', { coverArtId: 'cover-1', title: 'Everything Everything' })
    await flushPromises()

    expect(coverArtUrl).toHaveBeenCalledWith('cover-1', 300)
    expect(lazySrc(wrapper)).toBe('https://server/art/cover-1?size=300')
  })

  /** An external artist's photo has no cover-art id at all - its card
   * passes the small picture it is already showing, and that wins. */
  it('prefers a placeholder the opener named', async () => {
    stubClient()
    const wrapper = mountLightbox()

    emitter.emit('showArtwork', {
      imageUrl: 'https://cdn.example/large.jpg',
      placeholderImageUrl: 'https://cdn.example/small.jpg',
      title: 'Tinlicker',
    })
    await flushPromises()

    expect(lazySrc(wrapper)).toBe('https://cdn.example/small.jpg')
  })

  it('has nothing to stand in with when there is neither', async () => {
    stubClient()
    const wrapper = mountLightbox()

    emitter.emit('showArtwork', { imageUrl: 'https://cdn.example/only.jpg', title: 'Whatever' })
    await flushPromises()

    expect(lazySrc(wrapper)).toBe('')
  })
})
