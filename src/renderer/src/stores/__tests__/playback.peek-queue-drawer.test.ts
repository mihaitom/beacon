import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '../playback'
import { makeSong } from './fixtures'

describe('peekQueueDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the drawer and flags that this call is the one opening it', () => {
    const playback = usePlaybackStore()

    playback.peekQueueDrawer()

    expect(playback.queueDrawerOpen).toBe(true)
    // QueueDrawer.vue's own startReveal() reads this to decide whether to
    // wait out the drawer's opening transition before revealing anything —
    // only relevant the moment it's actually opening from closed.
    expect(playback.queueRevealNeedsOpenDelay).toBe(true)
  })

  it('does not flag an opening delay for a peek while the drawer is already open', () => {
    const playback = usePlaybackStore()
    playback.peekQueueDrawer() // first peek: opens it
    expect(playback.queueRevealNeedsOpenDelay).toBe(true)

    playback.peekQueueDrawer() // second peek: already open, e.g. Play Next mid-browse

    expect(playback.queueDrawerOpen).toBe(true)
    expect(playback.queueRevealNeedsOpenDelay).toBe(false)
  })

  it('bumps queueRevealSeq on every call regardless of whether it was already open', () => {
    const playback = usePlaybackStore()

    playback.peekQueueDrawer()
    expect(playback.queueRevealSeq).toBe(1)

    playback.peekQueueDrawer()
    expect(playback.queueRevealSeq).toBe(2)
  })

  it('flags an opening delay again once the drawer has actually closed in between', () => {
    const playback = usePlaybackStore()
    playback.peekQueueDrawer()
    playback.setQueueDrawerOpen(false)

    playback.peekQueueDrawer()

    expect(playback.queueRevealNeedsOpenDelay).toBe(true)
  })
})

describe('playSongList peeking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('peeks in the same tick as the queue mutation, before awaiting the track start', async () => {
    const playback = usePlaybackStore()
    const songs = [makeSong('a'), makeSong('b')]
    // Whatever the state of the queue reveal is by the time the track
    // actually starts is too late to matter — this captures it at the one
    // moment that decides whether the drawer can still animate anything.
    let seqWhenStartCurrentRan = -1
    let revealedWhenStartCurrentRan: unknown = null
    vi.spyOn(playback, 'startCurrent').mockImplementation(async () => {
      seqWhenStartCurrentRan = playback.queueRevealSeq
      revealedWhenStartCurrentRan = playback.queueRevealSongs
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
    vi.spyOn(playback, 'startCurrent').mockResolvedValue(true)

    await playback.playSongList([makeSong('a')], 0)

    expect(playback.queueDrawerOpen).toBe(false)
    expect(playback.queueRevealSeq).toBe(0)
  })
})
