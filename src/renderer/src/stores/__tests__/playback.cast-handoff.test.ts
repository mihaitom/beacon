import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { useRadioSettingsStore } from '../radioSettings'
import { getAudioEngine } from '@/services/audioEngine'
import * as connectPlayback from '@/services/connect/playback'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

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
