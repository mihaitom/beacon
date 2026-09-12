// Real-browser test: the row is a link and the play button sits inside it.
// Whether tapping that button also follows the link is decided by the
// browser's own anchor activation, which jsdom does not run at all - there
// the button passes with or without the .prevent that makes it correct.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import MobileAlbumRow from '../MobileAlbumRow.vue'
import type { Album } from '@/types/library'

const album = { id: 'al1', name: 'Album', artist: 'Artist', coverArtId: null, year: 1999 } as Album

const vuetify = createVuetify({ components, directives })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
}

let currentWrapper: VueWrapper | null = null

async function mountRow() {
  const router = makeRouter()
  await router.push('/m/library')
  await router.isReady()
  setActivePinia(createPinia())
  const played: unknown[] = []
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(MobileAlbumRow, { album, onPlay: () => played.push(album) }),
        }),
    },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  currentWrapper = wrapper
  await wrapper.vm.$nextTick()
  return { router, played }
}

describe('MobileAlbumRow', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
  })

  it('opens the album when the row is tapped', async () => {
    const { router } = await mountRow()

    document.querySelector<HTMLElement>('.mobile-album-row')!.click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(router.currentRoute.value.fullPath).toBe('/m/albums/al1')
  })

  it('plays without opening it when the button is tapped', async () => {
    const { router, played } = await mountRow()

    document.querySelector<HTMLElement>('.mobile-album-row button')!.click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(played).toHaveLength(1)
    expect(router.currentRoute.value.fullPath).toBe('/m/library')
  })
})
