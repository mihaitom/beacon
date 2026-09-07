import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useConnectStore } from '../connect'
import { usePlaybackStore } from '../playback'
import { getAudioEngine } from '@/services/audioEngine'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/mediaSession', () => ({ initMediaSession: vi.fn() }))
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
  fetchRadioTitleHistory: vi.fn().mockResolvedValue({ url: null, history: [] }),
  RADIO_TITLE_PAGE_SIZE: 200,
}))

/** Stands in for App.vue: the real init() call site is a created() hook, and
 * that is the whole point of this file — a subscription opened from there
 * belongs to this component instance unless it says otherwise. */
const AppLike = defineComponent({
  template: '<div />',
  created() {
    usePlaybackStore().init()
  },
})

function castingStatus(index: number, elapsed: number) {
  return makeStatus({
    targets: [{ name: 'room A', type: 'sonos' }],
    streaming: true,
    current_song_index: index,
    elapsed,
  })
}

describe('the connect status subscription', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getAudioEngine).mockReturnValue({
      setVolume: vi.fn(),
      play: vi.fn(),
      playLive: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      setReplayGain: vi.fn(),
    } as unknown as ReturnType<typeof getAudioEngine>)
  })

  // The bug this pins: without detached, Pinia dropped this subscription
  // with the component instance that happened to call init(), and init()'s
  // `initialized` guard meant nothing ever set it up again. The backend kept
  // the cast playing and advancing while the app stayed on the track it was
  // showing when the instance went away — reported live 2026-09-07.
  it('keeps following the backend after the component that called init() is gone', async () => {
    const app = mount(AppLike)
    const playback = usePlaybackStore()
    const connect = useConnectStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)

    app.unmount()
    connect.status = castingStatus(2, 42)
    await Promise.resolve()

    expect(playback.localPosition).toBe(42)
    expect(playback.isPlaying).toBe(true)
  })
})
