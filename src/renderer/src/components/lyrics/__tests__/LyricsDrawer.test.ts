import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import LyricsDrawer from '../LyricsDrawer.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

/** Who asks for the lyrics, and when. The drawer is the only surface that
 * does it on being opened — Now Playing loads them for whatever is
 * current whether or not anyone is looking (see its own currentSong
 * watcher), which is what used to paper over the bug below. */
describe('LyricsDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usePlaybackStore().setQueue([makeSong('a')], 0)
  })

  /** v-navigation-drawer refuses to render without a <v-app> ancestor to
   * provide Vuetify's layout injection — same wrapper QueueDrawer's own
   * tests use. `host` is the mount root; the drawer is what is asserted
   * against. */
  function mountDrawer(modelValue: boolean) {
    const host = mount(
      {
        components: { LyricsDrawer },
        props: { open: Boolean },
        template: '<v-app><lyrics-drawer :model-value="open" /></v-app>',
      },
      {
        props: { open: modelValue },
        global: { plugins: [vuetify, i18n], stubs: { LyricsPanel: true } },
      },
    )
    return host
  }

  it('loads the lyrics for a drawer that is created already open', async () => {
    // Which is how it is always created: DefaultLayout.vue doesn't render
    // this component until the moment the drawer is first opened, so its
    // first "open" is never a change — the watcher has to be immediate or
    // the first open of a session asks for nothing at all.
    const ensureLoaded = vi.spyOn(useLyricsStore(), 'ensureLoaded').mockResolvedValue()

    mountDrawer(true)

    expect(ensureLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('asks for nothing while it is closed', async () => {
    const ensureLoaded = vi.spyOn(useLyricsStore(), 'ensureLoaded').mockResolvedValue()

    const host = mountDrawer(false)

    expect(ensureLoaded).not.toHaveBeenCalled()

    // ...and does ask the moment it opens.
    await host.setProps({ open: true })
    expect(ensureLoaded).toHaveBeenCalledTimes(1)
  })

  it('follows the song while it stays open', async () => {
    const ensureLoaded = vi.spyOn(useLyricsStore(), 'ensureLoaded').mockResolvedValue()
    mountDrawer(true)
    ensureLoaded.mockClear()

    usePlaybackStore().setQueue([makeSong('b')], 0)
    await vi.waitFor(() => expect(ensureLoaded).toHaveBeenCalledTimes(1))

    expect(ensureLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })
})
