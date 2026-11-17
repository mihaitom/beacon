import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import QueueDrawer from '@/components/queue/QueueDrawer.vue'
import { useDrawersStore } from '@/stores/drawers'
import DefaultLayout from '../DefaultLayout.vue'

const vuetify = createVuetify({ components, directives })

async function mountLayout() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:path(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  return mount(DefaultLayout, {
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
}

describe('DefaultLayout queue drawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('lets the page and the drawer keep their slide while the queue moves', async () => {
    const wrapper = await mountLayout()
    vi.useFakeTimers()
    useDrawersStore().setQueueDrawerOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.find('.v-main').classes()).toContain('is-following-queue')
    expect(wrapper.getComponent(QueueDrawer).props('sliding')).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('.v-main').classes()).not.toContain('is-following-queue')
    expect(wrapper.getComponent(QueueDrawer).props('sliding')).toBe(false)
    vi.useRealTimers()
  })

  it('does not count a queue that is already open at start as a slide', async () => {
    useDrawersStore().setQueueDrawerOpen(true)
    const wrapper = await mountLayout()
    expect(wrapper.find('.v-main').classes()).not.toContain('is-following-queue')
  })

  it('opens the drawer when it is opened after the layout mounted', async () => {
    const wrapper = await mountLayout()
    expect(wrapper.findComponent(QueueDrawer).exists()).toBe(false)

    useDrawersStore().setQueueDrawerOpen(true)
    await flushPromises()

    expect(wrapper.getComponent(QueueDrawer).props('modelValue')).toBe(true)
  })

  // An iPad turned from the phone shell, with the queue open or remembered
  // open there: the desktop shell mounts with the store already saying
  // open (#47).
  it('shows a drawer that was already open when the layout mounted', async () => {
    useDrawersStore().setQueueDrawerOpen(true)

    const wrapper = await mountLayout()
    await flushPromises()

    expect(wrapper.getComponent(QueueDrawer).props('modelValue')).toBe(true)
  })
})
