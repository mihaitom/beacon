// The corner of the picture: a new preset's name first, then what the
// preset says about itself (see services/milkdrop/captions.ts). Butterchurn
// is a stand-in here - its side is covered by captions.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const qs: Record<string, number> = {}
const loadPreset = vi.hoisted(() => vi.fn())
const createVisualizer = vi.hoisted(() => vi.fn())

vi.mock('@/services/milkdrop/butterchurn', () => ({
  butterchurn: {
    createVisualizer: createVisualizer.mockImplementation(() => ({
      renderer: { presetEquationRunner: { mdVSQAfterFrame: qs } },
      loadPreset,
      render: vi.fn(),
      setRendererSize: vi.fn(),
      connectAudio: vi.fn(),
      disconnectAudio: vi.fn(),
    })),
  },
}))

// Holds 'builtin:slow' back until a test lets it through.
const slowLoad = vi.hoisted(() => ({ release: () => {} }))

vi.mock('@/services/milkdrop/presets', () => ({
  isDemandingPreset: () => false,
  loadPresetFile: async (key: string) => {
    if (key === 'builtin:slow') {
      await new Promise<void>((resolve) => (slowLoad.release = resolve))
      return { name: 'Slow', preset: { warp: '', comp: '' } }
    }
    // Compiled before: back in a moment, not at once.
    if (key === 'builtin:quick') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { name: 'Quick', preset: { warp: '', comp: '' } }
    }
    return key === 'builtin:other'
      ? { name: 'Other', preset: { warp: '', comp: '' } }
      : key === 'builtin:loops'
        ? {
            name: 'Loops',
            preset: { warp: '', comp: 'shader_body { for (int i = 0; i < 9; i++) {} }' },
          }
        : {
            name: 'Beacon - Fractal Zoom',
            preset: { warp: '', comp: '' },
            captions: [{ text: 'Mandelbrot set' }, { text: 'Seahorse Valley' }],
            reportsZoom: true,
          }
  },
}))

const textures = vi.hoisted(() => ({ set: vi.fn() }))

// What the render scale would conclude from the GPU's timings.
const scaleState = vi.hoisted(() => ({ overloaded: false }))

vi.mock('@/services/milkdrop/resolution', () => ({
  RenderScale: class {
    scale = 1
    get overloaded() {
      return scaleState.overloaded
    }
    begin() {}
    end() {
      return null
    }
    presetChanged() {
      return null
    }
  },
}))

vi.mock('@/services/milkdrop/textures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/milkdrop/textures')>()),
  setTexture: textures.set,
  coverPicture: async (blob: Blob) => ({ fromBlob: blob, close: vi.fn() }),
}))

import MilkdropVisualizer from '../MilkdropVisualizer.vue'
import { COVER_SAMPLER } from '@/services/milkdrop/textures'
import { unpark } from '@/services/milkdrop/parking'

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

    // The power is raised by the page, not by superscript characters.
    qs.q31 = 3
    await frames()
    expect(wrapper.get('.milkdrop__zoom sup').text()).toBe('3')
    await vi.advanceTimersByTimeAsync(3 * LABEL_MS)
    expect(wrapper.get('.milkdrop__zoom sup').text()).toBe('3')

    qs.q31 = 80
    await frames()
    expect(wrapper.get('.milkdrop__zoom sup').text()).toBe('80')
  })

  it("reads no zoom into a preset that does not report one - q31 is any preset's to use", async () => {
    qs.q31 = 3
    const wrapper = await mountPlaying('builtin:other')
    await frames()
    expect(wrapper.find('.milkdrop__zoom').exists()).toBe(false)
  })

  it('hands the preset the analysed beat every frame', async () => {
    const shown = () => (globalThis as { beaconBeat?: unknown }).beaconBeat
    let beat: { index: number; strength: number } | null = { index: 3, strength: 0.7 }
    const wrapper = mount(MilkdropVisualizer, {
      props: {
        playing: true,
        preset: 'builtin:beacon-fractal-zoom',
        waveform: () => null,
        beat: () => beat,
      },
    })
    await flushPromises()
    await frames()
    expect(shown()).toEqual({ index: 3, strength: 0.7 })
    beat = null
    await frames()
    expect(shown()).toBeNull()
    wrapper.unmount()
  })
})

