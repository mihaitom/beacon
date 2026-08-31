import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import * as localStreamInfo from '@/services/connect/localStreamInfo'
import StreamInfoSection from '../StreamInfoSection.vue'
import { makeStatus } from '@/stores/__tests__/fixtures'
import type { ConnectStreamInfo } from '@/services/connect/types'

const vuetify = createVuetify({ components, directives })

function mountSection() {
  return mount(StreamInfoSection, {
    global: { plugins: [vuetify, i18n] },
  })
}

// A stand-in for a locale that's only been half-translated: the sentence
// exists, the short wording doesn't. Every locale this repo ships has both,
// so the fallback can't be reached with the real i18n instance — hence its
// own mount rather than a parameter on mountSection() above.
function mountSectionWithoutShortWordings() {
  return mount(StreamInfoSection, {
    global: {
      plugins: [
        vuetify,
        createI18n({
          legacy: true,
          globalInjection: true,
          locale: 'en',
          messages: {
            en: {
              connect: {
                streamInfo: {
                  reason: 'Reason',
                  reasons: { device_limit: "Source is beyond this device's supported quality" },
                },
              },
            },
          },
        }),
      ],
    },
  })
}

/** Puts the store into a *casting* state with the given stream info.
 * `targets` matters as much as the payload does: connectStore.isActive is
 * derived from it, and that's what decides whether this section is
 * describing a cast or this device's own playback. */
function setStreamInfo(overrides: Partial<ConnectStreamInfo>) {
  useConnectStore().status = makeStatus({
    targets: [{ name: 'Kitchen', type: 'sonos', volume: null, muted: null }],
    stream_info: {
      label: 'mp3-192k (fallback)',
      content_type: 'audio/mpeg',
      transcoding: true,
      source_codec: null,
      source_sample_rate: null,
      source_bit_depth: null,
      source_bitrate_kbps: null,
      target_sample_rate: null,
      target_bit_depth: null,
      target_bitrate_kbps: null,
      transcode_reason: null,
      active_connections: 0,
      loop_lag: 0,
      ...overrides,
    },
  })
}

