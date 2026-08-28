import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { getAudioEngine } from '@/services/audioEngine'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

/** Which song id has already been registered as played is module-level
 * state in the store (it has to survive across position updates), so every
 * test below plays a song id of its own rather than depending on the order
 * they run in. */
let nextSongId = 0

function uniqueSong(
  overrides: Partial<ReturnType<typeof makeSong>> = {},
): ReturnType<typeof makeSong> {
  nextSongId += 1
  return makeSong(`song-${nextSongId}`, overrides)
}

function stubClient(): { scrobble: ReturnType<typeof vi.fn> } {
  const client = {
    scrobble: vi.fn().mockResolvedValue(undefined),
    streamUrl: vi.fn((id: string) => `https://server.example/stream/${id}`),
  }
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

function submissions(client: { scrobble: ReturnType<typeof vi.fn> }): unknown[][] {
  return client.scrobble.mock.calls.filter((call) => call[1] === true)
}

describe('scrobbling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.mocked(getAudioEngine).mockReturnValue({
      play: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setReplayGain: vi.fn(),
    } as unknown as ReturnType<typeof getAudioEngine>)
  })

  it('says nothing until enough of the song has actually been listened to', () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 200 })], 0)
    playback.localPosition = 99

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(0)
  })

  it('registers the play once past halfway', async () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    const song = uniqueSong({ duration: 200 })
    playback.setQueue([song], 0)
    playback.localPosition = 100

    playback.checkScrobbleThreshold()
    await flushPromises()

    expect(submissions(client)).toEqual([[song.id, true]])
  })

  it('registers a long song after four minutes rather than making it wait for halfway', () => {
    // Subsonic/Last.fm convention: 50% or 4 minutes, whichever comes first.
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 1800 })], 0)
    playback.localPosition = 241

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(1)
  })

  it('counts a play-through once, not on every position update', () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 200 })], 0)
    playback.localPosition = 150

    playback.checkScrobbleThreshold()
    playback.localPosition = 160
    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(1)
  })

  it('counts the same song again when it is played a second time', async () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    const song = uniqueSong({ duration: 200 })
    playback.setQueue([song], 0)
    playback.localPosition = 150
    playback.checkScrobbleThreshold()

    // A fresh start of the same song is a new play-through, not a repeat of
    // the one already counted.
    await playback.startCurrent()
    playback.localPosition = 150
    playback.checkScrobbleThreshold()
    await flushPromises()

    expect(submissions(client)).toHaveLength(2)
  })

  it('shows the higher play count straight away instead of waiting for a reload', async () => {
    // Nothing re-fetches this song object, so the queue, song lists and
    // Stats would all keep showing the old count until something else
    // happened to reload it.
    const playback = usePlaybackStore()
    stubClient()
    const song = uniqueSong({ duration: 200, playCount: 7 })
    playback.setQueue([song], 0)
    playback.localPosition = 150

    playback.checkScrobbleThreshold()
    await flushPromises()

    expect(song.playCount).toBe(8)
  })

  it('leaves the play count alone when the server refused the scrobble', async () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    client.scrobble.mockRejectedValue(new Error('500'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const song = uniqueSong({ duration: 200, playCount: 7 })
    playback.setQueue([song], 0)
    playback.localPosition = 150

    playback.checkScrobbleThreshold()
    await flushPromises()

    expect(song.playCount).toBe(7)
  })

  it('has nothing to register for a radio station', () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 200 })], 0)
    playback.localPosition = 150
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(0)
  })

  it('waits for a real duration rather than guessing at one', () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 0 })], 0)
    playback.localPosition = 150

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(0)
  })

  it('prefers the duration the player measured over the one the server reported', () => {
    // A transcoded stream can run to a different length than the library
    // metadata claims; the element knows what is actually playing.
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.setQueue([uniqueSong({ duration: 1000 })], 0)
    playback.duration = 200
    playback.localPosition = 101

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(1)
  })

  it('has nothing to register with an empty queue', () => {
    const playback = usePlaybackStore()
    const client = stubClient()
    playback.localPosition = 300

    playback.checkScrobbleThreshold()

    expect(submissions(client)).toHaveLength(0)
  })
})
