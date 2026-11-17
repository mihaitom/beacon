// The phone's More tab: radio and the external sources, party, stats and
// settings.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { usePartyStore } from '@/stores/party'
import { useExternalSourceStore } from '@/stores/externalSource'
import MobileMoreView from '../MobileMoreView.vue'

const vuetify = createVuetify({ components, directives })

async function mountView() {
  vi.spyOn(useExternalSourceStore(), 'ensureLoaded').mockResolvedValue()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/m/more')
  await router.isReady()
  const wrapper = mount(MobileMoreView, {
    global: {
      plugins: [vuetify, i18n, router],
    },
  })
  await flushPromises()
  const item = (label: string) =>
    wrapper.findAll('.v-list-item').find((el) => el.text().trim() === label)
  return { wrapper, router, item }
}

describe('MobileMoreView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('leads to Radio only on a server that has it', async () => {
    const radio = i18n.global.t('nav.radio')
    useAuthStore().capabilities.internetRadio = false
    expect((await mountView()).item(radio)).toBeUndefined()

    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    const { item } = await mountView()
    expect(item(radio)?.attributes('href')).toBe('/m/radio')
  })

  /** On a server without radio the external sources were out of reach on a
   * phone altogether: their button sat on the Radio page, whose tab is not
   * there then. */
  it('leads to every external source, with or without radio', async () => {
    useAuthStore().capabilities.internetRadio = false
    useExternalSourceStore().sources = [
      { id: 'a', name: 'Folder', icon: 'mdi-folder-music', ui_path: '/x/a/' },
      { id: 'b', name: 'Concerts', icon: 'mdi-guitar-electric', ui_path: '/x/b/' },
    ]
    const { item } = await mountView()

    expect(item('Folder')?.attributes('href')).toBe('/m/external/a')
    expect(item('Concerts')?.attributes('href')).toBe('/m/external/b')
  })

  it('leads to the party page, showing how many guests are there', async () => {
    const party = usePartyStore()
    party.enabled = true
    party.hostedHere = true
    party.guests = [
      { guest_id: 'g1', name: 'Ana', connected: true },
      { guest_id: 'g2', name: 'Ben', connected: true },
    ] as typeof party.guests
    const { wrapper } = await mountView()

    const row = wrapper.get('a[href="/m/party"]')
    expect(row.text()).toContain(i18n.global.t('party.title'))
    expect(row.get('.v-badge').text()).toBe('2')
  })

  it('leads to Stats where the server keeps them, and always to Settings', async () => {
    const stats = i18n.global.t('nav.stats')
    useAuthStore().capabilities.playHistoryStats = false
    expect((await mountView()).item(stats)).toBeUndefined()

    setActivePinia(createPinia())
    useAuthStore().capabilities.playHistoryStats = true
    const { item } = await mountView()
    expect(item(stats)?.attributes('href')).toBe('/stats')
    expect(item(i18n.global.t('nav.settings'))?.attributes('href')).toBe('/settings')
  })
})
