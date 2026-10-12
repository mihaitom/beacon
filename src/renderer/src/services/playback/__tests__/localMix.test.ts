import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAudioEngine } from '@/services/audioEngine'
import * as client from '@/services/connect/localMix'
import { ConnectApiError } from '@/services/connect/http'
import { prefersHls } from '@/services/streamQuality'
import { makeSong } from '@/stores/__tests__/fixtures'
import { LocalMixPlayer, upcomingSongs } from '../localMix'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/localMix', () => ({
  startLocalMix: vi.fn(),
  updateLocalMixQueue: vi.fn().mockResolvedValue({}),
  pauseLocalMix: vi.fn().mockResolvedValue({}),
  resumeLocalMix: vi.fn().mockResolvedValue({}),
  stopLocalMix: vi.fn().mockResolvedValue({}),
  fetchLocalMixTimeline: vi.fn(),
  localMixAudioUrl: vi.fn(
    (player: string, epoch: string, from: number) => `audio/${player}/${epoch}/${from}`,
  ),
  localMixHlsUrl: vi.fn((player: string, epoch: string) => `hls/${player}/${epoch}`),
}))
vi.mock('@/services/streamQuality', () => ({ prefersHls: vi.fn(() => false) }))

const queue = ['a', 'b', 'c', 'd'].map((id) => makeSong(id))
const quality = { format: 'flac' as const, bitrate: 0 }
const state = (epoch = 'e1', end: number | null = null) => ({
  epoch,
  end,
  timeline: [
    { t: 0, song_id: 'a', queue_index: 0, position: 0, playing: true, rate: 1, start: true },
  ],
})

function engine() {
  const fake = {
    playFrom: vi.fn(),
    loadFrom: vi.fn(),
    play: vi.fn(),
    load: vi.fn(),
    seek: vi.fn(),
    setExpectedDuration: vi.fn(),
  }
  vi.mocked(getAudioEngine).mockReturnValue(fake as never)
  return fake
}

function startOptions(autoplay = true) {
  return {
    songs: upcomingSongs(queue, 0, 'off', 'off'),
    position: 12,
    repeatMode: 'off' as const,
    transitions: { mode: 'gapless', crossfade_seconds: 10 },
    quality,
    autoplay,
  }
}

describe('upcomingSongs', () => {
  it('lists the current song and the ones after it, with their place in the queue', () => {
    const songs = upcomingSongs(queue, 1, 'off', 'off')
    expect(songs.map((s) => [s.id, s.queue_index])).toEqual([
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ])
  })

  it('wraps round under repeat-all', () => {
    expect(
      upcomingSongs(queue, 3, 'all', 'off')
        .map((s) => s.queue_index)
        .slice(0, 3),
    ).toEqual([3, 0, 1])
  })

  it('needs only the current song under repeat-one', () => {
    expect(upcomingSongs(queue, 2, 'one', 'off').map((s) => s.id)).toEqual(['c'])
  })

  it('carries each song its own gain', () => {
    const loud = [makeSong('x', { replayGain: { trackGain: -6 } })]
    expect(upcomingSongs(loud, 0, 'off', 'song')[0]!.gain).toBeCloseTo(0.501, 3)
  })

  it('is empty without a current song', () => {
    expect(upcomingSongs(queue, -1, 'off', 'off')).toEqual([])
  })
})

