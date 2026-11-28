import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAutoplayStore } from '../autoplay'
import { useAudioMuseStore } from '../audiomuse'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { getAudioMuseStatus, sonicMix, sonicPath } from '@/services/connect/audiomuse'
import { clearSkips, noteSkipped, recentSkips } from '@/services/playback/skips'
import { canPathTo } from '@/services/playback/sonicActions'
import { emitter } from '@/emitter'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/audiomuse', () => ({
  getAudioMuseStatus: vi.fn(),
  sonicMix: vi.fn(),
  sonicPath: vi.fn(),
}))

/** AudioMuse-AI in Autoplay and the radios (docs/plans/audiomuse.md):
 * used when it answers, and the media server exactly as before whenever it
 * does not. */

let similar: ReturnType<typeof vi.fn>

function stubMediaServer(songs = [makeSong('m1'), makeSong('m2')]): void {
  similar = vi.fn().mockResolvedValue({ songs, plexPassRequired: false })
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    getSimilarSongs2: similar,
  } as unknown as SubsonicClient)
}

function audiomuseAnswers(): void {
  const store = useAudioMuseStore()
  store.status = { available: true, version: '3.7.4', server: 'Navidrome' }
  store.checkedAt = Date.now()
}

beforeEach(() => {
  vi.useFakeTimers() // the queue peek on a top-up arms a real close timer
  setActivePinia(createPinia())
  vi.restoreAllMocks()
  vi.mocked(sonicMix).mockReset()
  vi.mocked(getAudioMuseStatus).mockReset()
  vi.mocked(getAudioMuseStatus).mockResolvedValue({ available: false, reason: 'not-configured' })
  useAutoplayStore().enabled = true
  clearSkips()
})

afterEach(() => {
  emitter.all.clear()
  vi.useRealTimers()
})

describe('Autoplay with AudioMuse-AI', () => {
  it('blends the last five queued songs, minus the skipped ones', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockResolvedValue([makeSong('x')])
    const playback = usePlaybackStore()
    const queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makeSong(id))
    playback.setQueue(queue, 6)
    noteSkipped('b')

    await playback.maybeAutoplay()

    expect(sonicMix).toHaveBeenCalledWith({
      method: 'blend',
      add: ['c', 'd', 'e', 'f', 'g'].map((id) => ({ id })),
      subtract: [{ id: 'b' }],
      n: 10,
      exclude: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    })
    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'])
    expect(similar).not.toHaveBeenCalled()
  })

  it('never subtracts a song it is also blending', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockResolvedValue([makeSong('x')])
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)
    noteSkipped('a')

    await playback.maybeAutoplay()

    expect(vi.mocked(sonicMix).mock.calls[0]?.[0].subtract).toEqual([])
  })

  it('asks the media server when AudioMuse fails', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockRejectedValue(new Error('503'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalled()
    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b', 'm1', 'm2'])
  })

  it('asks the media server when AudioMuse has nothing new, and does not ask it again', async () => {
    audiomuseAnswers()
    stubMediaServer([])
    vi.mocked(sonicMix).mockResolvedValue([])
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    await playback.maybeAutoplay()
    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalled()
    expect(sonicMix).toHaveBeenCalledTimes(1)
  })

  it('does not wait for AudioMuse when it is not there', async () => {
    stubMediaServer()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    void playback.maybeAutoplay()

    // In the same tick, as before AudioMuse existed.
    expect(similar).toHaveBeenCalledTimes(1)
    expect(sonicMix).not.toHaveBeenCalled()
  })
})

describe('skips', () => {
  // Which song has scrobbled is module-level state in the store, so each
  // test plays a song id of its own (see playback.scrobble.test.ts).
  let current = ''
  let nextId = 0

  function playing(): ReturnType<typeof usePlaybackStore> {
    nextId += 1
    current = `skip-${nextId}`
    const playback = usePlaybackStore()
    playback.setQueue([makeSong(current, { duration: 200 }), makeSong('b')], 0)
    vi.spyOn(playback, 'switchToIndex').mockResolvedValue(undefined)
    return playback
  }

  it('leaving a song with Next before it counted as played is a skip', async () => {
    const playback = playing()
    playback.localPosition = 30

    await playback.playNext()

    expect(recentSkips()).toEqual([current])
  })

  it('a song heard past the scrobble point is not a skip', async () => {
    const playback = playing()
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      scrobble: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubsonicClient)
    playback.localPosition = 150
    playback.checkScrobbleThreshold()

    await playback.playNext()

    expect(recentSkips()).toEqual([])
  })

  it('a song that ended on its own is not a skip', async () => {
    const playback = playing()
    playback.localPosition = 30

    await playback.advanceOnSongEnd()

    expect(recentSkips()).toEqual([])
    expect(playback.switchToIndex).toHaveBeenCalledWith(1, true)
  })
})

