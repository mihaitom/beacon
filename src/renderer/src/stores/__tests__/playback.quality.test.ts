import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '../playback'
import { BITRATES } from '@/services/streamQuality'
import { makeSong } from './fixtures'

/** The quality settings as the store exposes them. The cast half is the
 * subtle one: it is a *ceiling*, and connect reads "both fields absent" as
 * "no ceiling" (see resolve_output_format()). Sending the fields with a
 * placeholder value instead of omitting them would cap every cast at
 * whatever that placeholder happened to be. */
describe('playbackStore quality settings', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('starts out asking for untouched audio on both paths', () => {
    const playback = usePlaybackStore()

    expect(playback.localQuality.format).toBe('original')
    expect(playback.castQuality.format).toBe('original')
  })

  it('sends no ceiling to connect while casting is set to original', () => {
    const playback = usePlaybackStore()

    expect(playback.castQualityPayload).toEqual({})
  })

  it('sends both halves of the ceiling once one is set', () => {
    const playback = usePlaybackStore()

    playback.setCastQuality('mp3', 320)

    expect(playback.castQualityPayload).toEqual({
      max_lossy_format: 'mp3',
      max_lossy_bitrate_kbps: 320,
    })
  })

  it('keeps a compatible bitrate when only the format changes', () => {
    const playback = usePlaybackStore()

    playback.setLocalQuality('mp3', 192)
    playback.setLocalQuality('aac')

    expect(playback.localQuality).toEqual({ format: 'aac', bitrate: 192 })
  })

  it('corrects a bitrate the new format does not offer', () => {
    const playback = usePlaybackStore()

    playback.setLocalQuality('mp3', 320)
    playback.setLocalQuality('opus')

    expect(playback.localQuality.format).toBe('opus')
    expect(BITRATES.opus).toContain(playback.localQuality.bitrate)
  })

  describe('what is actually loaded', () => {
    it('records nothing until a stream has been built', () => {
      expect(usePlaybackStore().activeLocalStream).toBeNull()
    })

    it('does not change what is loaded when the setting changes', () => {
      // The running <audio> element is already fetching a URL that encodes
      // the old choice; the new one applies at the next song start. The
      // stream-info panel reads this, so the two must not move together.
      const playback = usePlaybackStore()
      playback.activeLocalStream = { quality: { format: 'original', bitrate: 192 }, reason: null }

      playback.setLocalQuality('mp3', 320)

      expect(playback.localQuality).toEqual({ format: 'mp3', bitrate: 320 })
      expect(playback.activeLocalStream).toEqual({
        quality: { format: 'original', bitrate: 192 },
        reason: null,
      })
    })

    it('records the conversion it decided on when the URL is built', () => {
      const playback = usePlaybackStore()
      playback.setLocalQuality('mp3', 128)

      playback.localStreamUrl(makeSong('song-1', { format: 'flac', bitRate: 900 }))

      expect(playback.activeLocalStream).toEqual({
        quality: { format: 'mp3', bitrate: 128 },
        reason: 'quality_limit',
      })
    })

    it('records untouched playback for a track already under the ceiling', () => {
      // The case that made this whole distinction necessary: a 128 kbps
      // MP3 under an "MP3 320" setting is fetched as-is, so the panel has
      // to say so rather than echoing the setting.
      const playback = usePlaybackStore()
      playback.setLocalQuality('mp3', 320)

      const url = playback.localStreamUrl(makeSong('song-1', { format: 'mp3', bitRate: 128 }))

      expect(playback.activeLocalStream).toEqual({
        quality: { format: 'original', bitrate: 0 },
        reason: null,
      })
      expect(url).toContain('/rest/stream.view')
      expect(url).not.toContain('/stream/local/')
    })
  })

  it('persists a change so it survives a reload', () => {
    usePlaybackStore().setLocalQuality('mp3', 128)

    // A fresh store, as if the app had just started again.
    setActivePinia(createPinia())
    expect(usePlaybackStore().localQuality).toEqual({ format: 'mp3', bitrate: 128 })
  })

  it('keeps the two settings independent', () => {
    const playback = usePlaybackStore()

    playback.setLocalQuality('opus', 96)

    expect(playback.castQuality.format).toBe('original')
    expect(playback.castQualityPayload).toEqual({})
  })

  it('survives a logout, unlike the queue snapshot', () => {
    // The quality preference belongs to the device, not the account — it
    // lives under its own key precisely so clearPersistedPlayback() doesn't
    // take it with the queue.
    usePlaybackStore().setLocalQuality('aac', 128)
    localStorage.removeItem('beacon.playback')

    setActivePinia(createPinia())
    expect(usePlaybackStore().localQuality).toEqual({ format: 'aac', bitrate: 128 })
  })
})
