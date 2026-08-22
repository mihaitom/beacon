import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import PlaylistDetailView from '../PlaylistDetailView.vue'
import type { Playlist } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'My mix',
    songCount: 0,
    duration: 0,
    coverArtId: null,
    public: false,
    owner: 'thomas',
    songs: [],
    ...overrides,
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/playlists', component: { template: '<div />' } },
      { path: '/playlists/:id', component: PlaylistDetailView },
    ],
  })
}

async function mountView(id = 'p1') {
  const router = makeRouter()
  await router.push(`/playlists/${id}`)
  await router.isReady()
  const host = mount(
    { components: { PlaylistDetailView }, template: '<v-app><router-view /></v-app>' },
    {
      global: {
        plugins: [vuetify, i18n, router],
        // Not registered anywhere in the test setup (see setup.ts) — the
        // error-path test below reaches remove()'s catch block, which
        // calls this to show a toast; without a stub that's a TypeError
        // on undefined instead of the failure path actually under test.
        mocks: { $emitter: { emit: vi.fn() } },
      },
    },
  )
  await flushPromises()
  const wrapper = host.findComponent(PlaylistDetailView)
  return { wrapper, host, router }
}

describe('PlaylistDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('deleting a playlist', () => {
    it('opens a confirmation dialog instead of deleting right away', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi.spyOn(library, 'deletePlaylist').mockResolvedValue()
      const { wrapper } = await mountView()

      const deleteBtn = wrapper.get('.mdi-delete-outline').element.closest('button')!
      await deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect((wrapper.vm as unknown as { deleteDialog: boolean }).deleteDialog).toBe(true)
      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('deletes and navigates back to the list once confirmed', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi.spyOn(library, 'deletePlaylist').mockResolvedValue()
      const { wrapper, router } = await mountView()
      const vm = wrapper.vm as unknown as { deleteDialog: boolean; remove(): Promise<void> }
      vm.deleteDialog = true

      await vm.remove()
      // remove() fires $router.push() without awaiting it (same
      // established pattern as every other view's post-action navigation
      // in this codebase) — flushPromises() alone isn't enough to settle
      // it, since Vue Router's own navigation resolves over more than one
      // microtask tick. vi.waitFor retries until it actually lands.
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/playlists'))

      expect(deleteSpy).toHaveBeenCalledWith('p1')
      expect(vm.deleteDialog).toBe(false)
    })

    it('keeps the dialog open and surfaces an error if the delete fails', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(makePlaylist())
      const deleteSpy = vi
        .spyOn(library, 'deletePlaylist')
        .mockRejectedValue(new Error('network error'))
      const { wrapper, router } = await mountView()
      const vm = wrapper.vm as unknown as { deleteDialog: boolean; remove(): Promise<void> }
      vm.deleteDialog = true

      await vm.remove()

      expect(deleteSpy).toHaveBeenCalledWith('p1')
      // Stays put — a failed delete must not navigate away as if it worked.
      expect(vm.deleteDialog).toBe(true)
      expect(router.currentRoute.value.path).toBe('/playlists/p1')
    })
  })
})
