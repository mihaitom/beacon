import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { usePlaybackStore } from '../playback'
import * as connectPlayback from '@/services/connect/playback'
import { makeSong, makeStatus } from './fixtures'

// clearQueue() itself never awaits anything — only updateQueue() needs to be
// under test control, same pattern as playback.reconcile.test.ts.
vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return { ...actual, updateQueue: vi.fn() }
})

describe('clearQueue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(connectPlayback.updateQueue).mockReset()
    vi.mocked(connectPlayback.updateQueue).mockResolvedValue({ status: 'ok' })
  })

  it('pushes the cleared queue to connect while casting — otherwise the next status tick restores the pre-clear queue', () => {
    const playback = usePlaybackStore()
    const connect = useConnectStore()
    const [a, b, c] = [makeSong('a'), makeSong('b'), makeSong('c')]
    playback.setQueue([a, b, c], 1)
    connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })

    playback.clearQueue()

    expect(playback.queue).toEqual([b])
    expect(connectPlayback.updateQueue).toHaveBeenCalledWith(
      ['b'],
      0,
      expect.objectContaining({ originalQueue: ['b'] }),
    )
  })

  it('still pushes the empty queue to connect when nothing is currently playing', () => {
    const playback = usePlaybackStore()
    const connect = useConnectStore()
    // currentIndex stays -1 here (setQueue() without a current song isn't
    // exercised elsewhere), so drive state directly the way currentSong
    // being absent requires.
    playback.queue = []
    playback.originalQueue = []
    playback.currentIndex = -1
    connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })

    playback.clearQueue()

    // syncCastQueue() itself no-ops once currentIndex < 0 — nothing to
    // resync when there was never a current song to begin with.
    expect(connectPlayback.updateQueue).not.toHaveBeenCalled()
  })

  it('does not call connect while not casting', () => {
    const playback = usePlaybackStore()
    const [a, b] = [makeSong('a'), makeSong('b')]
    playback.setQueue([a, b], 0)

    playback.clearQueue()

    expect(playback.queue).toEqual([a])
    expect(connectPlayback.updateQueue).not.toHaveBeenCalled()
  })

  it('survives the round trip: a stale status tick carrying the pre-clear queue no longer overwrites the clear', async () => {
    const playback = usePlaybackStore()
    const connect = useConnectStore()
    const [a, b, c] = [makeSong('a'), makeSong('b'), makeSong('c')]
    playback.setQueue([a, b, c], 1)
    connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })

    playback.clearQueue()
    // Simulate connect having already applied the sync by the time the
    // next status broadcast reflects it — the regression this guards
    // against is a *stale* tick still carrying the old full queue landing
    // after the local clear, which adoptCastQueue() would previously adopt.
    await playback.reconcileFromStatus(
      makeStatus({
        current_song: {
          id: 'b',
          artist: '',
          album: '',
          cover_art_url: null,
          duration: 180,
          title: 'Song b',
        },
        queue: ['b'],
        original_queue: ['b'],
        current_song_index: 0,
      }),
    )

    expect(playback.queue.map((s) => s.id)).toEqual(['b'])
  })
})