describe('the radios with AudioMuse-AI', () => {
  it('Song Radio plays AudioMuse neighbours after the song', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockResolvedValue([makeSong('x'), makeSong('y')])
    const playback = usePlaybackStore()
    const played = vi.spyOn(playback, 'playSongList').mockResolvedValue(undefined)

    await playback.startSongRadio(makeSong('seed'))

    expect(sonicMix).toHaveBeenCalledWith(expect.objectContaining({ method: 'similar' }))
    expect(played.mock.calls[0]?.[0].map((s) => s.id)).toEqual(['seed', 'x', 'y'])
    expect(similar).not.toHaveBeenCalled()
  })

  it('Song Radio asks the media server when AudioMuse fails', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockRejectedValue(new Error('503'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const playback = usePlaybackStore()
    const played = vi.spyOn(playback, 'playSongList').mockResolvedValue(undefined)

    await playback.startSongRadio(makeSong('seed'))

    expect(played.mock.calls[0]?.[0].map((s) => s.id)).toEqual(['seed', 'm1', 'm2'])
  })

  it('Artist Radio blends the artist', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockResolvedValue([makeSong('x')])
    const playback = usePlaybackStore()
    vi.spyOn(playback, 'playSongList').mockResolvedValue(undefined)

    await playback.startArtistRadio({ id: 'artist-9', name: 'Someone' } as never)

    expect(sonicMix).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'blend', add: [{ id: 'artist-9', type: 'artist' }] }),
    )
    expect(similar).not.toHaveBeenCalled()
  })

  it('Discovery Radio has nothing to fall back on and says so', async () => {
    audiomuseAnswers()
    stubMediaServer()
    vi.mocked(sonicMix).mockResolvedValue([])
    const playback = usePlaybackStore()
    vi.spyOn(playback, 'playSongList').mockResolvedValue(undefined)

    await expect(playback.startDiscoveryRadio(makeSong('seed'))).rejects.toThrow()
    expect(similar).not.toHaveBeenCalled()
  })

  it('Discovery Radio asks for the niche around the song', async () => {
    audiomuseAnswers()
    vi.mocked(sonicMix).mockResolvedValue([makeSong('x')])
    const playback = usePlaybackStore()
    const played = vi.spyOn(playback, 'playSongList').mockResolvedValue(undefined)

    await playback.startDiscoveryRadio(makeSong('seed'))
    await flushPromises()

    expect(sonicMix).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'discovery', add: [{ id: 'seed' }] }),
    )
    expect(played.mock.calls[0]?.[0].map((s) => s.id)).toEqual(['seed', 'x'])
  })
})

describe('a path to a song', () => {
  function playingA(): ReturnType<typeof usePlaybackStore> {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('target'), makeSong('c')], 0)
    vi.spyOn(playback, 'syncCastQueue').mockImplementation(() => {})
    return playback
  }

  it('plays the songs leading there right after the current one', async () => {
    const playback = playingA()
    vi.mocked(sonicPath).mockResolvedValue([makeSong('p1'), makeSong('p2'), makeSong('target')])

    await playback.queuePathTo(makeSong('target'))

    expect(sonicPath).toHaveBeenCalledWith('a', 'target')
    // The later copy of the target goes, so it is not heard twice.
    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'p1', 'p2', 'target', 'b', 'c'])
  })

  it('leaves the queue as it was when there is no path', async () => {
    const playback = playingA()
    vi.mocked(sonicPath).mockResolvedValue([])

    await expect(playback.queuePathTo(makeSong('target'))).rejects.toThrow()
    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b', 'target', 'c'])
  })

  it('is offered only for another library song, with AudioMuse there', () => {
    const playback = playingA()
    expect(canPathTo(makeSong('target'))).toBe(false)
    audiomuseAnswers()
    expect(canPathTo(makeSong('target'))).toBe(true)
    expect(canPathTo(makeSong('a'))).toBe(false) // the one playing
    expect(canPathTo(makeSong('ext:folder:1'))).toBe(false)
    playback.setQueue([], -1)
    expect(canPathTo(makeSong('target'))).toBe(false)
  })
})
