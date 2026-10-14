import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { buildCastMixPayload, buildCastQueuePayload } from '../castPayload'
import { useTransitionsStore } from '@/stores/transitions'
import { makeSong } from '@/stores/__tests__/fixtures'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const queue = [
  makeSong('a', { trackNumber: 1 }),
  makeSong('b', { trackNumber: 2, replayGain: { trackGain: -6 } }),
  makeSong('c', { albumId: 'other', trackNumber: 7, discNumber: 2, bpm: 128 }),
]

function queueState(repeatMode: 'off' | 'one' = 'off') {
  return { queue, originalQueue: queue, currentIndex: 0, shuffle: false, repeatMode }
}

describe('cast payloads with transitions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('sends nothing about transitions while they are off', () => {
    expect(buildCastMixPayload({ queue, currentIndex: 0, replayGainMode: 'song' })).toEqual({})
  })

  it('sends the setting and what the mix needs to know about the songs ahead', () => {
    useTransitionsStore().set({ mode: 'gapless' })
    const payload = buildCastMixPayload({ queue, currentIndex: 1, replayGainMode: 'song' })

    expect(payload.transitions).toEqual({
      mode: 'gapless',
      crossfade_seconds: 4,
      beatmix_bars: 8,
    })
    // From the current song on - the ones already played are no use to it.
    expect(Object.keys(payload.song_hints!)).toEqual(['b', 'c'])
    expect(payload.song_hints!.b!.gain).toBeCloseTo(10 ** (-6 / 20))
    expect(payload.song_hints!.c).toEqual({
      gain: 1,
      album_id: 'other',
      disc: 2,
      track: 7,
      bpm: 128,
    })
  })

  it('repeat-one sends the whole queue when the mix loops the song itself', () => {
    expect(buildCastQueuePayload(queueState('one')).fullQueue).toEqual(['a'])
    useTransitionsStore().set({ mode: 'gapless' })
    expect(buildCastQueuePayload(queueState('one')).fullQueue).toEqual(['a', 'b', 'c'])
  })
})
