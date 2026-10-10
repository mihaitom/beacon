import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { VAppBar } from 'vuetify/components'
import { i18n } from '@/i18n'
import { PHONE_LANDSCAPE_QUERY } from '@/composables/phoneLandscape'
import MobileLayout from '../MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const realMatchMedia = window.matchMedia
const wrappers: VueWrapper[] = []

// Each shell listens on the window; one left mounted answers the next
// test's events too.
afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

/** jsdom has no orientation to turn, so the one query that asks is answered
 * here; everything else stays unmatched. */
function holdPhone(sideways: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: sideways && query === PHONE_LANDSCAPE_QUERY,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mountLayout(routeName: string) {
  setActivePinia(createPinia())
  const wrapper = mount(MobileLayout, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { name: routeName }, $router: { push: () => {} } },
      stubs: {
        RouterView: true,
        MobileTabBar: true,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
        PartyModeButton: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('the mobile shell on a phone held sideways', () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  it('hands Now Playing the whole screen', () => {
    holdPhone(true)
    const wrapper = mountLayout('m-now-playing')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(false)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(false)
  })

  it('keeps both bars on every other page, where they are the way around', () => {
    holdPhone(true)
    const wrapper = mountLayout('m-library')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(true)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(true)
  })

  it('keeps both bars on Now Playing held upright', () => {
    holdPhone(false)
    const wrapper = mountLayout('m-now-playing')

    expect(wrapper.getComponent(VAppBar).props('modelValue')).toBe(true)
    expect(wrapper.getComponent({ name: 'MobileTabBar' }).props('active')).toBe(true)
  })
})

describe('the mobile shell after the phone turns', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('scrolls the document back to its top, once straight away and once it has settled', () => {
    // The installed iOS app keeps the upright status bar's offset as the
    // document's scroll after a rotation, which only a scroll resets - see
    // resetDocumentScroll.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] })
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    mountLayout('m-now-playing')

    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersToNextFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)

    vi.advanceTimersByTime(1000)
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  it('stops listening once the shell is gone', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] })
    mountLayout('m-library').unmount()
    wrappers.length = 0

    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(1000)
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
