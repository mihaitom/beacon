import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  BITRATES,
  bitrateFor,
  CAST_FORMATS,
  load,
  localFormats,
  plan,
  save,
  type TranscodeFormat,
} from '../streamQuality'

/** The stored quality preferences. Everything worth testing here is what
 * happens to a value that isn't the one this build wrote: an older version's
 * key, a hand-edited localStorage entry, or storage that isn't there at all.
 * All three have the same right answer — fall back to untouched audio, which
 * is never wrong, only possibly larger than the listener wanted. */
describe('streamQuality', () => {
  const KEY = 'beacon.quality'

  beforeEach(() => {
    // load()/save() now go through accountScopedKey() (services/
    // accountKey.ts), which needs an active Pinia to read auth state from
    // — no account is set up here, so it resolves to the plain, unscoped
    // key, same as before this existed.
    setActivePinia(createPinia())
    localStorage.clear()
    vi.restoreAllMocks()
  })

  describe('load', () => {
    it('defaults to untouched audio on both paths', () => {
      const settings = load()

      expect(settings.local.format).toBe('original')
      expect(settings.cast.format).toBe('original')
    })

    it('reads back what save() wrote', () => {
      save({ local: { format: 'opus', bitrate: 96 }, cast: { format: 'mp3', bitrate: 320 } })

      expect(load()).toEqual({
        local: { format: 'opus', bitrate: 96 },
        cast: { format: 'mp3', bitrate: 320 },
      })
    })

    it('rejects a format this build has no encoder for', () => {
      localStorage.setItem(KEY, JSON.stringify({ local: { format: 'wma', bitrate: 192 } }))

      expect(load().local.format).toBe('original')
    })

    it('corrects a bitrate the format does not offer', () => {
      // 320 is an mp3 bitrate; aac's list stops at 256. Sending it would be
      // a 400 from connect (see ALLOWED_BITRATES in routes/local_stream.py),
      // i.e. no audio at all.
      localStorage.setItem(KEY, JSON.stringify({ cast: { format: 'aac', bitrate: 320 } }))

      const { cast } = load()
      expect(cast.format).toBe('aac')
      expect(BITRATES.aac).toContain(cast.bitrate)
    })

    it('survives a corrupt entry', () => {
      localStorage.setItem(KEY, 'not json')

      expect(load().local.format).toBe('original')
    })

    it('survives storage being unavailable entirely', () => {
      // Private browsing, or a browser configured to block site data.
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied')
      })

      expect(load().local.format).toBe('original')
    })
  })

  describe('save', () => {
    it('does not throw when storage refuses the write', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota')
      })

      expect(() =>
        save({
          local: { format: 'mp3', bitrate: 192 },
          cast: { format: 'original', bitrate: 192 },
        }),
      ).not.toThrow()
    })
  })

  describe('bitrateFor', () => {
    it('keeps the current bitrate where the new format offers it', () => {
      expect(bitrateFor('aac', 192)).toBe(192)
    })

    it('falls back when it does not', () => {
      // mp3 320 -> aac has to land somewhere; aac has no 320.
      expect(BITRATES.aac).toContain(bitrateFor('aac', 320))
      expect(bitrateFor('aac', 320)).not.toBe(320)
    })

    it('leaves the stored number alone for original, which ignores it', () => {
      expect(bitrateFor('original', 320)).toBe(320)
    })
  })

  describe('plan', () => {
    // The setting is a ceiling, not an instruction. Converting a 128 kbps
    // MP3 to "MP3 320" would re-encode it — losing quality — and produce a
    // *larger* file than the original, i.e. the opposite of what the
    // setting is for.
    const mp3_320 = { format: 'mp3' as const, bitrate: 320 }

    it('leaves a track already under the ceiling alone', () => {
      expect(plan({ format: 'mp3', bitRate: 128 }, mp3_320)).toEqual({
        quality: { format: 'original', bitrate: 0 },
        reason: null,
      })
    })

    it('converts a track above the ceiling', () => {
      expect(plan({ format: 'mp3', bitRate: 320 }, { format: 'mp3', bitrate: 192 })).toEqual({
        quality: { format: 'mp3', bitrate: 192 },
        reason: 'quality_limit',
      })
    })

    it('treats a lossless source as above any ceiling', () => {
      // Whatever number it names — there is no bitrate a FLAC fits under.
      expect(plan({ format: 'flac', bitRate: 900 }, mp3_320).reason).toBe('quality_limit')
      // Even one the server reports no bitrate for at all.
      expect(plan({ format: 'flac', bitRate: null }, mp3_320).reason).toBe('quality_limit')
    })

    it('converts a format no browser decodes, whatever its bitrate', () => {
      // The other half of why local transcoding exists: without this the
      // element plays nothing at all.
      expect(plan({ format: 'ape', bitRate: 64 }, mp3_320).reason).toBe('browser_unsupported')
      expect(plan({ format: 'wma', bitRate: 64 }, mp3_320).reason).toBe('browser_unsupported')
    })

    it('does nothing at all while the setting is original', () => {
      // Not even for a source no browser can decode: asking for the
      // untouched file is an explicit choice, and quietly converting it
      // anyway would make the setting mean something else.
      expect(plan({ format: 'ape', bitRate: 900 }, { format: 'original', bitrate: 0 })).toEqual({
        quality: { format: 'original', bitrate: 0 },
        reason: null,
      })
    })

    it('leaves a lossy source of unknown bitrate alone', () => {
      // Guessing "probably too big" would re-encode an already-small file
      // for nothing — the same rule connect follows for a number it
      // doesn't have.
      expect(plan({ format: 'mp3', bitRate: null }, mp3_320).reason).toBeNull()
    })

    it('leaves an unknown format alone when it is under the ceiling', () => {
      // No suffix at all is not evidence of anything; the bitrate rule
      // still applies.
      expect(plan({ format: null, bitRate: 128 }, mp3_320).reason).toBeNull()
      expect(plan({ format: null, bitRate: 900 }, mp3_320).reason).toBe('quality_limit')
    })

    it('is case-insensitive about the suffix', () => {
      expect(plan({ format: 'FLAC', bitRate: 900 }, mp3_320).reason).toBe('quality_limit')
    })

    it('does not alias the setting object', () => {
      const setting = { format: 'mp3' as const, bitrate: 192 }
      const result = plan({ format: 'flac', bitRate: 900 }, setting)

      setting.bitrate = 96

      expect(result.quality.bitrate).toBe(192)
    })
  })

  it('offers only mp3 bitrates connect will accept locally', () => {
    // Mirrors ALLOWED_BITRATES in connect/routes/local_stream.py. A value
    // that only exists on this side produces a 400 rather than audio, so
    // the two lists have to stay in step.
    expect(BITRATES.mp3).toEqual([320, 256, 192, 128, 96])
  })

  describe('what the browser can decode', () => {
    function browserPlays(...types: string[]) {
      vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
        types.some((t) => type.startsWith(t)) ? 'probably' : '',
      )
    }

    it('converts a source this browser has no decoder for', () => {
      // Safari plays no Ogg at all, so a Vorbis track there has to be
      // converted however small it is - fetching it untouched plays
      // nothing, which is the case local transcoding exists for.
      browserPlays('audio/mpeg', 'audio/aac')

      expect(plan({ format: 'ogg', bitRate: 96 }, { format: 'aac', bitrate: 192 })).toEqual({
        quality: { format: 'aac', bitrate: 192 },
        reason: 'browser_unsupported',
      })
    })

    it('leaves the same source alone in a browser that does play it', () => {
      browserPlays('audio/mpeg', 'audio/aac', 'audio/ogg')

      expect(plan({ format: 'ogg', bitRate: 96 }, { format: 'aac', bitrate: 192 }).reason).toBe(
        null,
      )
    })

    it('trusts the old fixed list where the browser answers nothing', () => {
      // jsdom says nothing to anything; treating that as "plays nothing"
      // would convert every track on every device.
      browserPlays()

      expect(plan({ format: 'ogg', bitRate: 96 }, { format: 'aac', bitrate: 192 }).reason).toBe(
        null,
      )
    })
  })

  describe('format lists', () => {
    /** What a browser answers for a media type. jsdom's own canPlayType()
     * says nothing to anything, which is indistinguishable from a browser
     * that plays no music at all - so localFormats() treats an empty
     * answer *for mp3* as "this browser cannot be asked" and offers
     * everything. These tests supply real answers instead. */
    function browserPlays(...types: string[]) {
      vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
        types.some((t) => type.startsWith(t)) ? 'probably' : '',
      )
    }

    it('offers untouched audio and all three transcodes locally', () => {
      // aac and opus were both excluded for as long as seeking meant
      // declaring a length of bitrate x duration and letting the element
      // seek against it - an encode is only that size when the music
      // happens to need the bits, which only mp3's padded CBR guarantees.
      // Beacon does the seeking itself now (startLocalSong()), so nothing
      // depends on the bitrate being met.
      browserPlays('audio/mpeg', 'audio/aac', 'audio/ogg')

      expect(localFormats()).toEqual(['original', 'mp3', 'aac', 'opus'])
    })

    it('leaves out a format this browser cannot decode', () => {
      // Safari has no Ogg demuxer, so offering Opus there would be
      // offering silence.
      browserPlays('audio/mpeg', 'audio/aac')

      expect(localFormats()).toEqual(['original', 'mp3', 'aac'])
    })

    it('offers everything where the browser answers nothing at all', () => {
      // An empty answer for mp3 means the answer is worthless, not that
      // this browser plays no music - the old behaviour is the safe one.
      browserPlays()

      expect(localFormats()).toEqual(['original', 'mp3', 'aac', 'opus'])
    })

    it('replaces a stored format this browser cannot play', () => {
      // The same account on a desktop and on an iPhone shares nothing but
      // the setting; a saved 'opus' has to land on the next format down
      // rather than on silence - and not on 'original', which would undo
      // the ceiling entirely.
      browserPlays('audio/mpeg', 'audio/aac')
      localStorage.setItem(KEY, JSON.stringify({ local: { format: 'opus', bitrate: 96 } }))

      expect(load().local).toEqual({ format: 'aac', bitrate: 96 })
    })

    it('leaves the cast setting alone, which is not about this browser', () => {
      // What a speaker gets is narrowed by connect against that device's
      // own codecs, not by whatever browser happens to be open.
      browserPlays('audio/mpeg')
      localStorage.setItem(KEY, JSON.stringify({ cast: { format: 'opus', bitrate: 128 } }))

      expect(load().cast).toEqual({ format: 'opus', bitrate: 128 })
    })

    it('offers all three formats for casting', () => {
      // Including opus, which only a Chromecast plays: connect encodes the
      // best format each target actually supports (see _codec_for_ceiling()
      // in core/streamer.py), so this list is a wish rather than a promise
      // about the speaker.
      expect(CAST_FORMATS).toEqual(['original', 'mp3', 'aac', 'opus'])
    })

    it('has a bitrate list for every format either side can offer', () => {
      for (const format of [...localFormats(), ...CAST_FORMATS]) {
        if (format === 'original') continue
        expect(BITRATES[format as TranscodeFormat].length).toBeGreaterThan(0)
      }
    })
  })
})
