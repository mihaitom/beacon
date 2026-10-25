// Real-browser test of Now Playing's debug corner - run via
// `pnpm test:layout`. Several speakers and an open legend make the cast
// stream panel far taller than a small window; it has to stay inside it
// and scroll rather than grow out past the top or bottom edge, which jsdom,
// laying out nothing, cannot tell apart.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import type { StreamTargetInfo } from '@/services/connect/streamDiagnostics'
import { useConnectStore } from '@/stores/connect'
import NowPlayingView from '@/views/NowPlayingView.vue'

vi.mock('@/services/connect/logLevel', () => ({
  getLogLevel: vi.fn().mockResolvedValue({ level: 'DEBUG' }),
}))
vi.mock('@/services/connect/fanart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/fanart')>()),
  getArtistArt: vi.fn().mockResolvedValue(null),
}))

function speaker(name: string): StreamTargetInfo {
  return {
    type: 'chromecast',
    name,
    follows: null,
    state: 'PLAYING',
    state_age: 3,
    problem: null,
    problem_age: null,
    connection: {
      current: true,
      open: true,
      outcome: null,
      age: 40,
      model: null,
      start: 0,
      bytes: 9_000_000,
      last_read: 1,
      audio_end: 200,
    },
    device: null,
    ahead: null,
    requests: [{ ago: 4, method: 'GET', model: null, range: null, icy: null, answer: null }],
  }
}

vi.mock('@/services/connect/streamDiagnostics', () => ({
  getStreamDiagnostics: vi.fn(async () => ({
    position: 40,
    track_end: 200,
    targets: ['Kitchen', 'Lounge', 'Study', 'Den', 'Hall', 'Office'].map(speaker),
  })),
}))

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function openLegend(width: number, height: number, compact: boolean) {
  await page.viewport(width, height)
  setActivePinia(createPinia())
  localStorage.setItem('beacon.showVisualizer', 'false')
  useConnectStore().$patch({
    status: { targets: [{ type: 'chromecast', name: 'Kitchen' }] },
  } as never)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  const wrapper = mount(NowPlayingView, {
    props: { compact },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n, router], stubs: { VisualizerBars: true } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('.stream-debug-overlay .debug-panel__help').trigger('click')
  await flushPromises()
  return wrapper
}

describe('Now Playing debug corner', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    localStorage.clear()
  })

  it.each([
    ['a small desktop window', 1024, 600, false],
    ['a phone', 390, 700, true],
  ])('stays inside %s with the legend open, scrolling instead', async (_, w, h, compact) => {
    const wrapper = await openLegend(w, h, compact)

    const panel = wrapper.get('.stream-debug-overlay').element.getBoundingClientRect()
    expect(panel.top).toBeGreaterThanOrEqual(0)
    expect(panel.bottom).toBeLessThanOrEqual(h)
    const scroll = wrapper.get('.stream-debug-overlay .debug-panel__scroll').element
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
  })
})