describe('MilkdropVisualizer cover', () => {
  beforeEach(() => {
    vi.stubGlobal('OfflineAudioContext', class {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    textures.set.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function coversShown(): unknown[] {
    return textures.set.mock.calls.filter(([, name]) => name === COVER_SAMPLER).map((c) => c[2])
  }

  it("shows the song's cover, and the next song's once it changes", async () => {
    const first = new Blob(['a'])
    const second = new Blob(['b'])
    const wrapper = mount(MilkdropVisualizer, {
      props: {
        playing: true,
        preset: 'builtin:other',
        waveform: () => null,
        cover: { key: 'a', load: async () => first },
      },
    })
    await flushPromises()
    expect(coversShown().at(-1)).toMatchObject({ fromBlob: first })

    await wrapper.setProps({ cover: { key: 'b', load: async () => second } })
    await flushPromises()
    expect(coversShown().at(-1)).toMatchObject({ fromBlob: second })
    wrapper.unmount()
  })

  it('falls back to the calm stand-in for a song without art', async () => {
    const wrapper = mount(MilkdropVisualizer, {
      props: {
        playing: true,
        preset: 'builtin:other',
        waveform: () => null,
        cover: { key: 'a', load: async () => new Blob(['a']) },
      },
    })
    await flushPromises()
    await wrapper.setProps({ cover: { key: 'none', load: async () => null } })
    await flushPromises()
    expect(coversShown().at(-1)).toBeInstanceOf(HTMLCanvasElement)
    wrapper.unmount()
  })
})

describe('MilkdropVisualizer on a device that cannot keep up', () => {
  const STARTING = 'beacon.milkdrop.starting'
  const TOO_HEAVY = 'beacon.milkdrop.tooHeavy'

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
    localStorage.clear()
    scaleState.overloaded = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('notes a preset as starting until it has drawn for a while', async () => {
    const wrapper = await mountPlaying('builtin:other')
    expect(localStorage.getItem(STARTING)).toBe('builtin:other')
    await vi.advanceTimersByTimeAsync(2000)
    expect(localStorage.getItem(STARTING)).toBeNull()
    wrapper.unmount()
  })

  it('takes leaving before then for leaving, not for a hang', async () => {
    const wrapper = await mountPlaying('builtin:other')
    wrapper.unmount()
    expect(localStorage.getItem(STARTING)).toBeNull()
  })

  it('gives up on a preset far too slow even at the smallest size, once', async () => {
    const wrapper = await mountPlaying('builtin:other')
    scaleState.overloaded = true
    await frames()
    await frames()
    expect(wrapper.emitted('too-heavy')).toEqual([['builtin:other']])
    expect(JSON.parse(localStorage.getItem(TOO_HEAVY)!)).toEqual(['builtin:other'])
    expect(label(wrapper)).toContain('Other')
    wrapper.unmount()
  })

  it('gives up on the preset the context was lost under', async () => {
    const wrapper = await mountPlaying('builtin:other')
    wrapper.get('canvas').element.dispatchEvent(new Event('webglcontextlost'))
    expect(wrapper.emitted('too-heavy')).toEqual([['builtin:other']])
    expect(JSON.parse(localStorage.getItem(TOO_HEAVY)!)).toEqual(['builtin:other'])
    wrapper.unmount()
  })
})

describe('MilkdropVisualizer shaders', () => {
  beforeEach(() => {
    vi.stubGlobal('OfflineAudioContext', class {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    loadPreset.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps a preset's loops from being unrolled (see services/milkdrop/loops.ts)", async () => {
    const wrapper = mount(MilkdropVisualizer, {
      props: { playing: true, preset: 'builtin:loops', waveform: () => null },
    })
    await flushPromises()
    expect(loadPreset.mock.calls.at(-1)![0].comp).toContain('BEACON_ZERO')
    wrapper.unmount()
  })
})

describe('MilkdropVisualizer switching presets', () => {
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
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const preparing = (wrapper: Awaited<ReturnType<typeof mountPlaying>>) =>
    wrapper.find('.milkdrop__preparing').exists()

  it('says a slow preset is on its way while the last one keeps running', async () => {
    const wrapper = await mountPlaying('builtin:other')
    await frames()
    await wrapper.setProps({ preset: 'builtin:slow' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(preparing(wrapper)).toBe(true)
    expect(wrapper.get('.milkdrop__stage').classes()).toContain('milkdrop__stage--ready')
    slowLoad.release()
    await flushPromises()
    expect(preparing(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('says nothing for a preset that is back in a moment', async () => {
    const wrapper = await mountPlaying('builtin:other')
    await frames()
    await wrapper.setProps({ preset: 'builtin:quick' })
    for (let ms = 0; ms < 200; ms += 20) {
      await vi.advanceTimersByTimeAsync(20)
      expect(preparing(wrapper)).toBe(false)
    }
    wrapper.unmount()
  })
})

describe('MilkdropVisualizer coming back', () => {
  beforeEach(() => {
    vi.stubGlobal('OfflineAudioContext', class {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    // jsdom has no WebGL; a context that is still alive is all parking asks.
    const getContext = HTMLCanvasElement.prototype.getContext
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      type: string,
    ) {
      if (type !== 'webgl2') return getContext.call(this, type)
      return { isContextLost: () => false, getExtension: () => null }
    } as typeof getContext)
    // Whatever an earlier test left parked.
    unpark(null)
    createVisualizer.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('takes up the visualizer it left, with what it compiled', async () => {
    const first = await mountPlaying('builtin:other')
    const canvas = first.get('canvas').element
    first.unmount()
    const second = await mountPlaying('builtin:other')
    expect(createVisualizer).toHaveBeenCalledTimes(1)
    expect(second.get('canvas').element).toBe(canvas)
    second.unmount()
  })

  it('starts afresh when the parked one would need another audio context', async () => {
    const analyser = (context: object) => () => ({ context }) as unknown as AnalyserNode
    const props = { playing: true, preset: 'builtin:other' }
    const first = mount(MilkdropVisualizer, { props: { ...props, analyser: analyser({}) } })
    await flushPromises()
    first.unmount()
    const second = mount(MilkdropVisualizer, { props: { ...props, analyser: analyser({}) } })
    await flushPromises()
    expect(createVisualizer).toHaveBeenCalledTimes(2)
    second.unmount()
  })
})
