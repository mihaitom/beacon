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
  fetchRadioTitleHistory: vi.fn().mockResolvedValue([]),
  RADIO_TITLE_PAGE_SIZE: 200,
}))

// resumeLocalPlayback() tells a reload apart from a genuine app restart via
// the SESSION_WAS_PLAYING_KEY marker restoreFromStorage() reads — see both
// functions' own comments in playback.ts, and RESUME_WINDOW_MS in
// services/playback/persistence.ts for why the marker carries the moment
// playback was last running rather than a flag. Writing that key directly is
// what stands in for "the previous instance, right before this boot" here,
// since jsdom's sessionStorage otherwise behaves just like a real one.
const SESSION_WAS_PLAYING_KEY = 'beacon.playback.session-was-playing'

/** The marker as the previous instance would have left it moments ago. */
function markedPlaying(agoMs = 0): string {
  return String(Date.now() - agoMs)
}

/** The two arguments playLive() is handed for `streamUrl` in the default
 * (relayed) mode: Beacon's own relay URL with the station's own inside it,
 * and the option that follows from the same decision (see
 * startLocalRadio()). Spread into toHaveBeenCalledWith. Both are pinned in
 * full where they are the subject, in playback.transport.test.ts — here the
 * only question is which station is playing.
 */
function playingStation(streamUrl: string): [unknown, unknown] {
  return [expect.stringContaining(encodeURIComponent(streamUrl)), { holdsConnection: true }]
}

describe('resumeLocalPlayback', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getAudioEngine).mockReturnValue({
      load: vi.fn(),
      play: vi.fn(),
      playLive: vi.fn(),
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
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, markedPlaying()) // the previous instance's own persistNow()
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

  /** The phone case the window exists for: an installed PWA that goes into
   * the background is discarded and restored by the OS, which leaves
   * sessionStorage intact and looks exactly like a reload from in here.
   * Beacon used to start the station again by itself hours later, in a
   * pocket - reported 2026-09-07. */
  it('does not start a station again when the page was restored long after it played', async () => {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, markedPlaying(60 * 60 * 1000))
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: '',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.restoreFromStorage()

    await playback.resumeLocalPlayback()

    expect(getAudioEngine().playLive).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(false)
  })

  it('reconnects a restored radio station on a reload of a session that was already playing', async () => {
    sessionStorage.setItem(SESSION_WAS_PLAYING_KEY, markedPlaying())
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
    expect(engine.playLive).toHaveBeenCalledWith(...playingStation('https://stream.example/chill'))
    expect(playback.isPlaying).toBe(true)
    // No separate now-playing watch: relayed is the default, and the
    // relay reads the station's ICY tag out of the fetch it already
    // holds (see startLocalRadio()). Direct mode is what still needs one
    // — covered by its own test.
    expect(radioMetadata.startRadioMetadataWatch).not.toHaveBeenCalled()
  })
})
