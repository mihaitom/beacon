<template>
  <v-dialog
    :model-value="modelValue"
    max-width="600"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog">
      <v-card-title class="eq__head">
        <div class="eq__grow">
          <div class="eyebrow-label">{{ subject }}</div>
          <div>{{ $t('equalizer.title') }}</div>
        </div>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('help.title')"
          @click="$emitter.emit('openHelp', 'faq/equalizer')"
        />
        <v-switch
          :model-value="draft.enabled"
          :disabled="unavailable"
          :aria-label="$t('equalizer.enabled')"
          color="primary"
          density="compact"
          hide-details
          class="eq__switch"
          @update:model-value="change({ enabled: !!$event })"
        />
      </v-card-title>

      <v-card-text>
        <!-- Casting to several speakers: each keeps its own curve, so which
           - one is being set has to be picked. -->
        <segmented-control
          v-if="targets.length > 1"
          :model-value="deviceKey ?? ''"
          :options="targetOptions"
          :label="$t('equalizer.speaker')"
          class="eq__targets"
          @update:model-value="selectTarget"
        />

        <p v-if="unavailable" class="setting__hint eq__hint">
          {{ $t('equalizer.unavailableHint') }}
        </p>

        <div class="eq__presets">
          <v-menu v-model="presetMenu" :disabled="unavailable" location="bottom start">
            <template #activator="{ props: menuProps }">
              <button
                v-bind="menuProps"
                type="button"
                class="eq__picker"
                :disabled="unavailable"
                :aria-label="$t('equalizer.preset')"
              >
                <equalizer-mini-curve :gains="draft.gains" />
                <span class="eq__picker-text">
                  <span class="eq__picker-label">{{ $t('equalizer.preset') }}</span>
                  <span>{{ presetTitle }}</span>
                </span>
                <v-icon icon="mdi-chevron-down" size="20" />
              </button>
            </template>
            <v-list density="compact" class="eq__menu">
              <v-list-subheader>{{ $t('equalizer.presetsHeading') }}</v-list-subheader>
              <v-list-item
                v-for="name in presetNames"
                :key="name"
                :active="selectedPreset === name"
                color="primary"
                @click="pickPreset(name)"
              >
                <template #prepend><equalizer-mini-curve :gains="builtIn(name)" /></template>
                <v-list-item-title class="eq__menu-title">
                  {{ $t(`equalizer.presets.${name}`) }}
                </v-list-item-title>
              </v-list-item>
              <template v-if="customPresets.length > 0">
                <v-list-subheader>{{ $t('equalizer.ownHeading') }}</v-list-subheader>
                <v-list-item
                  v-for="custom in customPresets"
                  :key="custom.name"
                  :active="selectedPreset === `custom:${custom.name}`"
                  color="primary"
                  @click="pickPreset(`custom:${custom.name}`)"
                >
                  <template #prepend><equalizer-mini-curve :gains="custom.gains" /></template>
                  <v-list-item-title class="eq__menu-title">{{ custom.name }}</v-list-item-title>
                  <template #append>
                    <v-btn
                      icon="mdi-close"
                      size="small"
                      variant="text"
                      density="comfortable"
                      :aria-label="$t('equalizer.deletePreset', { name: custom.name })"
                      :title="$t('equalizer.deletePreset', { name: custom.name })"
                      @click.stop="store.deletePreset(custom.name)"
                    />
                  </template>
                </v-list-item>
              </template>
            </v-list>
          </v-menu>
          <v-btn
            icon="mdi-content-save-outline"
            variant="text"
            class="eq__save-btn"
            :disabled="unavailable || selectedPreset !== 'custom'"
            :title="$t('equalizer.savePreset')"
            :aria-label="$t('equalizer.savePreset')"
            @click="startNaming"
          />
        </div>

        <form v-if="naming" class="eq__save" @submit.prevent="savePreset">
          <v-text-field
            v-model="presetName"
            :label="$t('equalizer.presetName')"
            :maxlength="presetNameMax"
            density="compact"
            variant="outlined"
            hide-details
            autofocus
            class="eq__grow"
            @keydown.esc.stop="naming = false"
          />
          <v-btn type="submit" variant="tonal" color="primary" :disabled="!presetName.trim()">
            {{ $t('common.save') }}
          </v-btn>
        </form>

        <equalizer-graph
          :gains="draft.gains"
          :enabled="draft.enabled"
          :disabled="unavailable"
          :sample="spectrum"
          @change="setGain"
        />

        <p v-if="device" class="setting__hint eq__hint-below">
          {{ $t(live ? 'equalizer.liveHint' : 'equalizer.speakerHint') }}
        </p>
      </v-card-text>

      <v-card-actions class="eq__actions">
        <v-btn variant="text" :disabled="unavailable || isFlatCurve" @click="pickPreset('flat')">
          {{ $t('equalizer.reset') }}
        </v-btn>
        <v-btn v-if="canApplyNow" variant="text" color="primary" @click="applyNow">
          {{ $t(live ? 'equalizer.listenNow' : 'equalizer.applyNow') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useEqualizerStore, speakerKey } from '@/stores/equalizer'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { useTransitionsStore } from '@/stores/transitions'
import { getAudioEngine } from '@/services/audioEngine'
import { analyserBands, resampleBands } from '@/services/visualizerBands'
import { VisualizerEventSource } from '@/services/connect/visualizer'
import type { VisualizerFrame } from '@/services/connect/types'
import { useAuthStore } from '@/stores/auth'
import {
  EQ_PRESETS,
  EQ_PRESET_NAMES,
  PRESET_NAME_MAX_LENGTH,
  isFlat,
  presetOf,
  sameGains,
  type CustomPreset,
  type EqualizerPreset,
  type EqualizerSetting,
} from '@/services/equalizer'
import type { ConnectDeviceRef } from '@/services/connect/types'
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue'
import EqualizerGraph from './EqualizerGraph.vue'
import EqualizerMiniCurve from './EqualizerMiniCurve.vue'

// How long a speaker's curve waits after the last movement before it is
// saved and sent: every save goes to the account and, while casting, to
// connect, and a drag would otherwise send one per step.
const SPEAKER_SAVE_DELAY_MS = 200

/** The equalizer for whatever is playing: the speaker being cast to (one
 * of them, picked here, when there are several), otherwise this device.
 * This device's curve is heard while it is moved. A speaker's is too with
 * transitions on, once the speaker has played the head start it holds
 * (connect filters the mix live); without them, from the next song on.
 * Either way the button in the footer restarts the song where it is, to
 * hear it now. */
export default {
  name: 'EqualizerDialog',
  components: { EqualizerGraph, EqualizerMiniCurve, SegmentedControl },
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      draft: { enabled: false, gains: [] as number[] } as EqualizerSetting,
      // Which speaker the draft belongs to (null: this device). Kept apart
      // from `device`, which can change under a pending save - another
      // speaker picked, or the cast ending.
      draftDevice: null as ConnectDeviceRef | null,
      pickedKey: null as string | null,
      saveTimer: null as ReturnType<typeof setTimeout> | null,
      presetMenu: false,
      naming: false,
      presetName: '',
      frequencyData: null as Uint8Array<ArrayBuffer> | null,
      castBands: null as number[] | null,
      castEvents: null as VisualizerEventSource | null,
    }
  },
  computed: {
    store() {
      return useEqualizerStore()
    },
    presetNames(): EqualizerPreset[] {
      return EQ_PRESET_NAMES
    },
    customPresets(): CustomPreset[] {
      return this.store.presets
    },
    presetNameMax(): number {
      return PRESET_NAME_MAX_LENGTH
    },
    targets(): ConnectDeviceRef[] {
      return useConnectStore().activeTargets.map(({ type, name }) => ({ type, name }))
    },
    targetOptions(): SegmentedOption[] {
      return this.targets.map((t) => ({ title: t.name, value: this.keyOf(t) }))
    },
    /** The speaker being set, or null for this device. */
    device(): ConnectDeviceRef | null {
      return this.targets.find((t) => this.keyOf(t) === this.pickedKey) ?? this.targets[0] ?? null
    },
    deviceKey(): string | null {
      return this.device ? this.keyOf(this.device) : null
    },
    subject(): string {
      return this.device ? this.device.name : this.$t('equalizer.thisDevice')
    },
    /** This device's curve where there is no Web Audio graph to put it in
     * (phones and tablets, see webAudioAllowed()). */
    unavailable(): boolean {
      return !this.device && !getAudioEngine().hasAnalyser
    },
    /** Whether a speaker hears a change while the song plays: with
     * transitions on, the mix is filtered as it is fed to the speaker. */
    live(): boolean {
      return useTransitionsStore().mode !== 'off'
    },
    /** The preset the curve is: a built-in name, `custom:<name>` for one
     * of the listener's own, or 'custom' for neither. */
    selectedPreset(): string {
      const builtIn = presetOf(this.draft.gains)
      if (builtIn) return builtIn
      const own = this.customPresets.find((p) => sameGains(p.gains, this.draft.gains))
      return own ? `custom:${own.name}` : 'custom'
    },
    presetTitle(): string {
      const selected = this.selectedPreset
      if (selected === 'custom') return this.$t('equalizer.custom')
      if (selected.startsWith('custom:')) return selected.slice('custom:'.length)
      return this.$t(`equalizer.presets.${selected}`)
    },
    isFlatCurve(): boolean {
      return isFlat(this.draft.gains)
    },
    /** Whether the music behind the curve comes from connect: casting,
     * with the dialog open and something playing. */
    castSpectrum(): boolean {
      return this.modelValue && this.device !== null && usePlaybackStore().isPlaying
    },
    /** The music behind the curve: this device's own analyser, or while
     * casting the frames connect analyses for Now Playing's bars. */
    spectrum(): (() => number[] | null) | null {
      if (this.castSpectrum) return () => resampleBands(this.castBands)
      if (this.device || this.unavailable || !usePlaybackStore().isPlaying) return null
      return () => {
        const { heights, data } = analyserBands(getAudioEngine().getAnalyser(), this.frequencyData)
        this.frequencyData = data
        return heights
      }
    },
    /** A speaker playing a song for this session can be restarted where it
     * is, so the curve is heard now rather than after its buffer or the
     * song. Not a station: those are never equalized (the relay serves
     * every speaker one stream). */
    canApplyNow(): boolean {
      if (!this.device) return false
      const playback = usePlaybackStore()
      return (
        playback.isPlaying &&
        playback.currentSong !== null &&
        playback.radioStation === null &&
        playback.preview === null
      )
    },
  },
  watch: {
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open) {
          this.pickedKey = null
          this.naming = false
          this.load()
        } else this.flush()
      },
    },
    deviceKey() {
      if (!this.modelValue) return
      this.flush()
      this.load()
    },
    castSpectrum: {
      immediate: true,
      handler(wanted: boolean) {
        if (wanted) this.startCastEvents()
        else this.stopCastEvents()
      },
    },
  },
  beforeUnmount() {
    this.flush()
    this.stopCastEvents()
  },
  methods: {
    /** Opened only while the dialog shows a cast: an open connection is
     * what keeps connect analysing at all. */
    startCastEvents(): void {
      if (this.castEvents) return
      const auth = useAuthStore()
      this.castEvents = new VisualizerEventSource(auth.apiUrl, auth.connectToken, auth.sessionId)
      this.castEvents.onFrame = (frame: VisualizerFrame) => {
        this.castBands = frame.bands
      }
      this.castEvents.start()
    },
    stopCastEvents(): void {
      this.castEvents?.stop()
      this.castEvents = null
      this.castBands = null
    },
    keyOf(device: ConnectDeviceRef): string {
      return speakerKey(device)
    },
    builtIn(name: EqualizerPreset): readonly number[] {
      return EQ_PRESETS[name]
    },
    load(): void {
      this.draftDevice = this.device
      const setting = this.device ? this.store.speaker(this.device) : this.store.local
      this.draft = { enabled: setting.enabled, gains: [...setting.gains] }
    },
    selectTarget(key: string | null | undefined): void {
      if (key) this.pickedKey = key
    },
    change(patch: Partial<EqualizerSetting>): void {
      this.draft = { ...this.draft, ...patch }
      if (!this.draftDevice) {
        // Heard as it moves - the whole point of trying a curve out.
        this.store.setLocal(this.draft)
        return
      }
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => this.flush(), SPEAKER_SAVE_DELAY_MS)
    },
    /** Saves a speaker's pending change now rather than when its timer
     * runs out. */
    flush(): void {
      if (!this.saveTimer) return
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      if (this.draftDevice) this.store.setSpeaker(this.draftDevice, this.draft)
    },
    setGain(index: number, gain: number): void {
      const gains = [...this.draft.gains]
      gains[index] = gain
      // Moving a band is wanting to hear it.
      this.change({ gains, enabled: true })
    },
    /** A built-in preset's name, or `custom:<name>` for one of the
     * listener's own. */
    pickPreset(value: string): void {
      const own = value.startsWith('custom:')
        ? this.customPresets.find((p) => `custom:${p.name}` === value)
        : undefined
      if (own) {
        this.change({ gains: [...own.gains], enabled: true })
        return
      }
      if (!(value in EQ_PRESETS)) return
      const gains = [...EQ_PRESETS[value as EqualizerPreset]]
      this.change({ gains, enabled: value !== 'flat' || this.draft.enabled })
    },
    startNaming(): void {
      this.presetName = ''
      this.naming = true
    },
    savePreset(): void {
      const name = this.presetName.trim()
      if (!name) return
      this.store.savePreset(name, this.draft.gains)
      this.naming = false
    },
    async applyNow(): Promise<void> {
      if (!this.draftDevice) return
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.store.setSpeaker(this.draftDevice, this.draft)
      const playback = usePlaybackStore()
      await playback.startCurrent(playback.localPosition)
    },
  },
}
</script>

<style scoped>
.eq__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.eq__grow {
  flex: 1;
  min-width: 0;
}

.eq__switch {
  flex: none;
}

.eq__targets,
.eq__hint {
  margin-bottom: 14px;
}

.eq__presets {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

/* A button that looks like the field it opens a list for: the preset's
 * shape, its name, and a chevron. A v-select was the first candidate, but
 * its selection slot cannot show the curve of a custom shape that is in
 * no list. */
.eq__picker {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.03);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.eq__picker:hover:not(:disabled) {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.eq__picker:disabled {
  opacity: 0.5;
  cursor: default;
}

.eq__picker-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.eq__picker-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.eq__save-btn {
  flex: none;
}

.eq__menu-title {
  margin-left: 12px;
}

.eq__save {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.eq__hint-below {
  margin-top: 8px;
}

.eq__actions {
  flex-wrap: wrap;
}
</style>