describe('LocalMixPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('starts the mix and hands its stream to the element from stream time 0', async () => {
    const fake = engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    const mix = new LocalMixPlayer()

    expect(await mix.start(startOptions())).toBe(true)

    expect(client.startLocalMix).toHaveBeenCalledWith(
      mix.player,
      expect.objectContaining({ position: 12, repeat_mode: 'off' }),
    )
    const [urlFor, from, gain, duration] = fake.playFrom.mock.calls[0]!
    expect([from, gain, duration]).toEqual([0, 1, Number.POSITIVE_INFINITY])
    // A reconnect asks for the same run from where the element had got to.
    expect(urlFor(42)).toBe(`audio/${mix.player}/e1/42`)
    expect(mix.active).toBe(true)
    expect(mix.heard(5)).toMatchObject({ songId: 'a', position: 5 })
    mix.stop()
  })

  it('on WebKit, plays the run as a live playlist from its start', async () => {
    vi.mocked(prefersHls).mockReturnValue(true)
    const fake = engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    const mix = new LocalMixPlayer()

    await mix.start(startOptions())

    expect(fake.play).toHaveBeenCalledWith(`hls/${mix.player}/e1`, 0, 1, { hls: true, mix: true })
    expect(fake.seek).toHaveBeenCalledWith(0)
    expect(fake.playFrom).not.toHaveBeenCalled()
    await mix.start(startOptions(false))
    expect(fake.load).toHaveBeenCalledWith(`hls/${mix.player}/e1`, 0, 1, { hls: true, mix: true })
    mix.stop()
    vi.mocked(prefersHls).mockReturnValue(false)
  })

  it('only loads when not asked to play', async () => {
    const fake = engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    const mix = new LocalMixPlayer()
    await mix.start(startOptions(false))
    expect(fake.loadFrom).toHaveBeenCalled()
    expect(fake.playFrom).not.toHaveBeenCalled()
    mix.stop()
  })

  it('a start overtaken by a newer one or a stop changes nothing', async () => {
    const fake = engine()
    let answer!: (value: ReturnType<typeof state>) => void
    vi.mocked(client.startLocalMix).mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const mix = new LocalMixPlayer()
    const started = mix.start(startOptions())
    mix.stop()
    answer(state())
    expect(await started).toBe(false)
    expect(fake.playFrom).not.toHaveBeenCalled()
    expect(mix.active).toBe(false)
  })

  it('tells the element where the mix ends once that is known', async () => {
    vi.useFakeTimers()
    const fake = engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    vi.mocked(client.fetchLocalMixTimeline).mockResolvedValue(state('e1', 400))
    const mix = new LocalMixPlayer()
    await mix.start(startOptions())
    expect(fake.setExpectedDuration).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(fake.setExpectedDuration).toHaveBeenCalledWith(400)
    mix.stop()
  })

  it('reports a mix connect no longer has', async () => {
    vi.useFakeTimers()
    engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    vi.mocked(client.fetchLocalMixTimeline).mockRejectedValue(
      new ConnectApiError('gone', { detail: 'No such mix' }),
    )
    const mix = new LocalMixPlayer()
    const lost = vi.fn()
    mix.onLost = lost
    await mix.start(startOptions())

    await vi.advanceTimersByTimeAsync(2000)

    expect(lost).toHaveBeenCalledOnce()
    expect(mix.active).toBe(false)
  })

  it('pausing freezes the mix and counts how long', async () => {
    engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    const mix = new LocalMixPlayer()
    await mix.start(startOptions())
    mix.pause()
    expect(client.pauseLocalMix).toHaveBeenCalledWith(mix.player)
    expect(mix.pausedFor(Date.now() + 5000)).toBeGreaterThanOrEqual(5000)
    mix.resume()
    expect(client.resumeLocalMix).toHaveBeenCalledWith(mix.player)
    expect(mix.pausedFor()).toBe(0)
    mix.stop()
    expect(client.stopLocalMix).toHaveBeenCalledWith(mix.player)
  })

  it('tells a party which mix it plays and where in it this tab is', async () => {
    engine()
    vi.mocked(client.startLocalMix).mockResolvedValue(state())
    const mix = new LocalMixPlayer()
    expect(mix.partyState()).toBeNull()
    await mix.start(startOptions())
    mix.heard(37.5)
    expect(mix.partyState()).toEqual({ player: mix.player, epoch: 'e1', stream_time: 37.5 })
    mix.stop()
    expect(mix.partyState()).toBeNull()
  })

  it('does nothing about a mix it does not have', () => {
    const mix = new LocalMixPlayer()
    mix.pause()
    mix.syncQueue(upcomingSongs(queue, 0, 'off', 'off'), 'off')
    mix.stop()
    expect(client.pauseLocalMix).not.toHaveBeenCalled()
    expect(client.updateLocalMixQueue).not.toHaveBeenCalled()
    expect(client.stopLocalMix).not.toHaveBeenCalled()
  })
})
