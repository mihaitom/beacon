import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { clearPersistedPlayback, usePlaybackStore } from '../playback'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

const PERSIST_KEY = 'beacon.playback'
const SESSION_KEY = 'beacon.playback.session-was-playing'

function persisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}') as Record<string, unknown>
}

/** What the snapshot looked like when it was written — every field
 * restoreFromStorage() reads back, so a test only has to name the ones it
 * is actually about. */
function snapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    queue: [makeSong('a'), makeSong('b')],
    originalQueue: [makeSong('a'), makeSong('b')],
    currentIndex: 1,
    radioStation: null,
    shuffle: false,
    repeatMode: 'off',
    volume: 0.5,
    replayGainMode: 'track',
    localPosition: 42,
    ...overrides,
  })
}

describe('playback persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  describe('persistNow', () => {
    it('writes back everything a reload needs to pick up where it left off', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 1)
      playback.localPosition = 42
      playback.volume = 0.5
      playback.repeatMode = 'all'
      playback.shuffle = true

      playback.persistNow()

      expect(persisted()).toMatchObject({
        currentIndex: 1,
        localPosition: 42,
        volume: 0.5,
        repeatMode: 'all',
        shuffle: true,
      })
      expect((persisted().queue as { id: string }[]).map((s) => s.id)).toEqual(['a', 'b'])
    })

    it('marks the session as playing only for sound actually coming out of this device', () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true

      playback.persistNow()

      expect(sessionStorage.getItem(SESSION_KEY)).toBe('true')
    })

    it('does not mark a session whose sound is coming out of a speaker elsewhere', () => {
      // isPlaying is true while casting too, but this device's own <audio>
      // element is silent — resuming it on a reload would start playing the
      // song a second time, out of the wrong speakers.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      playback.isPlaying = true
      useConnectStore().status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })

      playback.persistNow()

      expect(sessionStorage.getItem(SESSION_KEY)).toBe('false')
    })

    it('carries on when storage refuses the write', () => {
      // A full or unavailable localStorage costs resume-on-reload, nothing
      // more — it must not break the playback that is otherwise running.
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      expect(() => playback.persistNow()).not.toThrow()
    })
  })

  describe('restoreFromStorage', () => {
    it('puts the last session back into state without starting any playback', () => {
      localStorage.setItem(PERSIST_KEY, snapshot())
      const playback = usePlaybackStore()

      playback.restoreFromStorage()

      expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b'])
      expect(playback.currentIndex).toBe(1)
      expect(playback.localPosition).toBe(42)
      expect(playback.volume).toBe(0.5)
      expect(playback.replayGainMode).toBe('track')
      expect(playback.isPlaying).toBe(false)
    })

    it('falls back to ReplayGain off for a snapshot written before that setting existed', () => {
      localStorage.setItem(PERSIST_KEY, snapshot({ replayGainMode: undefined }))
      const playback = usePlaybackStore()

      playback.restoreFromStorage()

      expect(playback.replayGainMode).toBe('off')
    })

    it('starts empty when there is nothing stored', () => {
      const playback = usePlaybackStore()

      playback.restoreFromStorage()

      expect(playback.queue).toEqual([])
      expect(playback.currentIndex).toBe(-1)
    })

    it('starts empty rather than throwing on a snapshot it cannot read', () => {
      localStorage.setItem(PERSIST_KEY, '{not json')
      const playback = usePlaybackStore()

      expect(() => playback.restoreFromStorage()).not.toThrow()
      expect(playback.queue).toEqual([])
    })
  })

  describe('clearPersistedPlayback', () => {
    it('drops the snapshot, so the next account does not inherit the previous queue', () => {
      // Those stream URLs would not even be valid for a different account.
      localStorage.setItem(PERSIST_KEY, snapshot())

      clearPersistedPlayback()

      expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
    })

    it('says nothing when there is no storage to clean up', () => {
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('unavailable')
      })

      expect(() => clearPersistedPlayback()).not.toThrow()
    })
  })
})
