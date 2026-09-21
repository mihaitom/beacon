<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.playbackTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__label">{{ $t('settings.replayGain') }}</p>
        <segmented-control
          v-model="replayGainMode"
          :options="replayGainOptions"
          :label="$t('settings.replayGain')"
        />
        <p class="setting__hint">{{ $t('settings.replayGainHint') }}</p>
        <!-- Local playback on a phone runs without a Web Audio graph, which
         - is also what ReplayGain needs to change the level (see
         - webAudioAllowed() in services/audioEngine.ts) — saying so beats a
         - setting that silently does half of what it claims. -->
        <p v-if="!hasLocalGain" class="setting__hint">
          {{ $t('settings.replayGainMobileHint') }}
        </p>
      </div>

      <div class="setting">
        <!-- The label with the recommendations beside it. Which format
         - and which number to pick is not something a listener can read
         - off the two dropdowns, and the hint under them explains what
         - the setting *is* rather than what to choose — so the advice
         - sits where the question is asked, out of the way until it is
         - wanted. -->
        <div class="setting__label-row">
          <p class="setting__label setting__label--inline">
            {{ $t('settings.localQuality') }}
          </p>
          <quality-tips :lines="localQualityTips" />
        </div>
        <div class="quality-row">
          <v-select
            :model-value="playbackStore.localQuality.format"
            :items="formatOptions"
            :label="$t('settings.qualityFormat')"
            variant="solo-filled"
            hide-details
            @update:model-value="playbackStore.setLocalQuality($event)"
          />
          <v-select
            v-if="playbackStore.localQuality.format !== 'original'"
            :model-value="playbackStore.localQuality.bitrate"
            :items="bitrateOptions(playbackStore.localQuality.format)"
            :label="$t('settings.qualityBitrate')"
            variant="solo-filled"
            hide-details
            @update:model-value="
              playbackStore.setLocalQuality(playbackStore.localQuality.format, $event)
            "
          />
        </div>
        <p class="setting__hint">{{ $t('settings.localQualityHint') }}</p>
      </div>

      <div class="setting">
        <div class="setting__label-row">
          <p class="setting__label setting__label--inline">
            {{ $t('settings.castQuality') }}
          </p>
          <quality-tips :lines="castQualityTips" />
        </div>
        <div class="quality-row">
          <v-select
            :model-value="playbackStore.castQuality.format"
            :items="castFormatOptions"
            :label="$t('settings.qualityFormat')"
            variant="solo-filled"
            hide-details
            @update:model-value="playbackStore.setCastQuality($event)"
          />
          <v-select
            v-if="playbackStore.castQuality.format !== 'original'"
            :model-value="playbackStore.castQuality.bitrate"
            :items="bitrateOptions(playbackStore.castQuality.format)"
            :label="$t('settings.qualityBitrate')"
            variant="solo-filled"
            hide-details
            @update:model-value="
              playbackStore.setCastQuality(playbackStore.castQuality.format, $event)
            "
          />
        </div>
        <p class="setting__hint">{{ $t('settings.castQualityHint') }}</p>
      </div>

      <div class="setting">
        <v-switch
          :model-value="radioSettingsStore.castDirectly"
          color="primary"
          density="compact"
          hide-details
          :label="$t('settings.castRadioDirectly')"
          @update:model-value="radioSettingsStore.setCastDirectly(!!$event)"
        />
        <p class="setting__hint">{{ $t('settings.castRadioDirectlyHint') }}</p>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useRadioSettingsStore } from '@/stores/radioSettings'
import type { ReplayGainMode } from '@/services/replayGain'
import { getAudioEngine } from '@/services/audioEngine'
import {
  BITRATES,
  CAST_FORMATS,
  localFormats,
  type StreamFormat,
  type TranscodeFormat,
} from '@/services/streamQuality'
import SegmentedControl from '@/components/SegmentedControl.vue'
import QualityTips from './QualityTips.vue'

/**
 * How audio is played and cast: ReplayGain, the quality ceiling for this
 * device and for cast targets, and whether radio goes straight from the
 * station or through Beacon's own relay.
 */
export default {
  name: 'PlaybackSection',
  components: { QualityTips, SegmentedControl },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    radioSettingsStore() {
      return useRadioSettingsStore()
    },
    hasLocalGain(): boolean {
      return getAudioEngine().hasAnalyser
    },
    replayGainMode: {
      get(): ReplayGainMode {
        return this.playbackStore.replayGainMode
      },
      set(mode: ReplayGainMode) {
        this.playbackStore.setReplayGainMode(mode)
      },
    },
    replayGainOptions(): { title: string; value: ReplayGainMode }[] {
      return [
        { title: this.$t('settings.replayGainOff'), value: 'off' },
        { title: this.$t('settings.replayGainTrack'), value: 'song' },
        { title: this.$t('settings.replayGainAlbum'), value: 'album' },
      ]
    },
    formatOptions(): { title: string; value: StreamFormat }[] {
      return localFormats().map((value) => ({ title: this.formatLabel(value), value }))
    },
    castFormatOptions(): { title: string; value: StreamFormat }[] {
      return CAST_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    localQualityTips(): string[] {
      const lines = [
        this.$t('settings.qualityTips.ceiling'),
        this.$t('settings.qualityTips.home'),
        this.$t('settings.qualityTips.mobile'),
      ]
      if (localFormats().includes('opus')) lines.push(this.$t('settings.qualityTips.slow'))
      lines.push(this.$t('settings.qualityTips.compatibility'))
      return lines
    },
    castQualityTips(): string[] {
      return [
        this.$t('settings.qualityTips.ceiling'),
        this.$t('settings.qualityTips.castDefault'),
        this.$t('settings.qualityTips.castWhenNeeded'),
        this.$t('settings.qualityTips.castCompatibility'),
        this.$t('settings.qualityTips.castDevice'),
      ]
    },
  },
  methods: {
    formatLabel(format: StreamFormat): string {
      return format === 'original' ? this.$t('settings.qualityOriginal') : format.toUpperCase()
    },
    bitrateOptions(format: TranscodeFormat): { title: string; value: number }[] {
      return BITRATES[format].map((value) => ({
        title: this.$t('settings.qualityBitrateItem', { value }),
        value,
      }))
    },
  },
}
</script>

<style scoped>
/* Format and bitrate side by side, with the format wider — it carries the
 * actual decision, while the bitrate is a number that needs no room. Wraps
 * on a narrow window (the mobile web build) instead of squeezing both into
 * something unreadable. */
.quality-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.quality-row > :first-child {
  flex: 2 1 180px;
}
.quality-row > :last-child:not(:first-child) {
  flex: 1 1 120px;
}
</style>
