import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'

// Same reason as navigationHistory.test.ts: the real router would drag
// every route guard into a test about two buttons.
vi.mock('@/router', () => ({
  default: {
    options: { history: { state: { back: null, forward: null } } },
    afterEach: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  },
}))

import router from '@/router'
import { navigationHistory } from '@/services/navigationHistory'
import NavHistoryControls from '../NavHistoryControls.vue'

const vuetify = createVuetify({ components, directives })

function mountControls() {
  return mount(NavHistoryControls, { global: { plugins: [vuetify, i18n] } })
}

describe('NavHistoryControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigationHistory.canGoBack = false
    navigationHistory.canGoForward = false
  })

  it('shows both arrows greyed out at the first page instead of hiding them', async () => {
    const wrapper = mountControls()

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('goes back once the history has somewhere to go', async () => {
    navigationHistory.canGoBack = true
    const wrapper = mountControls()
    await wrapper.vm.$nextTick()

    await wrapper.findAll('button')[0]!.trigger('click')

    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.forward).not.toHaveBeenCalled()
  })

  it('goes forward with the second arrow', async () => {
    navigationHistory.canGoForward = true
    const wrapper = mountControls()
    await wrapper.vm.$nextTick()

    await wrapper.findAll('button')[1]!.trigger('click')

    expect(router.forward).toHaveBeenCalledTimes(1)
  })

  /** Both arrows carry the same icon shape as the transport controls, so
   * the only thing telling a screen reader them apart is the label. */
  it('names each direction for a reader that cannot see the chevron', () => {
    const wrapper = mountControls()

    const labels = wrapper.findAll('button').map((button) => button.attributes('aria-label'))
    expect(new Set(labels).size).toBe(2)
    expect(labels.every((label) => Boolean(label))).toBe(true)
  })
})
