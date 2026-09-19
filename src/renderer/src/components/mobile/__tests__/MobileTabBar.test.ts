import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import MobileTabBar from '../MobileTabBar.vue'

const vuetify = createVuetify({ components, directives })
const realMatchMedia = window.matchMedia

/** Stands in for the browser's own media queries: `standalone` says the
 * shell owns the screen, `touch` says the screen is the input. jsdom has no
 * display mode or pointer type of its own to set, and the real browser
 * runner cannot be put into standalone mode either, so this is the one
 * place the two can actually be varied. */
function stubMediaQueries({ standalone, touch }: { standalone: boolean; touch: boolean }) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('pointer: coarse') ? touch : standalone,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

async function mountBar() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/m/library', component: { template: '<div />' } }],
  })
  await router.push('/m/library')
  await router.isReady()
  // Wrapped in a v-layout: the bar is a `v-bottom-navigation app`, which
  // registers itself with Vuetify's layout system and throws mounted on its
  // own - MobileLayout.vue is what provides that in the app.
  return mount(
    { components: { MobileTabBar }, template: '<v-layout><mobile-tab-bar /></v-layout>' },
    { global: { plugins: [vuetify, i18n, router] } },
  )
}

describe('mobile tab bar gesture gap', () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  /** The empty strip below the tabs exists for one thing only: the swipe-up
   * gesture the OS listens for at the bottom edge of a touchscreen. Both
   * halves of that have to hold, and each one on its own has produced a
   * wrong answer - reading the display mode alone put the strip into the
   * installed desktop PWA, whose window can be dragged narrow enough for
   * the mobile shell (useIsMobileWeb.ts goes by viewport width alone) and
   * which has a mouse and no gesture strip; reading neither left it in an
   * ordinary browser tab, where the browser's own toolbar sits below the
   * bar and the strip was just dead space. */
  it.each([
    { standalone: true, touch: true, gap: true, what: 'a phone with the app installed' },
    {
      standalone: true,
      touch: false,
      gap: false,
      what: 'the installed desktop PWA, dragged narrow',
    },
    { standalone: false, touch: true, gap: false, what: 'a phone in an ordinary browser tab' },
    { standalone: false, touch: false, gap: false, what: 'a narrow desktop browser window' },
  ])('$what: gap $gap', async ({ standalone, touch, gap }) => {
    setActivePinia(createPinia())
    useAuthStore().capabilities.internetRadio = true
    stubMediaQueries({ standalone, touch })

    const wrapper = await mountBar()
    expect(wrapper.findComponent(MobileTabBar).vm.gestureGap > 0).toBe(gap)
  })
})
