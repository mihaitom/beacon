import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useUpdateStore } from '@/stores/update'
import DefaultLayout from '../DefaultLayout.vue'
import MobileLayout from '../MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function mountDesktop() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(DefaultLayout, {
    global: {
      plugins: [vuetify, i18n, router],
      stubs: {
        PlayerBar: true,
        QueueDrawer: true,
        CastTakeoverConfirmDialog: true,
        TopBarSearch: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper.get('a[href="/settings"]')
}

function mountMobile() {
  const wrapper = mount(MobileLayout, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { name: 'm-library' }, $router: { push: () => {} } },
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
  return wrapper.get(`button[aria-label="${i18n.global.t('nav.settings')}"]`)
}

/** A newer release shows as a dot on the settings button - on the desktop's
 * sidebar entry and on the phone's app bar alike - until Settings, which
 * explains it, has been opened. */
describe.each([
  ['desktop', mountDesktop],
  ['mobile', mountMobile],
])('the settings dot (%s)', (_, mountSettingsButton) => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.documentElement.classList.remove('mobile-shell')
  })

  function dotShowing(button: Awaited<ReturnType<typeof mountSettingsButton>>) {
    const dot = button.find('.v-badge__badge')
    return dot.exists() && dot.isVisible()
  }

  it('shows for a release Settings has not shown yet', async () => {
    const update = useUpdateStore()
    update.available = true
    update.latestVersion = '2.0.0'

    const button = await mountSettingsButton()

    expect(dotShowing(button)).toBe(true)
  })

  it('goes away once Settings has shown it', async () => {
    const update = useUpdateStore()
    update.available = true
    update.latestVersion = '2.0.0'
    const button = await mountSettingsButton()

    update.markSeen()
    await flushPromises()

    expect(dotShowing(button)).toBe(false)
  })

  it('does not show without a newer release', async () => {
    expect(dotShowing(await mountSettingsButton())).toBe(false)
  })
})
