// The corner of the picture: a new preset's name first, then what the
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
  loadPresetFile: async (key: string) =>
    key === 'builtin:other'
      ? { name: 'Other', preset: { warp: '', comp: '' } }
      : {
          name: 'Beacon - Fractal Zoom',
          preset: { warp: '', comp: '' },
          captions: [{ text: 'Mandelbrot set' }, { text: 'Seahorse Valley' }],
          reportsZoom: true,
        },
}))

import MilkdropVisualizer from '../MilkdropVisualizer.vue'

const LABEL_MS = 5000

async function mountPlaying(preset = 'builtin:beacon-fractal-zoom') {
  const wrapper = mount(MilkdropVisualizer, {
    props: { playing: true, preset, waveform: () => null },
  })
  await flushPromises()
  return wrapper
}

// A few frames' worth of the render loop.
async function frames() {
  await vi.advanceTimersByTimeAsync(100)
}

function label(wrapper: Awaited<ReturnType<typeof mountPlaying>>) {
  const element = wrapper.find('.milkdrop__label')
  return element.exists() ? element.text() : null
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

  it('keeps the zoom up for as long as the preset reports it', async () => {
    const wrapper = await mountPlaying()
    expect(wrapper.find('.milkdrop__zoom').exists()).toBe(false)

    qs.q31 = 3
    await frames()
    expect(wrapper.get('.milkdrop__zoom').text()).toBe('×8')
    await vi.advanceTimersByTimeAsync(3 * LABEL_MS)
    expect(wrapper.get('.milkdrop__zoom').text()).toBe('×8')

    // Deep in, the power of ten is raised by the page, not by characters.
    qs.q31 = 80
    await frames()
    expect(wrapper.get('.milkdrop__zoom sup').text()).toBe('24')
  })

  it("reads no zoom into a preset that does not report one - q31 is any preset's to use", async () => {
    qs.q31 = 3
    const wrapper = await mountPlaying('builtin:other')
    await frames()
    expect(wrapper.find('.milkdrop__zoom').exists()).toBe(false)
  })
})
