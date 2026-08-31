import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '../playback'
import { useLibraryStore } from '../library'
import { getAudioEngine } from '@/services/audioEngine'
import * as radioMetadata from '@/services/connect/radioMetadata'
import { makeSong } from './fixtures'

vi.mock('@/services/audioEngine', () => ({
  getAudioEngine: vi.fn(),
}))
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
}))

// resumeLocalPlayback() tells a reload (sessionStorage survives it) apart
// from a genuine app restart (sessionStorage starts empty) via the
// SESSION_WAS_PLAYING_KEY marker restoreFromStorage() reads — see both
// functions' own comments in playback.ts. Setting/clearing that key directly
// is what stands in for "the previous instance, right before this boot" here,
// since jsdom's sessionStorage otherwise behaves just like a real one.
const SESSION_WAS_PLAYING_KEY = 'beacon.playback.session-was-playing'

describe('resumeLocalPlayback', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getAudioEngine).mockReturnValue({
      load: vi.fn(),
      play: vi.fn(),
    } as unknown as ReturnType<typeof getAudioEngine>)
  })

  function setUpSong(playback: ReturnType<typeof usePlaybackStore>) {
    const library = useLibraryStore()
    const song = makeSong('a')
    vi.spyOn(library, 'client').mockReturnValue({
      streamUrl: () => 'http://media/a.flac',
    } as unknown as ReturnType<typeof library.client>)
    playback.setQueue([song], 0)
    playback.localPosition = 42
  }

  it('only loads on a genuine restart — no sessionStorage marker from a previous instance to find', async () => {
    const playback = usePlaybackStore()
    setUpSong(playback)
    playback.restoreFromStorage() // no marker present — this boot reads as a restart

    await playback.resumeLocalPlayback()

    const engine = getAudioEngine()
    expect(engine.load).toHaveBeenCalledWith('http://media/a.flac', 42, expect.any(Number))
    expect(engine.play).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(false)
  })

  it('actually resumes playing on a reload of a session that was already playing', async () => {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, 'true') // the previous instance's own persistNow()
    const playback = usePlaybackStore()
    setUpSong(playback)
    playback.restoreFromStorage() // marker survived the reload — this boot reads as a reload

    await playback.resumeLocalPlayback()

    const engine = getAudioEngine()
    expect(engine.play).toHaveBeenCalledWith('http://media/a.flac', 42, expect.any(Number))
    expect(engine.load).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(true)
  })

  it('does not resume a restored radio station on a restart, and does not even try to reconnect it', async () => {
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: '',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.restoreFromStorage()

    await playback.resumeLocalPlayback()

    const engine = getAudioEngine()
    expect(engine.load).not.toHaveBeenCalled()
    expect(engine.play).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(false)
    expect(radioMetadata.startRadioMetadataWatch).not.toHaveBeenCalled()
  })

  it('reconnects a restored radio station on a reload of a session that was already playing', async () => {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, 'true')
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: '',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.restoreFromStorage()

    await playback.resumeLocalPlayback()

    const engine = getAudioEngine()
    expect(engine.play).toHaveBeenCalledWith('https://stream.example/chill')
    expect(playback.isPlaying).toBe(true)
    // Local playback never otherwise reaches the connect backend at all —
    // see services/connect/radioMetadata.ts's own docstring.
    expect(radioMetadata.startRadioMetadataWatch).toHaveBeenCalledWith(
      'https://stream.example/chill',
    )
  })
})
