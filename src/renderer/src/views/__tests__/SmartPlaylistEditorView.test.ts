import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import * as client from '@/services/navidrome/client'
import NavidromePasswordDialog from '@/components/smartPlaylist/NavidromePasswordDialog.vue'
import SmartOpaqueRow from '@/components/smartPlaylist/SmartOpaqueRow.vue'
import SmartPreviewPanel from '@/components/smartPlaylist/SmartPreviewPanel.vue'
import SmartRuleRow from '@/components/smartPlaylist/SmartRuleRow.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import SmartPlaylistEditorView from '../SmartPlaylistEditorView.vue'

vi.mock('@/services/navidrome/client', async () => {
  class NavidromeLoginRequired extends Error {}
  class NavidromePasswordRejected extends Error {}
  return {
    NavidromeLoginRequired,
    NavidromePasswordRejected,
    getNavidromePlaylist: vi.fn(),
    createSmartPlaylist: vi.fn(),
    updateSmartPlaylist: vi.fn(),
    loginToNavidrome: vi.fn(),
  }
})

const vuetify = createVuetify({ components, directives })

const catalogue = [
  makeSong('loved', { title: 'A', genre: 'Jazz', starred: true, playCount: 9 }),
  makeSong('plain', { title: 'B', genre: 'Rock', playCount: 0 }),
]

function navidromePlaylist(overrides: Partial<client.NavidromePlaylist> = {}) {
  return {
    id: 'pl1',
    name: 'Late night',
    comment: '',
    public: false,
    path: '',
    ownerId: 'u1',
    rules: { all: [{ is: { loved: true } }] },
    ...overrides,
  }
}