describe('StreamInfoSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // "copy" tier: the source's own bytes reach the device untouched.
  it('shows no re-encode for a copy-tier dispatch', () => {
    setStreamInfo({ content_type: 'audio/flac', transcoding: false })
    const wrapper = mountSection()

    expect(wrapper.vm.castInfo.transcoding).toBe(false)
    expect(wrapper.text()).toContain('No, direct copy')
  })

  describe('target format while transcoding', () => {
    it('shows FLAC for either lossless-reencode tier', () => {
      setStreamInfo({ content_type: 'audio/flac', transcoding: true })
      const wrapper = mountSection()

      expect(wrapper.vm.targetLabel).toBe('FLAC')
      expect(wrapper.text()).toContain('FLAC')
    })

    // The bitrate travels with the format now. It used to be hardcoded
    // against the mp3 content type, which was accurate while the 192k
    // fallback was the only way to reach mp3 — a quality ceiling can land
    // on that same content type at 320 or 96.
    it('shows the bitrate the backend reports for an mp3 dispatch', () => {
      setStreamInfo({
        content_type: 'audio/mpeg',
        transcoding: true,
        target_bitrate_kbps: 192,
      })
      expect(mountSection().vm.targetLabel).toBe('MP3, 192 kb/s')

      setStreamInfo({
        content_type: 'audio/mpeg',
        transcoding: true,
        target_bitrate_kbps: 320,
      })
      expect(mountSection().vm.targetLabel).toBe('MP3, 320 kb/s')
    })

    // What the section couldn't say before: "FLAC" alone reads as an
    // untouched copy of a FLAC source when it's really a downsampled one.
    it('spells out the rate it was actually resampled to', () => {
      setStreamInfo({
        content_type: 'audio/flac',
        transcoding: true,
        source_sample_rate: 96000,
        target_sample_rate: 48000,
      })
      const wrapper = mountSection()

      expect(wrapper.vm.targetLabel).toBe('FLAC, 48 kHz')
    })

    it('spells out a reduced bit depth as well, and both together', () => {
      setStreamInfo({
        content_type: 'audio/flac',
        transcoding: true,
        target_bit_depth: 16,
      })
      expect(mountSection().vm.targetLabel).toBe('FLAC, 16-bit')

      setStreamInfo({
        content_type: 'audio/flac',
        transcoding: true,
        target_sample_rate: 44100,
        target_bit_depth: 16,
      })
      expect(mountSection().vm.targetLabel).toBe('FLAC, 44.1 kHz / 16-bit')
    })

    it('stays a plain format name when nothing was forced away from the source', () => {
      // The lossless-container tier re-encodes but keeps rate and depth —
      // restating the source's own numbers as a "target" would read as a
      // change that isn't happening.
      setStreamInfo({
        content_type: 'audio/flac',
        transcoding: true,
        source_sample_rate: 44100,
        source_bit_depth: 16,
        target_sample_rate: null,
        target_bit_depth: null,
        target_bitrate_kbps: null,
      })

      expect(mountSection().vm.targetLabel).toBe('FLAC')
    })
  })

  describe('transcoding reason', () => {
    it('explains why the track is not being passed through untouched', () => {
      setStreamInfo({ transcoding: true, transcode_reason: 'device_limit' })
      const wrapper = mountSection()

      expect(wrapper.text()).toContain('Reason')
      // Short enough to sit in the row's own right-hand column without
      // wrapping it into a paragraph; the sentence is the hover title.
      const reason = wrapper.get('.stream-info-reason')
      expect(reason.text()).toBe('Device limit')
      expect(reason.attributes('title')).toBe("Source is beyond this device's supported quality")
    })

    it('falls back to the full sentence for a key with no short wording yet', () => {
      // A too-long value beats an empty row: the reason itself is still
      // known, only its abbreviation is missing.
      setStreamInfo({ transcoding: true, transcode_reason: 'device_limit' })
      const wrapper = mountSectionWithoutShortWordings()

      expect(wrapper.get('.stream-info-reason').text()).toBe(
        "Source is beyond this device's supported quality",
      )
    })

    it('has a wording for every reason the backend can produce', () => {
      // The keys come from connect/core/streamer.py's REASON_* constants,
      // which its own test pins as the canonical set — a new one there
      // without a string here would silently show no reason at all.
      for (const reason of [
        'probe_failed',
        'device_limit',
        'quality_limit',
        'replay_gain',
        'lossless_container',
        'codec_not_castable',
        'codec_unknown',
      ]) {
        setStreamInfo({ transcoding: true, transcode_reason: reason })
        const wrapper = mountSection()
        expect(wrapper.find('.stream-info-reason').exists()).toBe(true)
        // Both wordings, not just the sentence — a key that only has the
        // long one falls back to it and quietly reintroduces the wrapping
        // this row was shortened to avoid.
        expect(wrapper.vm.reasonShort).not.toBe(wrapper.vm.reasonText)
      }
    })

    it('is hidden on the copy tier, where there is nothing to explain', () => {
      setStreamInfo({ transcoding: false, transcode_reason: null })
      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-reason').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Reason')
    })

    it('shows nothing rather than a raw key for a reason this build has no wording for', () => {
      // Forward compatibility: a newer backend can add a reason without
      // this build leaking "some_new_reason" into the UI.
      setStreamInfo({ transcoding: true, transcode_reason: 'some_new_reason' })
      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-reason').exists()).toBe(false)
    })
  })

  describe('sourceLine formatting', () => {
    it('is omitted entirely when nothing has been probed', () => {
      setStreamInfo({ source_codec: null })
      const wrapper = mountSection()

      expect(wrapper.vm.sourceLine).toBeNull()
    })

    it('combines codec, rate, bit depth and bitrate when all are known', () => {
      setStreamInfo({
        source_codec: 'mp3',
        source_sample_rate: 44100,
        source_bit_depth: null,
        source_bitrate_kbps: 320,
      })
      const wrapper = mountSection()

      expect(wrapper.vm.sourceLine).toBe('MP3, 44.1 kHz, 320 kb/s')
    })

    it('combines codec, rate and bit depth when bitrate is unknown (lossless)', () => {
      setStreamInfo({
        source_codec: 'flac',
        source_sample_rate: 96000,
        source_bit_depth: 24,
        source_bitrate_kbps: null,
      })
      const wrapper = mountSection()

      expect(wrapper.vm.sourceLine).toBe('FLAC, 96 kHz / 24-bit')
    })

    it('omits the rate entirely when it was never detected', () => {
      // See SourceInfo's own docstring: sample_rate/bit_depth/bitrate_kbps
      // are None when ffmpeg's probe line didn't carry them, never guessed.
      setStreamInfo({
        source_codec: 'opus',
        source_sample_rate: null,
        source_bit_depth: null,
        source_bitrate_kbps: null,
      })
      const wrapper = mountSection()

      expect(wrapper.vm.sourceLine).toBe('OPUS')
    })
  })

  describe('server lag row', () => {
    it('is hidden while the loop is healthy', () => {
      setStreamInfo({ loop_lag: 0.02 })
      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-lag').exists()).toBe(false)
    })

    // Same 1.0s threshold connect/core/loop_health.py's own
    // _STALL_WARN_SECONDS uses to decide whether a stall is worth logging
    // at all — this only surfaces what would already be worth knowing about.
    it('is shown once the loop lag reaches the stall threshold', () => {
      setStreamInfo({ loop_lag: 1.4 })
      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-lag').text()).toBe('1.4s')
    })
  })

  // Since the quality setting arrived, local playback has a format worth
  // knowing too — so this section is no longer gated on casting. What it
  // can say differs: the format is this app's own setting (no lookup), the
  // source comes from a probe connect runs on request, and the two
  // cast-only rows drop out entirely.
  describe('local playback', () => {
    /** A track playing locally at `quality`. Both fields are set on
     * purpose: `localQuality` is the setting, `activeLocalStream` is what
     * was actually decided for the loaded track, and this panel describes
     * the second one. They agree here because nothing has been changed
     * mid-track — see the tests that pull them apart. */
    function setLocal(
      quality: { format: 'original' | 'mp3'; bitrate: number },
      reason: 'quality_limit' | 'browser_unsupported' | null = null,
    ) {
      // No targets — connectStore.isActive is false, i.e. this device is
      // the one playing.
      useConnectStore().status = makeStatus()
      const playback = usePlaybackStore()
      playback.queue = [makeSong('song-1')]
      playback.currentIndex = 0
      playback.localQuality = quality
      playback.activeLocalStream = { quality: { ...quality }, reason }
    }

    beforeEach(() => {
      localStorage.clear()
      vi.restoreAllMocks()
      vi.spyOn(localStreamInfo, 'fetchLocalSourceInfo').mockResolvedValue({
        source_codec: 'flac',
        source_sample_rate: 96000,
        source_bit_depth: 24,
        source_bitrate_kbps: null,
      })
    })

    it('reports untouched playback when the quality is set to original', async () => {
      setLocal({ format: 'original', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.vm.transcoding).toBe(false)
      expect(wrapper.text()).toContain('No, direct copy')
    })

    it('names the format and bitrate it was told to fetch', async () => {
      setLocal({ format: 'mp3', bitrate: 320 }, 'quality_limit')
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.vm.transcoding).toBe(true)
      expect(wrapper.vm.targetLabel).toBe('MP3, 320 kb/s')
    })

    it('shows the probed source, which the media server metadata lacks', async () => {
      // A Song carries `format` and `bitRate` — no sample rate, no bit
      // depth. That gap is the whole reason for the extra round trip.
      setLocal({ format: 'mp3', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.vm.sourceLine).toBe('FLAC, 96 kHz / 24-bit')
    })

    it('hides the cast-only rows', async () => {
      // Both describe a device pulling from this backend, which is exactly
      // what isn't happening — reporting "no active connection" for local
      // playback would read as a fault.
      setLocal({ format: 'original', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.text()).not.toContain('Connection')
      expect(wrapper.text()).not.toContain('Server responsiveness')
    })

    it('says why it is converting, same as a cast does', async () => {
      setLocal({ format: 'mp3', bitrate: 192 }, 'quality_limit')
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.get('.stream-info-reason').text()).toBe('Quality limit')
    })

    it('has a wording for a source no browser can decode', async () => {
      // The one reason with no backend counterpart — a cast device's own
      // format limits are a different question, covered by device_limit.
      setLocal({ format: 'mp3', bitrate: 192 }, 'browser_unsupported')
      const wrapper = mountSection()
      await flushPromises()

      const reason = wrapper.get('.stream-info-reason')
      expect(reason.text()).toBeTruthy()
      expect(reason.attributes('title')).toBeTruthy()
    })

    it('shows no reason for a track being played untouched', async () => {
      setLocal({ format: 'original', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.find('.stream-info-reason').exists()).toBe(false)
    })

    it('reports untouched playback for a track already under the ceiling', async () => {
      // The setting says "MP3 320" but a 128 kbps source is fetched as-is,
      // so the panel must say Original — echoing the setting here was the
      // bug this covers.
      const playback = usePlaybackStore()
      useConnectStore().status = makeStatus()
      playback.queue = [makeSong('song-1', { format: 'mp3', bitRate: 128 })]
      playback.currentIndex = 0
      playback.setLocalQuality('mp3', 320)
      playback.localStreamUrl(playback.currentSong!)

      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.vm.transcoding).toBe(false)
      expect(wrapper.text()).toContain('No, direct copy')
      expect(wrapper.find('.stream-info-reason').exists()).toBe(false)
    })

    it('keeps describing the running stream after the setting is changed', async () => {
      // The setting only takes effect at the next song start, so the track
      // playing right now is still the untouched file. Reading the setting
      // here made the panel announce "MP3, 192 kb/s" the instant it was
      // picked, over a FLAC that went on playing for another three
      // minutes.
      setLocal({ format: 'original', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      usePlaybackStore().setLocalQuality('mp3', 192)
      await flushPromises()

      expect(wrapper.vm.transcoding).toBe(false)
      expect(wrapper.text()).toContain('No, direct copy')
    })

    it('says nothing at all before a track has been loaded', async () => {
      // Nothing is playing, so there is no stream to describe. See the
      // 'radio' describe below for that other case that says nothing.
      useConnectStore().status = makeStatus()
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.find('.stream-info-section').exists()).toBe(false)
    })

    it('does not fetch a probe while casting, which reports its own', async () => {
      setStreamInfo({ transcoding: false })
      mountSection()
      await flushPromises()

      expect(localStreamInfo.fetchLocalSourceInfo).not.toHaveBeenCalled()
    })

    it('leaves the source row out when the probe fails', async () => {
      // Everything else in the panel is derived locally and stays correct,
      // so an unreachable backend costs one row rather than the section.
      vi.mocked(localStreamInfo.fetchLocalSourceInfo).mockRejectedValue(new Error('offline'))
      setLocal({ format: 'mp3', bitrate: 192 })
      const wrapper = mountSection()
      await flushPromises()

      expect(wrapper.vm.sourceLine).toBeNull()
      expect(wrapper.vm.targetLabel).toBe('MP3, 192 kb/s')
    })

    it('ignores a probe that resolves after the track already changed', async () => {
      // Showing the previous track's format under the new one's name would
      // be worse than showing nothing. Each track gets its own promise
      // here, exactly as a real fetch would — sharing one would let the
      // stale answer satisfy the *new* track's request and hide the bug
      // this is about.
      setLocal({ format: 'mp3', bitrate: 192 })
      let resolveFirst: (v: localStreamInfo.LocalSourceInfo) => void = () => {}
      vi.mocked(localStreamInfo.fetchLocalSourceInfo).mockImplementation((trackId) =>
        trackId === 'song-1'
          ? new Promise((r) => {
              resolveFirst = r
            })
          : // song-2's own probe is still in flight.
            new Promise(() => {}),
      )
      const wrapper = mountSection()

      const playback = usePlaybackStore()
      playback.queue = [makeSong('song-2')]
      playback.currentIndex = 0
      await flushPromises()

      resolveFirst({
        source_codec: 'mp3',
        source_sample_rate: 44100,
        source_bit_depth: null,
        source_bitrate_kbps: 320,
      })
      await flushPromises()

      expect(wrapper.vm.sourceLine).toBeNull()
    })
  })

  describe('radio', () => {
    function setRadio() {
      usePlaybackStore().radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example/chill',
        homePageUrl: null,
      }
    }

    it('says nothing while casting, even though stream_info still holds the generic mp3 fallback', () => {
      // /play-url (routes/playback.py) hands the target the station's raw
      // URL directly and never runs it through the transcode pipeline —
      // `stream_info` here is just leftover bookkeeping from before radio
      // started, not a description of what the device is actually getting.
      // Before this was fixed, the panel reported "transcoding to MP3" for
      // every cast radio station regardless of the quality setting.
      setStreamInfo({}) // the fallback defaults: label 'mp3-192k (fallback)', transcoding true
      setRadio()

      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-section').exists()).toBe(false)
    })

    it('says nothing locally either, same as before a track has ever loaded', () => {
      useConnectStore().status = makeStatus()
      setRadio()

      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-section').exists()).toBe(false)
    })

    it('does describe a station the device refused and connect re-encoded', () => {
      // The one radio case with a real transcode behind it: the speaker
      // wouldn't take the station's own stream, so connect runs it through
      // the very pipeline this panel reports on. Hiding that would leave a
      // listener wondering why the station sounds different.
      setStreamInfo({ transcoding: true, transcode_reason: 'device_rejected_stream' })
      setRadio()

      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-section').exists()).toBe(true)
      expect(wrapper.vm.reasonKey).toBe('device_rejected_stream')
    })

    it('still says nothing for a station playing straight through', () => {
      // Matched on the reason specifically, not on `transcoding` — that
      // stays true for every cast station purely as bookkeeping.
      setStreamInfo({ transcoding: true, transcode_reason: 'device_limit' })
      setRadio()

      const wrapper = mountSection()

      expect(wrapper.find('.stream-info-section').exists()).toBe(false)
    })
  })
})
