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
import MobileTabBar from '@/components/mobile/MobileTabBar.vue'

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
    // Attached: isVisible() reads computed styles, which a detached tree has none of.
    attachTo: document.body,
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

async function mountMobile() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)', component: { template: '<div />' } }],
  })
  await router.push('/m/library')
  await router.isReady()
  // In a v-layout: the tab bar registers with Vuetify's app layout.
  const wrapper = mount(
    { components: { MobileTabBar }, template: '<v-layout><mobile-tab-bar /></v-layout>' },
    { attachTo: document.body, global: { plugins: [vuetify, i18n, router] } },
  )
  wrappers.push(wrapper)
  // Settings sits behind the More tab there; the dot is on that tab.
  const more = wrapper
    .findAll('.mobile-tabbar .v-btn')
    .find((button) => button.text().includes(i18n.global.t('mobile.tabMore')))
  if (!more) throw new Error('no More tab')
  return more
}

/** A newer release shows as a dot on the settings button - on the desktop's
 * sidebar entry and on the phone's More tab alike - until Settings, which
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
