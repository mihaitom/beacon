import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { VNavigationDrawer } from 'vuetify/components'
import DefaultLayout from '../DefaultLayout.vue'

const vuetify = createVuetify({ components, directives })

/** The rail used to expand on hover, which moved the whole layout whenever
 * the pointer crossed the left edge and gave no way to keep the labels up.
 * It is a switch now, and the choice is remembered. */
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
        LyricsDrawer: true,
        CastTakeoverConfirmDialog: true,
        TopBarSearch: true,
      },
    },
  })
}

function rail(wrapper: Awaited<ReturnType<typeof mountLayout>>) {
  return wrapper.getComponent(VNavigationDrawer)
}

describe('DefaultLayout sidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('starts collapsed to icons, the way the rail has always sat at rest', async () => {
    const wrapper = await mountLayout()

    expect(rail(wrapper).props('rail')).toBe(true)
  })

  it('does not expand on hover any more', async () => {
    const wrapper = await mountLayout()

    expect(rail(wrapper).props('expandOnHover')).toBe(false)
  })

  it('expands and collapses from its own button', async () => {
    const wrapper = await mountLayout()

    await wrapper.get('.beacon-rail__toggle').trigger('click')
    expect(rail(wrapper).props('rail')).toBe(false)

    await wrapper.get('.beacon-rail__toggle').trigger('click')
    expect(rail(wrapper).props('rail')).toBe(true)
  })

  it('remembers the choice for the next time the app opens', async () => {
    const first = await mountLayout()
    await first.get('.beacon-rail__toggle').trigger('click')
    first.unmount()

    const second = await mountLayout()

    expect(rail(second).props('rail')).toBe(false)
  })

  it('is no wider than its longest label needs', async () => {
    // Vuetify's own default is 256px; nothing in any of the five locales
    // comes close to needing that.
    const wrapper = await mountLayout()

    expect(Number(rail(wrapper).props('width'))).toBe(200)
  })

  it('carries no label of its own, just the icon', async () => {
    // Expanded, the rail is a column of labelled destinations — a row
    // spelling out "collapse sidebar" beside a hamburger reads as one more
    // of them, and says something the icon already does.
    const wrapper = await mountLayout()
    await wrapper.get('.beacon-rail__toggle').trigger('click')

    expect(wrapper.get('.beacon-rail__toggle').text()).toBe('')
  })

  it('says which way the button goes, for a screen reader that cannot see the icon', async () => {
    const wrapper = await mountLayout()
    const toggle = wrapper.get('.beacon-rail__toggle')

    expect(toggle.attributes('aria-label')).toBe('Expand sidebar')
    await toggle.trigger('click')
    expect(wrapper.get('.beacon-rail__toggle').attributes('aria-label')).toBe('Collapse sidebar')
  })
})
