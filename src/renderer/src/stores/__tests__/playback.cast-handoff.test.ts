import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
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
 * and has to keep a paused session paused (connect's /play always starts
 * the device playing — there is no "load paused" for these protocols). */
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

  it('pauses the device right back when the handoff came from a paused player', async () => {
    // Without this, picking a speaker while paused silently resumed
    // playback the user had deliberately stopped.
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = false

    await playback.castTo([kitchen])

    expect(connectPlayback.pause).toHaveBeenCalledOnce()
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
    const claim = vi.spyOn(useConnectStore(), 'claimDevices').mockResolvedValue(undefined)

    await playback.castTo([kitchen])

    expect(claim).toHaveBeenCalledWith([kitchen])
    expect(connectPlayback.play).not.toHaveBeenCalled()
    expect(connectPlayback.playUrl).not.toHaveBeenCalled()
  })
})
