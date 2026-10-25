// The frame of Now Playing's debug overlays: a legend that is reachable but
// out of the way, and a copy that takes one timestamped snapshot - the
// readings change faster than a pointer can select them (reported
// 2026-09-07 while pasting readings next to connect's own log lines).
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import DebugPanel from '../DebugPanel.vue'

const vuetify = createVuetify({ components, directives })

function mountPanel(legend = '<dt>Δ</dt><dd>The two subtracted.</dd>') {
  return mount(DebugPanel, {
    props: { title: 'Visualizer sync', copyText: () => 'Δ: +0.23s' },
    slots: { default: '<p>readings</p>', ...(legend ? { legend } : {}) },
    global: { plugins: [vuetify] },
  })
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

function copyIcon(wrapper: ReturnType<typeof mountPanel>): string {
  return wrapper.get('.debug-panel__copy .v-icon').classes().join(' ')
}

describe('DebugPanel', () => {
  it('starts with the legend folded away, and opens and closes it', async () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.debug-panel__legend').exists()).toBe(false)

    await wrapper.get('.debug-panel__help').trigger('click')
    expect(wrapper.get('.debug-panel__legend').text()).toContain('The two subtracted.')

    await wrapper.get('.debug-panel__help').trigger('click')
    expect(wrapper.find('.debug-panel__legend').exists()).toBe(false)
  })

  it('offers no legend button when there is nothing to explain', () => {
    const wrapper = mountPanel('')

    expect(wrapper.find('.debug-panel__help').exists()).toBe(false)
  })

  it('copies the reading under its title and the time it was taken', async () => {
    const writeText = stubClipboard()
    const wrapper = mountPanel()

    await wrapper.get('.debug-panel__copy').trigger('click')

    const [first, ...rest] = (writeText.mock.calls[0]![0] as string).split('\n')
    expect(first).toMatch(/^Visualizer sync @ .+/)
    expect(rest).toEqual(['Δ: +0.23s'])
  })

  it('acknowledges the copy, so a click that did nothing is visible', async () => {
    stubClipboard()
    const wrapper = mountPanel()
    expect(copyIcon(wrapper)).toContain('mdi-content-copy')

    await wrapper.get('.debug-panel__copy').trigger('click')
    await flushPromises()

    expect(copyIcon(wrapper)).toContain('mdi-check')
  })

  /** No clipboard at all outside a secure context - the throw comes from
   * the property access itself. The readings stay on screen either way. */
  it('survives a clipboard that is not there', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountPanel()

    await wrapper.get('.debug-panel__copy').trigger('click')
    await flushPromises()

    expect(copyIcon(wrapper)).toContain('mdi-content-copy')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
