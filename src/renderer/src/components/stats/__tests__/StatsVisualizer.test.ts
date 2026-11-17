import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getAudioEngine } from '@/services/audioEngine'
import { VisualizerEventSource } from '@/services/connect/visualizer'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { BAR_COUNT } from '@/services/visualizerBands'
import { makeSong, makeStatus } from '@/stores/__tests__/fixtures'
import StatsVisualizer from '../StatsVisualizer.vue'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/visualizer', () => ({
  VisualizerEventSource: vi.fn(function (this: Record<string, unknown>) {
    this.start = vi.fn()
    this.stop = vi.fn()
  }),
}))

const BARS = { template: '<canvas class="bars" />', props: ['active', 'sample'] }
const wrappers: VueWrapper[] = []

function engine(hasAnalyser: boolean, getAnalyser: () => unknown = () => ({})): void {
  vi.mocked(getAudioEngine).mockReturnValue({
    hasAnalyser,
    getAnalyser,
  } as unknown as ReturnType<typeof getAudioEngine>)
}

function reduceMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: reduced }))
}

function show(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(StatsVisualizer, { props, global: { stubs: { VisualizerBars: BARS } } })
  wrappers.push(wrapper)
  return wrapper
}

function cast(): void {
  useConnectStore().status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
  const playback = usePlaybackStore()
  playback.queue = [makeSong('s')]
  playback.currentIndex = 0
}

function eventSource(): { start: () => void; stop: () => void; onFrame: unknown } {
  return vi.mocked(VisualizerEventSource).mock.instances.at(-1) as never
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.mocked(VisualizerEventSource).mockClear()
  reduceMotion(false)
  engine(true)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the Stats display', () => {
  it('stands empty with nothing playing, and draws nothing', () => {
    const wrapper = show()

    expect(wrapper.find('.stats-visualizer').exists()).toBe(true)
    expect(wrapper.find('.bars').exists()).toBe(false)
  })

  it('shows the music of this device while it plays', async () => {
    usePlaybackStore().isPlaying = true
    const wrapper = show()

    await flushPromises()

    expect(wrapper.find('.bars').exists()).toBe(true)
    expect(VisualizerEventSource).not.toHaveBeenCalled()
  })

  it('lets the bars fall before taking them away', async () => {
    const playback = usePlaybackStore()
    playback.isPlaying = true
    const wrapper = show()

    playback.isPlaying = false
    await flushPromises()
    expect(wrapper.findComponent(BARS).props('active')).toBe(false)

    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.find('.bars').exists()).toBe(false)
  })

  it('keeps the bars when the music comes back while they fall', async () => {
    const playback = usePlaybackStore()
    playback.isPlaying = true
    const wrapper = show()

    playback.isPlaying = false
    await flushPromises()
    playback.isPlaying = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.find('.bars').exists()).toBe(true)
  })

  it('reads the frames connect sends while casting', async () => {
    cast()
    const playback = usePlaybackStore()
    playback.isPlaying = true
    const wrapper = show()
    await flushPromises()

    const source = eventSource()
    expect(source.start).toHaveBeenCalled()
    ;(source.onFrame as (frame: { bands: number[] }) => void)({ bands: [0.5, 0.5] })

    const sample = wrapper.findComponent(BARS).props('sample') as () => number[]
    expect(sample()).toHaveLength(BAR_COUNT)
    expect(sample()[0]).toBe(0.5)
  })

  it('closes the connection on pause and on leaving the page', async () => {
    cast()
    const playback = usePlaybackStore()
    playback.isPlaying = true
    const wrapper = show()
    const first = eventSource()

    playback.isPlaying = false
    await flushPromises()
    expect(first.stop).toHaveBeenCalled()

    playback.isPlaying = true
    await flushPromises()
    const second = eventSource()
    expect(second).not.toBe(first)
    wrapper.unmount()
    wrappers.pop()
    expect(second.stop).toHaveBeenCalled()
  })

  it('does not exist on a device that cannot hear itself', () => {
    engine(false)

    expect(show().find('.stats-visualizer').exists()).toBe(false)
  })

  it('does exist there while casting', () => {
    engine(false)
    cast()

    expect(show().find('.stats-visualizer').exists()).toBe(true)
  })

  it('does not exist with reduced motion', () => {
    reduceMotion(true)

    expect(show().find('.stats-visualizer').exists()).toBe(false)
  })

  it('says whether it exists', () => {
    expect(show().emitted('availability')?.at(-1)).toEqual([true])
    engine(false)
    expect(show().emitted('availability')?.at(-1)).toEqual([false])
  })

  it('shows a readout when handed one, and none otherwise', () => {
    expect(show().find('.stats-visualizer__readout').exists()).toBe(false)

    const readout = show({ readout: ['Gold record', '2,500 plays'] }).find(
      '.stats-visualizer__readout',
    )
    expect(readout.text()).toContain('Gold record')
    expect(readout.text()).toContain('2,500 plays')
  })

  it('lets the bars fall while a readout is up and brings them back', async () => {
    cast()
    usePlaybackStore().isPlaying = true
    const wrapper = show()
    await flushPromises()
    ;(eventSource().onFrame as (frame: { bands: number[] }) => void)({ bands: [0.5, 0.5] })
    const sample = wrapper.findComponent(BARS).props('sample') as () => number[] | null

    await wrapper.setProps({ readout: ['Gold record'] })
    expect(sample()).toBeNull()
    expect(wrapper.findComponent(BARS).props('active')).toBe(false)

    await wrapper.setProps({ readout: null })
    expect(sample()?.[0]).toBe(0.5)
    expect(wrapper.findComponent(BARS).props('active')).toBe(true)
  })

  it('survives the analyser failing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    engine(true, () => {
      throw new Error('no context')
    })
    usePlaybackStore().isPlaying = true
    const wrapper = show()
    await flushPromises()

    const sample = wrapper.findComponent(BARS).props('sample') as () => number[] | null
    expect(sample()).toBeNull()
    expect(error).toHaveBeenCalled()
  })
})