async function mountEditor(path = '/playlists/smart/new') {
  const library = useLibraryStore()
  library.allSongs = catalogue
  library.allSongsLoaded = true
  vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
  vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()
  vi.spyOn(library, 'fetchArtists').mockResolvedValue()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/playlists', name: 'playlists', component: { template: '<div />' } },
      {
        path: '/playlists/smart/new',
        name: 'smart-playlist-new',
        component: SmartPlaylistEditorView,
      },
      {
        path: '/playlists/:id/rules',
        name: 'smart-playlist-rules',
        component: SmartPlaylistEditorView,
      },
      { path: '/playlists/:id', name: 'playlist-detail', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const host = mount(
    { components: { SmartPlaylistEditorView }, template: '<v-app><router-view /></v-app>' },
    { global: { plugins: [vuetify, i18n, router] } },
  )
  await flushPromises()
  const wrapper = host.findComponent(SmartPlaylistEditorView)
  return { host, wrapper, router }
}

/** Lets the debounced preview run. */
async function settlePreview() {
  await new Promise((resolve) => setTimeout(resolve, 200))
  await flushPromises()
}

function buttonWithText(host: ReturnType<typeof mount>, text: string) {
  return host.findAll('button').find((button) => button.text().trim() === text)
}

const t = (key: string) => i18n.global.t(key)

describe('SmartPlaylistEditorView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(client.getNavidromePlaylist).mockReset()
    vi.mocked(client.createSmartPlaylist).mockReset()
    vi.mocked(client.updateSmartPlaylist).mockReset()
    vi.mocked(client.loginToNavidrome).mockReset()
  })

  describe('a new smart playlist', () => {
    it('starts empty, with ideas to start from', async () => {
      const { host } = await mountEditor()

      expect(host.findAllComponents(SmartRuleRow)).toHaveLength(0)
      expect(host.text()).toContain(t('smartPlaylists.presets.loved'))
    })

    it('fills rules and name from an idea', async () => {
      const { host, wrapper } = await mountEditor()

      const chip = host
        .findAll('.v-chip')
        .find((c) => c.text() === t('smartPlaylists.presets.loved'))
      await chip!.trigger('click')

      expect(host.findAllComponents(SmartRuleRow)).toHaveLength(1)
      expect((wrapper.vm as unknown as { name: string }).name).toBe(
        t('smartPlaylists.presets.loved'),
      )
    })

    it('leaves a name the user typed alone when an idea is picked', async () => {
      const { host, wrapper } = await mountEditor()
      await host.find('.smart-editor__name').setValue('Mine')

      const chip = host
        .findAll('.v-chip')
        .find((c) => c.text() === t('smartPlaylists.presets.loved'))
      await chip!.trigger('click')

      expect((wrapper.vm as unknown as { name: string }).name).toBe('Mine')
    })

    it('adds and removes conditions', async () => {
      const { host } = await mountEditor()

      await buttonWithText(host, t('smartPlaylists.addCondition'))!.trigger('click')
      await buttonWithText(host, t('smartPlaylists.addCondition'))!.trigger('click')
      expect(host.findAllComponents(SmartRuleRow)).toHaveLength(2)

      host.findAllComponents(SmartRuleRow)[0]!.vm.$emit('remove')
      await flushPromises()
      expect(host.findAllComponents(SmartRuleRow)).toHaveLength(1)
    })

    it('shows what the rules would pick while they are written', async () => {
      const { host } = await mountEditor()
      const chip = host
        .findAll('.v-chip')
        .find((c) => c.text() === t('smartPlaylists.presets.loved'))
      await chip!.trigger('click')
      await settlePreview()

      const preview = host.findComponent(SmartPreviewPanel)
      expect(preview.props('preview')!.songs.map((song) => song.id)).toEqual(['loved'])
    })

    it('saves nothing while a condition is unfinished, and says which', async () => {
      const { host } = await mountEditor()
      // A new condition starts as "genre contains" with nothing typed.
      await buttonWithText(host, t('smartPlaylists.addCondition'))!.trigger('click')

      await buttonWithText(host, t('smartPlaylists.save'))!.trigger('click')
      await flushPromises()

      expect(client.createSmartPlaylist).not.toHaveBeenCalled()
      expect(host.text()).toContain(t('smartPlaylists.incomplete'))
      expect(host.findComponent(SmartRuleRow).props('invalid')).toBe(true)
    })

    it('saves nothing without a single condition', async () => {
      const { host } = await mountEditor()

      await buttonWithText(host, t('smartPlaylists.save'))!.trigger('click')
      await flushPromises()

      expect(client.createSmartPlaylist).not.toHaveBeenCalled()
      expect(host.text()).toContain(t('smartPlaylists.needsRule'))
    })

    it('creates the playlist and opens it', async () => {
      vi.mocked(client.createSmartPlaylist).mockResolvedValue('new-id')
      const { host, router } = await mountEditor()
      const chip = host
        .findAll('.v-chip')
        .find((c) => c.text() === t('smartPlaylists.presets.loved'))
      await chip!.trigger('click')

      await buttonWithText(host, t('smartPlaylists.save'))!.trigger('click')
      await flushPromises()

      expect(client.createSmartPlaylist).toHaveBeenCalledWith({
        name: t('smartPlaylists.presets.loved'),
        rules: { all: [{ is: { loved: true } }], sort: 'random' },
        public: false,
      })
      expect(useLibraryStore().fetchPlaylists).toHaveBeenCalledWith(true)
      // Vue Router lands over more than one tick.
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/playlists/new-id'))
    })
  })

  describe('cancelling', () => {
    it('goes back to the playlists from a new one', async () => {
      const { host, router } = await mountEditor()

      await buttonWithText(host, t('common.cancel'))!.trigger('click')

      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/playlists'))
      expect(client.createSmartPlaylist).not.toHaveBeenCalled()
    })

    it('goes back to the playlist it was editing', async () => {
      vi.mocked(client.getNavidromePlaylist).mockResolvedValue(navidromePlaylist())
      const { host, router } = await mountEditor('/playlists/pl1/rules')

      await buttonWithText(host, t('common.cancel'))!.trigger('click')

      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/playlists/pl1'))
      expect(client.updateSmartPlaylist).not.toHaveBeenCalled()
    })
  })

  describe('an existing smart playlist', () => {
    it('saves a rule it cannot edit back unchanged', async () => {
      const kept = { contains: { mood: 'calm' } }
      vi.mocked(client.getNavidromePlaylist).mockResolvedValue(
        navidromePlaylist({ rules: { any: [{ is: { loved: true } }, kept], limitPercent: 10 } }),
      )
      vi.mocked(client.updateSmartPlaylist).mockResolvedValue()
      const { host } = await mountEditor('/playlists/pl1/rules')
      expect(host.findComponent(SmartOpaqueRow).exists()).toBe(true)

      await buttonWithText(host, t('smartPlaylists.save'))!.trigger('click')
      await flushPromises()

      expect(client.updateSmartPlaylist).toHaveBeenCalledWith('pl1', {
        name: 'Late night',
        rules: { any: [{ is: { loved: true } }, kept], limitPercent: 10 },
      })
    })

    it('shows a playlist from an .nsp file read-only, since the next scan would undo a change', async () => {
      vi.mocked(client.getNavidromePlaylist).mockResolvedValue(
        navidromePlaylist({ path: '/music/Loved.nsp' }),
      )
      const { host } = await mountEditor('/playlists/pl1/rules')

      expect(host.text()).toContain('/music/Loved.nsp')
      expect(buttonWithText(host, t('smartPlaylists.save'))).toBeUndefined()
      expect(buttonWithText(host, t('smartPlaylists.addCondition'))).toBeUndefined()
      expect(host.findComponent(SmartRuleRow).props('readonly')).toBe(true)
    })

    it('asks for the password when Navidrome wants one, then loads', async () => {
      vi.mocked(client.getNavidromePlaylist)
        .mockRejectedValueOnce(new client.NavidromeLoginRequired())
        .mockResolvedValueOnce(navidromePlaylist())
      vi.mocked(client.loginToNavidrome).mockResolvedValue()
      const { host, wrapper } = await mountEditor('/playlists/pl1/rules')

      const dialog = host.findComponent(NavidromePasswordDialog)
      expect((dialog.vm as unknown as { visible: boolean }).visible).toBe(true)
      ;(dialog.vm as unknown as { password: string }).password = 'secret'
      await (dialog.vm as unknown as { submit(): Promise<void> }).submit()
      await flushPromises()

      expect(client.loginToNavidrome).toHaveBeenCalledWith('secret')
      expect((wrapper.vm as unknown as { name: string }).name).toBe('Late night')
    })

    it('goes back to the playlist when the password is not given', async () => {
      vi.mocked(client.getNavidromePlaylist).mockRejectedValue(new client.NavidromeLoginRequired())
      const { host, router } = await mountEditor('/playlists/pl1/rules')

      ;(
        host.findComponent(NavidromePasswordDialog).vm as unknown as { finish(ok: boolean): void }
      ).finish(false)
      await flushPromises()

      // Vue Router lands over more than one tick.
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/playlists/pl1'))
    })

    it('says why a save failed and stays on the page', async () => {
      vi.mocked(client.getNavidromePlaylist).mockResolvedValue(navidromePlaylist())
      vi.mocked(client.updateSmartPlaylist).mockRejectedValue(
        new Error('Navidrome: Permission denied'),
      )
      const { host, router } = await mountEditor('/playlists/pl1/rules')

      await buttonWithText(host, t('smartPlaylists.save'))!.trigger('click')
      await flushPromises()

      expect(host.text()).toContain('Navidrome: Permission denied')
      expect(router.currentRoute.value.fullPath).toBe('/playlists/pl1/rules')
    })
  })
})
