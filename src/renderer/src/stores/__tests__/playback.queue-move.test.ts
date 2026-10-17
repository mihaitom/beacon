import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '../playback'
import { useTransitionsStore } from '../transitions'
import { makeSong } from './fixtures'

function queueOf(ids: string[], current: number) {
  const playback = usePlaybackStore()
  playback.setQueue(
    ids.map((id) => makeSong(id)),
    current,
  )
  return playback
}

const ids = (playback: ReturnType<typeof usePlaybackStore>) => playback.queue.map((s) => s.id)

describe('moveInQueue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('moves a song from far down to right after the current one', () => {
    const playback = queueOf(['a', 'b', 'c', 'd', 'e', 'f'], 1)

    expect(playback.moveInQueue(5, 'next')).toBe(true)

    expect(ids(playback)).toEqual(['a', 'b', 'f', 'c', 'd', 'e'])
    expect(playback.currentIndex).toBe(1)
  })

  it('moves an already played song up to right after the current one', () => {
    const playback = queueOf(['a', 'b', 'c', 'd'], 2)

    playback.moveInQueue(0, 'next')

    expect(ids(playback)).toEqual(['b', 'c', 'a', 'd'])
    expect(playback.queue[playback.currentIndex]!.id).toBe('c')
  })

  it('moves a song to the end', () => {
    const playback = queueOf(['a', 'b', 'c', 'd'], 0)

    playback.moveInQueue(1, 'end')

    expect(ids(playback)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('has nothing to do where the song already is, or for the current song', () => {
    const playback = queueOf(['a', 'b', 'c', 'd'], 1)

    expect(playback.moveInQueue(2, 'next')).toBe(false)
    expect(playback.moveInQueue(3, 'end')).toBe(false)
    expect(playback.moveInQueue(1, 'end')).toBe(false)
    expect(ids(playback)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the first song first when nothing is current yet', () => {
    const playback = queueOf(['a', 'b', 'c'], 0)
    playback.currentIndex = -1

    playback.moveInQueue(2, 'next')

    expect(ids(playback)).toEqual(['c', 'a', 'b'])
  })

  describe('with the next song locked by the mix', () => {
    function locked() {
      const playback = queueOf(['a', 'b', 'c', 'd', 'e'], 0)
      playback.mixNextLocked = true
      expect(playback.lockedNextIndex).toBe(1)
      return playback
    }

    it('"next" lands behind the locked song, which stays next', () => {
      const playback = locked()

      playback.moveInQueue(4, 'next')

      expect(ids(playback)).toEqual(['a', 'b', 'e', 'c', 'd'])
    })

    it('a song already behind the locked one has nothing to do', () => {
      const playback = locked()

      expect(playback.moveInQueue(2, 'next')).toBe(false)
    })

    it('the locked song itself does not move', () => {
      const playback = locked()

      expect(playback.queueMoveTarget(1, 'next')).toBeNull()
      expect(playback.moveInQueue(1, 'end')).toBe(false)
      expect(ids(playback)).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('an already played song moved up lands behind it too', () => {
      const playback = queueOf(['a', 'b', 'c', 'd'], 1)
      playback.mixNextLocked = true

      playback.moveInQueue(0, 'next')

      expect(ids(playback)).toEqual(['b', 'c', 'a', 'd'])
      expect(playback.queue[playback.currentIndex]!.id).toBe('b')
      expect(playback.queue[playback.lockedNextIndex]!.id).toBe('c')
    })
  })
})

describe('sortQueueByBpm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function queueWithBpm(bpms: Record<string, number | null>, current: number) {
    const playback = usePlaybackStore()
    playback.setQueue(
      Object.entries(bpms).map(([id, bpm]) => makeSong(id, { bpm })),
      current,
    )
    return playback
  }

  it('sorts the whole queue, untagged songs last in their order, and follows the current song', () => {
    const playback = queueWithBpm({ a: 140, b: 120, c: null, d: 128, e: 90, f: null }, 1)

    playback.sortQueueByBpm()

    expect(ids(playback)).toEqual(['e', 'b', 'd', 'a', 'c', 'f'])
    expect(playback.queue[playback.currentIndex]!.id).toBe('b')
  })

  /** With shuffle on the queue would look shuffled while being sorted, and
   * the next toggle of shuffle rebuilds it from the original order anyway. */
  it('leaves a shuffled queue alone', () => {
    const playback = queueWithBpm({ a: 140, b: 120, c: 90 }, 0)
    playback.shuffle = true
    const before = ids(playback)

    playback.sortQueueByBpm()

    expect(ids(playback)).toEqual(before)
  })

  it('keeps a locked next song right behind the current one', () => {
    const playback = queueWithBpm({ a: 100, b: 150, c: 130, d: 110 }, 0)
    playback.mixNextLocked = true

    playback.sortQueueByBpm()

    expect(ids(playback)).toEqual(['a', 'b', 'd', 'c'])
    expect(playback.currentIndex).toBe(0)
  })
})

describe('canSortByBpm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function queueTagged(tagged: number, untagged: number) {
    const playback = usePlaybackStore()
    const songs = [
      ...Array.from({ length: tagged }, (_, i) => makeSong(`t${i}`, { bpm: 100 + i })),
      ...Array.from({ length: untagged }, (_, i) => makeSong(`u${i}`, { bpm: null })),
    ]
    playback.setQueue(songs, 0)
    return playback
  }

  it('is offered with DJ mixes on and most of the queue tagged', () => {
    useTransitionsStore().mode = 'crossfade'
    expect(queueTagged(3, 1).canSortByBpm).toBe(true)
  })

  it('is not offered where too little of the queue has a BPM', () => {
    useTransitionsStore().mode = 'crossfade'
    expect(queueTagged(2, 2).canSortByBpm).toBe(false)
  })

  it('is not offered without DJ mixes', () => {
    useTransitionsStore().mode = 'gapless'
    expect(queueTagged(4, 0).canSortByBpm).toBe(false)
  })
})
