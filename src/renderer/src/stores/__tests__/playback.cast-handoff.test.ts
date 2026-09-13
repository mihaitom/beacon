import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { useRadioSettingsStore } from '../radioSettings'
import { getAudioEngine } from '@/services/audioEngine'
import * as connectPlayback from '@/services/connect/playback'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { ConnectStatus } from '@/services/connect/types'
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

vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return { ...actual, play: vi.fn(), playUrl: vi.fn(), pause: vi.fn() }
})

const kitchen = { name: 'Kitchen', type: 'sonos' as const }

let engine: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }

/** castTo() is the handoff from this device's own speakers to a cast
 * target: it stops the local element, sends the queue and position over,
 * and has to keep a paused session paused. None of these cast protocols
 * has a "load without playing" of its own, so for a song that is a
 * reservation the backend makes on its behalf (`paused: true` — the track
 * is loaded and the speaker claimed, and the next /resume starts it); for
 * radio it is still a dispatch followed by a real /pause, since whether a
 * station plays on a given device is only found out by trying and the
 * automatic fall back to re-encoding it is part of that attempt. */
describe('castTo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    engine = { play: vi.fn(), pause: vi.fn() }
    vi.mocked(getAudioEngine).mockReturnValue(
      engine as unknown as ReturnType<typeof getAudioEngine>,
    )
    vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'playing' })
    vi.mocked(connectPlayback.playUrl).mockResolvedValue({ status: 'playing' })
    vi.mocked(connectPlayback.pause).mockResolvedValue(undefined)
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
      scrobble: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubsonicClient)
  })

  it('sends the song, the queue around it and the position it had reached', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)
    playback.localPosition = 42
    playback.isPlaying = true

    await playback.castTo([kitchen])

    expect(connectPlayback.play).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({
        targets: [kitchen],
        startPosition: 42,
        fullQueue: ['a', 'b'],
        queueIndex: 1,
        force: false,
        paused: false,
      }),
    )
    expect(playback.isPlaying).toBe(true)
  })

  /** The handoff is a dispatch like any other and has to carry the same
   * ceiling. Without it the track already playing went to the speaker
   * untouched however the cast quality was set, and the setting only
   * appeared to take hold from the *next* track on - the one that goes
   * through startCurrent(), which always sent it. Reported live
   * 2026-09-06: switching to a speaker mid-song, and the stream panel
   * saying nothing was being converted. */
  it('takes the cast quality ceiling with it, not just from the next track on', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true
    playback.setCastQuality('aac', 192)

    await playback.castTo([kitchen])

    expect(connectPlayback.play).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ max_lossy_format: 'aac', max_lossy_bitrate_kbps: 192 }),
    )
  })

  it('silences this device, so the song is not audible in two places at once', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true

    await playback.castTo([kitchen])

    expect(engine.pause).toHaveBeenCalledOnce()
  })

  it('reserves the speaker instead of playing when the player was paused', async () => {
    // Without keeping it paused at all, picking a speaker silently resumed
    // playback the user had deliberately stopped. Doing it by dispatching
    // and then pausing, which is how that was fixed first, is a moment of
    // the song out loud on the speaker just picked, plus a stream
    // connection the following /resume throws away.
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = false
    vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'paused' })

    await playback.castTo([kitchen])

    expect(connectPlayback.play).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ paused: true }),
    )
    expect(connectPlayback.pause).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(false)
    // Nothing was playing here, so there was nothing to silence either.
    expect(engine.pause).not.toHaveBeenCalled()
  })

  it('claims nothing about the state when another client won the dispatch', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true
    vi.mocked(connectPlayback.play).mockResolvedValue({ status: 'superseded' })

    await playback.castTo([kitchen])

    // No pause() either: it would be pausing whatever that other client
    // just started.
    expect(connectPlayback.pause).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(true)
  })

  it('hands a radio station over as its raw stream URL', async () => {
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.isPlaying = true

    await playback.castTo([kitchen])

    expect(connectPlayback.playUrl).toHaveBeenCalledWith(
      'https://stream.example/chill',
      'Chill FM',
      expect.objectContaining({ targets: [kitchen], force: false }),
    )
    expect(connectPlayback.play).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(true)
  })

  it('passes the radio-cast-directly setting through on a handoff', async () => {
    useRadioSettingsStore().setCastDirectly(true)
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.isPlaying = true

    await playback.castTo([kitchen])

    expect(connectPlayback.playUrl).toHaveBeenCalledWith(
      'https://stream.example/chill',
      'Chill FM',
      expect.objectContaining({ castDirectly: true }),
    )
  })

  it('keeps a paused radio handoff paused too', async () => {
    const playback = usePlaybackStore()
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    playback.isPlaying = false

    await playback.castTo([kitchen])

    expect(connectPlayback.pause).toHaveBeenCalledOnce()
    expect(playback.isPlaying).toBe(false)
  })

  it('takes the device over straight away when the user already said to', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)

    await playback.castTo([kitchen], true)

    expect(connectPlayback.play).toHaveBeenCalledWith('a', expect.objectContaining({ force: true }))
  })

  it('drops a pending offer to resume, since this dispatch supersedes it', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.castInterrupted = true

    await playback.castTo([kitchen])

    expect(playback.castInterrupted).toBe(false)
  })

  it('just claims the devices when there is nothing loaded to hand over', async () => {
    const playback = usePlaybackStore()
    const claim = vi.spyOn(useConnectStore(), 'claimDevices').mockResolvedValue(true)

    await playback.castTo([kitchen])

    expect(claim).toHaveBeenCalledWith([kitchen])
    expect(connectPlayback.play).not.toHaveBeenCalled()
    expect(connectPlayback.playUrl).not.toHaveBeenCalled()
  })
})

