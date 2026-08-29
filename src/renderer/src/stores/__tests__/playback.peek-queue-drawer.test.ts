import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '../playback'
import { useDrawersStore } from '../drawers'
import { useAutoplayStore } from '../autoplay'
import { useLibraryStore } from '../library'
import { makeSong } from './fixtures'

// That the playback store drives the queue drawer at the right moment. The
// drawer's own behaviour is covered in drawers.test.ts.

describe('playSongList peeking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('peeks in the same tick as the queue mutation, before awaiting the track start', async () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    const songs = [makeSong('a'), makeSong('b')]
    // Whatever the state of the queue reveal is by the time the track
    // actually starts is too late to matter — this captures it at the one
    // moment that decides whether the drawer can still animate anything.
    let seqWhenStartCurrentRan = -1
    let revealedWhenStartCurrentRan: unknown = null
    vi.spyOn(playback, 'startCurrent').mockImplementation(async () => {
      seqWhenStartCurrentRan = drawers.queueRevealSeq
      revealedWhenStartCurrentRan = drawers.queueRevealSongs
      return true
    })

    await playback.playSongList(songs, 0, true, true)

    // The regression (reported live 2026-08-26 as Song Radio animating the
    // queue in the first time and never again): peeking only after this
    // await let Vue render and fully animate the new rows on the mutation
    // alone, behind a drawer that was still shut — so the peek that
    // followed had nothing left to reveal.
    expect(seqWhenStartCurrentRan).toBe(1)
    expect(revealedWhenStartCurrentRan).toEqual(songs)
  })

  it('leaves the drawer alone for a direct pick, which is the default', async () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    vi.spyOn(playback, 'startCurrent').mockResolvedValue(true)

    await playback.playSongList([makeSong('a')], 0)

    expect(drawers.queueDrawerOpen).toBe(false)
    expect(drawers.queueRevealSeq).toBe(0)
  })
})

// Every caller that adds to the existing queue (rather than replacing it)
// funnels through one of these two — a song's context menu, the mobile
// action sheet, remote-control commands, and maybeAutoplay()'s own top-up
// below. Both already peeked unconditionally, on every call, well before
// this rule was ever stated explicitly (see their own comments) — reached
// zero direct coverage until now regardless.
describe('addToQueue / queueNext peeking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('addToQueue always peeks, revealing just the songs it appended', () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    const existing = makeSong('a')
    playback.setQueue([existing], 0)
    const [b, c] = [makeSong('b'), makeSong('c')]

    playback.addToQueue([b, c])

    expect(playback.queue).toEqual([existing, b, c])
    expect(drawers.queueDrawerOpen).toBe(true)
    expect(drawers.queueRevealSongs).toEqual([b, c])
    expect(drawers.queueRevealSeq).toBe(1)
  })

  it('queueNext always peeks, revealing just the songs it inserted', () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    const [a, z] = [makeSong('a'), makeSong('z')]
    playback.setQueue([a, z], 0) // z already queued after a — queueNext still inserts right after currentIndex
    const b = makeSong('b')

    playback.queueNext([b])

    expect(playback.queue).toEqual([a, b, z])
    expect(drawers.queueDrawerOpen).toBe(true)
    expect(drawers.queueRevealSongs).toEqual([b])
    expect(drawers.queueRevealSeq).toBe(1)
  })

  it('queueNext falls back to addToQueue (and still peeks) when nothing is playing yet', () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    const song = makeSong('a')

    playback.queueNext([song])

    expect(playback.queue).toEqual([song])
    expect(drawers.queueDrawerOpen).toBe(true)
    expect(drawers.queueRevealSongs).toEqual([song])
  })
})

// This top-up appends rather than replaces, so it was never part of the
// "does the queue-replace peek" sweep (2026-08-26) above — it's routed
// through addToQueue()'s own unconditional peekQueueDrawer(toAdd) instead
// (see that function's comment). Reached zero coverage anywhere in the
// frontend suite until now, despite being exactly the kind of untested
// path this sweep was looking for — added once that gap was pointed out.
describe('maybeAutoplay peeking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('peeks the drawer on the songs it silently adds once the queue is about to run out', async () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    const autoplay = useAutoplayStore()
    const library = useLibraryStore()
    autoplay.enabled = true
    const seed = makeSong('a')
    const [b, c] = [makeSong('b'), makeSong('c')]
    playback.setQueue([seed], 0) // last song already playing — 0 remaining, well past the trigger
    vi.spyOn(library, 'client').mockReturnValue({
      getSimilarSongs2: vi.fn().mockResolvedValue({ songs: [b, c], plexPassRequired: false }),
    } as unknown as ReturnType<typeof library.client>)

    await playback.maybeAutoplay()

    expect(playback.queue).toEqual([seed, b, c])
    expect(drawers.queueDrawerOpen).toBe(true)
    expect(drawers.queueRevealSongs).toEqual([b, c])
    expect(drawers.queueRevealSeq).toBe(1)
  })
})
