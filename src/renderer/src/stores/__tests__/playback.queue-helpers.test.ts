import { describe, expect, it } from 'vitest'
import { dedupeForQueue, shuffledExcept } from '../playback'
import { makeSong } from './fixtures'

describe('dedupeForQueue', () => {
  it('passes through distinct songs by reference, unchanged', () => {
    const a = makeSong('a')
    const b = makeSong('b')

    const result = dedupeForQueue([a, b], [])

    expect(result[0]).toBe(a)
    expect(result[1]).toBe(b)
  })

  it('clones a song object that repeats within the same batch, so two queue slots never share one object identity', () => {
    const a = makeSong('a')

    const [first, second] = dedupeForQueue([a, a], [])

    expect(first).toBe(a)
    expect(second).not.toBe(a)
    expect(second).toEqual(a) // same song id/data, just a distinct object
  })

  it('clones a song that already sits in the existing queue', () => {
    const existing = makeSong('a')

    const [added] = dedupeForQueue([existing], [existing])

    expect(added).not.toBe(existing)
    expect(added).toEqual(existing)
  })
})

describe('shuffledExcept', () => {
  it('keeps the pinned song first and shuffles the rest', () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')]

    const result = shuffledExcept(songs, songs[0])

    expect(result[0]).toBe(songs[0])
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('removes only the single pinned instance, not every song sharing its id', () => {
    const a1 = makeSong('a')
    const a2 = makeSong('a')
    const songs = [a1, a2, makeSong('b')]

    const result = shuffledExcept(songs, a1)

    expect(result).toHaveLength(3)
    expect(result[0]).toBe(a1)
    // The second "a" instance must still be present — a naive filter by id
    // would have dropped it too and silently shrunk the queue.
    expect(result.filter((s) => s.id === 'a')).toHaveLength(2)
  })

  it('shuffles the whole list when nothing is pinned', () => {
    const songs = [makeSong('a'), makeSong('b'), makeSong('c')]

    const result = shuffledExcept(songs, null)

    expect(result).toHaveLength(3)
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
  })
})
