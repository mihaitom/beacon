import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import StreamInfoSection from '../StreamInfoSection.vue'
import { makeStatus } from '@/stores/__tests__/fixtures'
import type { ConnectStreamInfo } from '@/services/connect/types'

const vuetify = createVuetify({ components, directives })

function mountSection() {
  return mount(StreamInfoSection, {
    global: { plugins: [vuetify, i18n] },
  })
}

function setStreamInfo(overrides: Partial<ConnectStreamInfo>) {
  useConnectStore().status = makeStatus({
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

    expect(wrapper.vm.info.transcoding).toBe(false)
    expect(wrapper.text()).toContain('No, direct copy')
  })

  describe('target format while transcoding', () => {
    it('shows FLAC for either lossless-reencode tier', () => {
      setStreamInfo({ content_type: 'audio/flac', transcoding: true })
      const wrapper = mountSection()

      expect(wrapper.vm.targetLabel).toBe('FLAC')
      expect(wrapper.text()).toContain('FLAC')
    })

    // core/streamer.py's _FALLBACK_ARGS always encodes at 192 kb/s — a
    // fixed fact about the fallback tier, not something read off the
    // stream, so it's safe to state outright rather than needing a probed
    // number.
    it('shows the fixed fallback bitrate for the mp3 fallback tier', () => {
      setStreamInfo({ content_type: 'audio/mpeg', transcoding: true })
      const wrapper = mountSection()

      expect(wrapper.vm.targetLabel).toBe('MP3, 192 kb/s')
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
      })

      expect(mountSection().vm.targetLabel).toBe('FLAC')
    })
  })

  describe('transcoding reason', () => {
    it('explains why the track is not being passed through untouched', () => {
      setStreamInfo({ transcoding: true, transcode_reason: 'device_limit' })
      const wrapper = mountSection()

      expect(wrapper.text()).toContain('Reason')
      expect(wrapper.get('.stream-info-reason').text()).toBe(
        "Source is beyond this device's supported quality",
      )
    })

    it('has a wording for every reason the backend can produce', () => {
      // The keys come from connect/core/streamer.py's REASON_* constants,
      // which its own test pins as the canonical set — a new one there
      // without a string here would silently show no reason at all.
      for (const reason of [
        'forced',
        'probe_failed',
        'device_limit',
        'replay_gain',
        'lossless_container',
        'codec_not_castable',
        'codec_unknown',
      ]) {
        setStreamInfo({ transcoding: true, transcode_reason: reason })
        expect(mountSection().find('.stream-info-reason').exists()).toBe(true)
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
})
