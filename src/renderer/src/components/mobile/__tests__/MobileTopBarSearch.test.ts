import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import MobileTopBarSearch from '../MobileTopBarSearch.vue'

const vuetify = createVuetify({ components, directives })
const page = { template: '<div />' }
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/m/home', name: 'm-home', component: page },
    { path: '/m/library', name: 'm-library', component: page },
    { path: '/m/search', name: 'm-search', component: page },
  ],
})

function mountField() {
  return mount(MobileTopBarSearch, { global: { plugins: [vuetify, i18n, router] } })
}

describe('MobileTopBarSearch', () => {
  beforeEach(async () => {
    await router.replace('/m/home')
  })

  it('opens the search page on the keyboard search key, as a step to go back from', async () => {
    const wrapper = mountField()
    await wrapper.get('input').setValue('blue')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('m-search')
    expect(router.currentRoute.value.query.q).toBe('blue')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('m-home')
  })

  it('does not leave the page while typing elsewhere', async () => {
    vi.useFakeTimers()
    const wrapper = mountField()
    await wrapper.get('input').setValue('blue')
    await vi.advanceTimersByTimeAsync(1000)

    expect(router.currentRoute.value.name).toBe('m-home')
    vi.useRealTimers()
  })

  it('follows the typing on the search page itself, without a step per pause', async () => {
    await router.push('/m/search?q=blu')
    vi.useFakeTimers()
    const wrapper = mountField()
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('blu')

    await wrapper.get('input').setValue('blue')
    await vi.advanceTimersByTimeAsync(300)
    await wrapper.get('input').setValue('blue moon')
    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    await flushPromises()

    expect(router.currentRoute.value.query.q).toBe('blue moon')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('m-home')
  })

  it('lets go of the term on leaving the search page', async () => {
    await router.push('/m/search?q=blue')
    const wrapper = mountField()
    await router.push('/m/library')
    await flushPromises()

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('')
  })
})
