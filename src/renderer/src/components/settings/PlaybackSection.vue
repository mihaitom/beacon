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
        <p v-if="!hasLocalGain && !mixAppliesGain" class="setting__hint">
          {{ $t('settings.replayGainMobileHint') }}
        </p>
      </div>

      <div class="setting">
        <p class="setting__label">{{ $t('settings.transitions') }}</p>
        <segmented-control
          v-model="transitionMode"
          :options="transitionOptions"
          :label="$t('settings.transitions')"
        />
        <!-- A stepper rather than a slider: Vuetify's slider loses the drag
         - on a real phone (see docs/investigations/mobile-volume-slider-drag.md).
         - A beatmix is a choice of phrase lengths, not a number of seconds -
         - see BEATMIX_BARS. -->
        <div v-if="transitionsStore.mode === 'crossfade'" class="crossfade-lengths">
          <v-number-input
            :model-value="transitionsStore.crossfadeSeconds"
            :label="$t('settings.crossfadeLength')"
            :min="lengthMin"
            :max="lengthMax"
            :step="1"
            suffix="s"
            control-variant="stacked"
            variant="solo-filled"
            prepend-inner-icon="mdi-vector-intersection"
            hide-details
            @update:model-value="setCrossfadeSeconds"
          />
          <v-select
            :model-value="transitionsStore.beatmixBars"
            :items="beatmixBarOptions"
            :label="$t('settings.beatmixLength')"
            variant="solo-filled"
            prepend-inner-icon="mdi-metronome"
            hide-details
            @update:model-value="transitionsStore.set({ beatmixBars: $event })"
          />
        </div>
        <p class="setting__hint">{{ $t('settings.transitionsHint') }}</p>
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
        <!-- Under both quality settings: the doc covers this device and
         - casting alike, and radio, which neither setting governs. -->
        <div class="setting__control-row">
          <v-btn
            variant="text"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'transcoding-decisions')"
          >
            {{ $t('help.conversion') }}
          </v-btn>
        </div>
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
import {
  BEATMIX_BARS,
  CROSSFADE_SECONDS_MAX,
  CROSSFADE_SECONDS_MIN,
  useTransitionsStore,
  type BeatmixBars,
  type TransitionMode,
} from '@/stores/transitions'
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
 * How audio is played and cast: ReplayGain, transitions between songs, the
 * quality ceiling for this device and for cast targets, and whether radio
 * goes straight from the station or through Beacon's own relay.
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
    transitionsStore() {
      return useTransitionsStore()
    },
    transitionMode: {
      get(): TransitionMode {
        return this.transitionsStore.mode
      },
      set(mode: TransitionMode) {
        this.transitionsStore.set({ mode })
      },
    },
    transitionOptions(): { title: string; value: TransitionMode }[] {
      return [
        { title: this.$t('settings.transitionsOff'), value: 'off' },
        { title: this.$t('settings.transitionsGapless'), value: 'gapless' },
        { title: this.$t('settings.transitionsCrossfade'), value: 'crossfade' },
      ]
    },
    beatmixBarOptions(): { title: string; value: BeatmixBars }[] {
      return BEATMIX_BARS.map((n) => ({ title: this.$t('settings.beatmixBars', { n }), value: n }))
    },
    lengthMin(): number {
      return CROSSFADE_SECONDS_MIN
    },
    lengthMax(): number {
      return CROSSFADE_SECONDS_MAX
    },
    hasLocalGain(): boolean {
      return getAudioEngine().hasAnalyser
    },
    /** A mix applies ReplayGain itself, so it reaches phones too. */
    mixAppliesGain(): boolean {
      return this.transitionsStore.enabled
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
    /** A field emptied while typing sends null; the stored length stays. */
    setCrossfadeSeconds(value: number | null): void {
      if (value !== null) this.transitionsStore.set({ crossfadeSeconds: value })
    },
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
/* Two equal halves of the row, one under the other once a half would be
 * too narrow for its label. */
.crossfade-lengths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
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
