// Settings' "clear cache" button. What is worth pinning down here is not
// that it runs, but *what it reaches*: Beacon gained two more client-side
// caches during the artwork/lyrics rework (cover art, which is by far the
// largest, and radio station logos) and this button was never extended to
// them — clearing cover art had only ever been wired to switching accounts,
// and station logos had no production clearer at all. A "clear cache" that
// leaves the biggest cache untouched is the kind of thing no test catches
// unless it names the caches.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import * as lyricsStore from '@/stores/lyrics'
import * as coverArtBatch from '@/services/connect/coverArtBatch'
import * as radioFaviconBatch from '@/services/connect/radioFaviconBatch'
import SettingsView from '../SettingsView.vue'

const vuetify = createVuetify({ components, directives })

function mountSettings(emit = vi.fn()) {
  return mount(SettingsView, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
      stubs: { ConnectButton: true, RemoteControlButton: true },
    },
  })
}

describe('SettingsView clear cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clears every cache Beacon keeps on this device', async () => {
    const wrapper = mountSettings()
    const library = vi.spyOn(useLibraryStore(), 'invalidateCache').mockResolvedValue()
    const lyrics = vi.spyOn(lyricsStore, 'clearLyricsCache').mockResolvedValue()
    const coverArt = vi.spyOn(coverArtBatch, 'clearCoverArtCache').mockResolvedValue()
    const logos = vi.spyOn(radioFaviconBatch, 'clearRadioFaviconCache').mockImplementation(() => {})

    await (wrapper.vm as unknown as { clearCache(): Promise<void> }).clearCache()

    expect(library).toHaveBeenCalledOnce()
    expect(lyrics).toHaveBeenCalledOnce()
    expect(coverArt).toHaveBeenCalledOnce()
    expect(logos).toHaveBeenCalledOnce()
  })

  it('reports success only once the caches are actually gone', async () => {
    // The three that reach IndexedDB return before the deletion has
    // happened. Saying "cleared" over a wipe still in progress is both
    // untrue and losable — a reload right behind the toast can abort the
    // transaction that was going to do it.
    const emit = vi.fn()
    const wrapper = mountSettings(emit)
    let finishArtworkWipe = (): void => {}
    vi.spyOn(useLibraryStore(), 'invalidateCache').mockResolvedValue()
    vi.spyOn(lyricsStore, 'clearLyricsCache').mockResolvedValue()
    vi.spyOn(radioFaviconBatch, 'clearRadioFaviconCache').mockImplementation(() => {})
    vi.spyOn(coverArtBatch, 'clearCoverArtCache').mockReturnValue(
      new Promise<void>((resolve) => {
        finishArtworkWipe = resolve
      }),
    )

    const done = (wrapper.vm as unknown as { clearCache(): Promise<void> }).clearCache()
    await Promise.resolve()

    expect(emit).not.toHaveBeenCalled()
    expect((wrapper.vm as unknown as { clearingCache: boolean }).clearingCache).toBe(true)

    finishArtworkWipe()
    await done

    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]![1]).toMatchObject({ level: 'success' })
    expect((wrapper.vm as unknown as { clearingCache: boolean }).clearingCache).toBe(false)
  })

  it('stops looking busy even when a wipe fails', async () => {
    const wrapper = mountSettings()
    vi.spyOn(useLibraryStore(), 'invalidateCache').mockResolvedValue()
    vi.spyOn(lyricsStore, 'clearLyricsCache').mockResolvedValue()
    vi.spyOn(radioFaviconBatch, 'clearRadioFaviconCache').mockImplementation(() => {})
    vi.spyOn(coverArtBatch, 'clearCoverArtCache').mockRejectedValue(new Error('IndexedDB is gone'))

    await expect(
      (wrapper.vm as unknown as { clearCache(): Promise<void> }).clearCache(),
    ).rejects.toThrow()

    expect((wrapper.vm as unknown as { clearingCache: boolean }).clearingCache).toBe(false)
  })
})
