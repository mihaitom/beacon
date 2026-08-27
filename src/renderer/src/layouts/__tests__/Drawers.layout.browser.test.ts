// Real-browser layout test — run via `pnpm test:layout`. Where two fixed
// panels end up on screen is exactly what jsdom does not compute, so a
// jsdom version of this would pass with both of them at 0x0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
}

async function mountLayout() {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const wrapper = mount(DefaultLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n, router],
      stubs: { PlayerBar: true, TopBarSearch: true, CastTakeoverConfirmDialog: true },
    },
  })
  wrappers.push(wrapper)
  const playback = usePlaybackStore()
  playback.setQueue([makeSong('a'), makeSong('b')], 0)
  const lyrics = useLyricsStore()
  vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()
  return wrapper
}

function drawerRects(): DOMRect[] {
  const drawers = [...document.querySelectorAll('.beacon-drawer')] as HTMLElement[]
  return drawers.map((el) => el.getBoundingClientRect()).sort((a, b) => a.left - b.left)
}

describe('queue and lyrics drawers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('places them side by side rather than on top of each other', async () => {
    // Both are 380px wide and anchored right, so without an offset the
    // second one covers the first exactly — closing it then revealed a
    // drawer the user had no reason to expect was there.
    await page.viewport(1400, 900)
    const wrapper = await mountLayout()
    const playback = usePlaybackStore()

    playback.setQueueDrawerOpen(true)
    playback.lyricsDrawerOpen = true
    await wrapper.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 400))

    const [first, second] = drawerRects()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.right).toBeLessThanOrEqual(second!.left + 0.5)
    expect(first!.left).toBeGreaterThanOrEqual(0)
    expect(second!.right).toBeLessThanOrEqual(1400.5)
  })

  it('leaves the lyrics drawer at the edge when the queue is closed', async () => {
    await page.viewport(1400, 900)
    const wrapper = await mountLayout()
    const playback = usePlaybackStore()

    playback.lyricsDrawerOpen = true
    await wrapper.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 400))

    const [only] = drawerRects()
    expect(only).toBeDefined()
    expect(Math.abs(only!.right - 1400)).toBeLessThan(1)
  })
})
