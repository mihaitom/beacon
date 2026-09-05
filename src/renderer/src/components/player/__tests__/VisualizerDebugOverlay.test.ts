// The sync readout shown to whoever has turned the backend log level up to
// chase a cast-sync bug. What is pinned here is that it only appears for
// them, and that the legend explaining its four numbers is reachable —
// the numbers themselves are AudioVisualizer's, forwarded straight through.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { getLogLevel } from '@/services/connect/logLevel'
import type { VisualizerFrame } from '@/services/connect/types'
import VisualizerDebugOverlay from '../VisualizerDebugOverlay.vue'

vi.mock('@/services/connect/logLevel', () => ({ getLogLevel: vi.fn() }))

const vuetify = createVuetify({ components, directives })

const DEBUG_FRAME = { visualizer: 12.34, cast: 12.11, lead: { seconds: 4.7, measured: false } }

async function mountOverlay(level = 'DEBUG', debug: VisualizerFrame['debug'] | null = DEBUG_FRAME) {
  vi.mocked(getLogLevel).mockResolvedValue({ level } as Awaited<ReturnType<typeof getLogLevel>>)
  const wrapper = mount(VisualizerDebugOverlay, {
    props: { debug },
    global: { plugins: [vuetify, i18n] },
  })
  await flushPromises()
  return wrapper
}

describe('VisualizerDebugOverlay', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays out of the way at a normal log level', async () => {
    const wrapper = await mountOverlay('INFO')

    expect(wrapper.find('.visualizer-debug-overlay').exists()).toBe(false)
  })

  it('shows the readings once the log level is turned up', async () => {
    const wrapper = await mountOverlay()

    expect(wrapper.text()).toContain('12.34')
    expect(wrapper.text()).toContain('0.23')
  })

  describe('legend', () => {
    /** Folded away by default: it is prose over the artwork, and this
     * overlay has been in the way twice already. */
    it('starts closed, so the numbers are all there is', async () => {
      const wrapper = await mountOverlay()

      expect(wrapper.find('.visualizer-debug-overlay__legend').exists()).toBe(false)
    })

    it('explains every reading once opened', async () => {
      const wrapper = await mountOverlay()

      await wrapper.get('.visualizer-debug-overlay__help').trigger('click')

      const legend = wrapper.get('.visualizer-debug-overlay__legend')
      const terms = legend.findAll('dt').map((t) => t.text())
      // One entry per line the overlay is actually showing — a reading with
      // nothing saying what it means is what this was added to fix.
      expect(terms).toEqual(['Visualizer', 'Cast', 'Δ', 'Lead'])
      expect(legend.findAll('dd')).toHaveLength(terms.length)
    })

    /** Lead is a Sonos-radio-only reading, and radio casting has the
     * visualizer switched off entirely right now (RADIO_VISUALIZER_ENABLED
     * in stores/connect.ts) — so in practice the line is absent and the
     * legend must not explain a number nobody can see. */
    it('leaves out the lead entry when there is no lead line', async () => {
      const wrapper = await mountOverlay('DEBUG', { visualizer: 12.34, cast: 12.11 })

      await wrapper.get('.visualizer-debug-overlay__help').trigger('click')

      const terms = wrapper
        .get('.visualizer-debug-overlay__legend')
        .findAll('dt')
        .map((t) => t.text())
      expect(terms).toEqual(['Visualizer', 'Cast', 'Δ'])
    })

    it('folds away again', async () => {
      const wrapper = await mountOverlay()
      const help = wrapper.get('.visualizer-debug-overlay__help')

      await help.trigger('click')
      await help.trigger('click')

      expect(wrapper.find('.visualizer-debug-overlay__legend').exists()).toBe(false)
    })
  })
})
