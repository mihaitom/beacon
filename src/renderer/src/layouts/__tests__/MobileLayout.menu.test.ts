// The phone app bar's menu: party, the equalizer while casting, settings.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { makeStatus } from '@/stores/__tests__/fixtures'
import MobileLayout from '../MobileLayout.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
  document.documentElement.classList.remove('mobile-shell')
})

async function openMenu(casting: boolean) {
  setActivePinia(createPinia())
  if (casting) {
    useConnectStore().status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
  }
  const push = vi.fn()
  const wrapper = mount(MobileLayout, {
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      mocks: { $route: { name: 'm-library' }, $router: { push } },
      stubs: {
        RouterView: true,
        MobileTabBar: true,
        MobilePlayerBar: true,
        CastTakeoverConfirmDialog: true,
        PartyModeDialog: true,
        EqualizerDialog: true,
      },
    },
  })
  wrappers.push(wrapper)
  await wrapper.get(`button[aria-label="${i18n.global.t('common.moreActions')}"]`).trigger('click')
  await flushPromises()
  const item = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('.v-list-item')).find(
      (el) => el.textContent?.trim() === label,
    )
  return { wrapper, push, item }
}

describe('the mobile app bar menu', () => {
  it('offers the equalizer only while casting', async () => {
    expect((await openMenu(false)).item(i18n.global.t('equalizer.title'))).toBeUndefined()
    expect((await openMenu(true)).item(i18n.global.t('equalizer.title'))).toBeDefined()
  })

  it('opens the party and equalizer dialogs, the equalizer fullscreen', async () => {
    const { wrapper, item } = await openMenu(true)

    item(i18n.global.t('party.title'))!.click()
    item(i18n.global.t('equalizer.title'))!.click()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'PartyModeDialog' }).props('modelValue')).toBe(true)
    const equalizer = wrapper.findComponent({ name: 'EqualizerDialog' })
    expect(equalizer.props('modelValue')).toBe(true)
    expect(equalizer.props('compact')).toBe(true)
  })

  it('leads to Settings', async () => {
    const { push, item } = await openMenu(false)

    item(i18n.global.t('nav.settings'))!.click()

    expect(push).toHaveBeenCalledWith('/settings')
  })
})
