// The label under the picture: a new preset's name first, then what the
// preset says about itself (see services/milkdrop/captions.ts). Butterchurn
// is a stand-in here - its side is covered by captions.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const qs: Record<string, number> = {}

vi.mock('@/services/milkdrop/butterchurn', () => ({
  butterchurn: {
    createVisualizer: () => ({
      renderer: { presetEquationRunner: { mdVSQAfterFrame: qs } },
      loadPreset: vi.fn(),
      render: vi.fn(),
      setRendererSize: vi.fn(),
    }),
  },
}))

vi.mock('@/services/milkdrop/presets', () => ({
  loadPresetFile: async () => ({
    name: 'Beacon - Fractal Zoom',
    preset: { warp: '', comp: '' },
    captions: ['Mandelbrot set', 'Seahorse Valley'],
  }),
}))

import MilkdropVisualizer from '../MilkdropVisualizer.vue'

const LABEL_MS = 5000

async function mountPlaying() {
  const wrapper = mount(MilkdropVisualizer, {
    props: { playing: true, preset: 'builtin:beacon-fractal-zoom', waveform: () => null },
  })
  await flushPromises()
  return wrapper
}

// A few frames' worth of the render loop.
async function frames() {
  await vi.advanceTimersByTimeAsync(100)
}

function label(wrapper: Awaited<ReturnType<typeof mountPlaying>>) {
  const element = wrapper.get('.milkdrop__preset')
  return element.classes().includes('milkdrop__preset--visible') ? element.text() : null
}

describe('MilkdropVisualizer captions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('OfflineAudioContext', class {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    for (const key of Object.keys(qs)) delete qs[key]
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("lets the preset's name finish before its first caption", async () => {
    qs.q32 = 1
    const wrapper = await mountPlaying()
    await frames()
    expect(label(wrapper)).toBe('Beacon - Fractal Zoom')

    await vi.advanceTimersByTimeAsync(LABEL_MS)
    expect(label(wrapper)).toBe('Mandelbrot set')
    await vi.advanceTimersByTimeAsync(LABEL_MS)
    expect(label(wrapper)).toBeNull()
  })

  it('shows a new caption as soon as the preset asks for it, once', async () => {
    const wrapper = await mountPlaying()
    await vi.advanceTimersByTimeAsync(LABEL_MS + 100)
    expect(label(wrapper)).toBeNull()

    qs.q32 = 2
    await frames()
    expect(label(wrapper)).toBe('Seahorse Valley')
    await vi.advanceTimersByTimeAsync(LABEL_MS)
    // Still asked for, but already shown.
    expect(label(wrapper)).toBeNull()
  })
})
