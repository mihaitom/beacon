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
     * visualizer switched off entirely again (RADIO_VISUALIZER_ENABLED in
     * stores/connect.ts) — so in practice the line is absent and the
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

  /** These numbers update several times a second, so selecting them by
   * pointer loses the selection to the next re-render — reported live
   * 2026-09-07 while pasting readings next to connect's own log lines. */
  describe('copying a reading', () => {
    function stubClipboard() {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      return writeText
    }

    it('copies the readings as they are shown, plus the time they were taken', async () => {
      const writeText = stubClipboard()
      const wrapper = await mountOverlay()

      await wrapper.get('.visualizer-debug-overlay__copy').trigger('click')

      const copied = writeText.mock.calls[0]![0] as string
      expect(copied).toContain('Visualizer: 12.34s')
      expect(copied).toContain('Cast: 12.11s')
      // The sign is part of the reading: which clock is ahead is the whole
      // question, and a bare "0.23" in a paste answers none of it.
      expect(copied).toContain('Δ: +0.23s')
      expect(copied).toContain('Lead: 4.70s (guessed)')
      // A timestamp to line the paste up against the log — the reason this
      // button exists at all.
      expect(copied.split('\n')[0]).toMatch(/^Visualizer sync @ .+/)
    })

    it('leaves the lead line out when there is none, rather than pasting an empty field', async () => {
      const writeText = stubClipboard()
      const wrapper = await mountOverlay('DEBUG', { visualizer: 12.34, cast: 12.72 })

      await wrapper.get('.visualizer-debug-overlay__copy').trigger('click')

      const copied = writeText.mock.calls[0]![0] as string
      expect(copied).not.toContain('Lead')
      expect(copied).toContain('Δ: -0.38s')
    })

    it('acknowledges the copy, so a click that did nothing is visible', async () => {
      stubClipboard()
      const wrapper = await mountOverlay()
      const button = wrapper.get('.visualizer-debug-overlay__copy')
      expect(button.text()).toBe('⧉')

      await button.trigger('click')
      await flushPromises()

      expect(button.text()).toBe('✓')
    })

    /** No clipboard at all outside a secure context — the throw comes from
     * the property access itself, before any promise exists. The numbers
     * stay on screen either way, so this must not take the overlay down. */
    it('survives a clipboard that is not there', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const wrapper = await mountOverlay()

      await wrapper.get('.visualizer-debug-overlay__copy').trigger('click')
      await flushPromises()

      expect(wrapper.get('.visualizer-debug-overlay__copy').text()).toBe('⧉')
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })
  })
})
