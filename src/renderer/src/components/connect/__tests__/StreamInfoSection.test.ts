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