/** The same handoff arriving from the other side: another client sharing
 * this connect session started casting, and all this one ever learns about
 * it is a status tick. Its own `<audio>` element is still playing, and
 * nothing in the UI can reach it once isCasting turns true — every engine
 * callback goes quiet then, pause() addresses the cast, and a station would
 * simply have run on forever. See yieldToCastPlayback(). */
describe('a cast started by another client in the session', () => {
  let engine: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    engine = {
      setVolume: vi.fn(),
      setReplayGain: vi.fn(),
      play: vi.fn(),
      playFrom: vi.fn(),
      playLive: vi.fn(),
      load: vi.fn(),
      loadFrom: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
    }
    vi.mocked(getAudioEngine).mockReturnValue(
      engine as unknown as ReturnType<typeof getAudioEngine>,
    )
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
      scrobble: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubsonicClient)
  })

  /** The session as this client finds it before anyone casts: init() done,
   * status ticks arriving, no targets. Both halves matter and neither is
   * shared setup, because the false→true transition *is* the subject here —
   * and the detector behind it lives at module scope, so it carries over
   * between tests in this file (see castingActiveEdge in playback.ts).
   * Local playback is started *after* this, so nothing the resume decision
   * does (see decideLocalResume(), which this first tick settles) can be
   * mistaken for what joining the cast did. */
  async function aSessionNobodyIsCastingIn(): Promise<void> {
    usePlaybackStore().init()
    useConnectStore().status = makeStatus()
    await Promise.resolve()
  }

  /** A tick reporting a live cast, with nothing of its own for this client
   * to adopt — the queue/station half of joining is reconcileFromStatus()'s
   * and is tested in playback.reconcile.test.ts. What matters here is what
   * happens to the local element. */
  function castTick(overrides: Partial<ConnectStatus> = {}): ConnectStatus {
    return makeStatus({ targets: [kitchen], streaming: true, ...overrides })
  }

  it("silences the song still playing out of this device's own speakers", async () => {
    await aSessionNobodyIsCastingIn()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    playback.isPlaying = true

    useConnectStore().status = castTick()
    await Promise.resolve()

    expect(engine.stop).toHaveBeenCalled()
  })

  /** stop(), not pause(): a paused element holds its connection open, and
   * for a relayed station that connection is a subscriber to the session's
   * one relay — an element still retrying /stream/radio-local would restart
   * that relay on its own station and cut the cast device off (see
   * start_radio_relay() in core/session.py). */
  it('lets go of a station playing locally rather than just pausing it', async () => {
    await aSessionNobodyIsCastingIn()
    const playback = usePlaybackStore()
    playback.radioStation = { id: 's', name: 'Station', streamUrl: 'http://station/live' } as never
    playback.startLocalRadio('http://station/live')
    playback.isPlaying = true

    // The same station, dispatched to the speaker from the other client, so
    // this tick carries no station change for reconcileFromStatus() to adopt.
    useConnectStore().status = castTick({
      radio: { url: 'http://station/live', title: null } as never,
    })
    await Promise.resolve()

    expect(engine.stop).toHaveBeenCalled()
    expect(engine.pause).not.toHaveBeenCalled()
  })

  it('stays silent when the session it joined was dispatched paused', async () => {
    await aSessionNobodyIsCastingIn()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true

    useConnectStore().status = castTick({ paused: true })
    await Promise.resolve()

    expect(engine.stop).toHaveBeenCalled()
    expect(engine.resume).not.toHaveBeenCalled()
    expect(engine.play).not.toHaveBeenCalled()
    expect(playback.isPlaying).toBe(false)
  })

  it('drops what was buffered locally, and the offer to reconnect a station', async () => {
    await aSessionNobodyIsCastingIn()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.bufferedPosition = 90
    playback.radioConnectionLost = true

    useConnectStore().status = castTick()
    await Promise.resolve()

    expect(playback.bufferedPosition).toBe(0)
    expect(playback.radioConnectionLost).toBe(false)
  })
})
