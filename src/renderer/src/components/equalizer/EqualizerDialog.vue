<template>
  <v-dialog
    :model-value="modelValue"
    max-width="560"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog">
      <v-card-title class="eq__head">
        <div class="eq__grow">
          <div class="eyebrow-label">{{ subject }}</div>
          <div>{{ $t('equalizer.title') }}</div>
        </div>
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
        <v-chip-group
          v-if="targets.length > 1"
          :model-value="deviceKey"
          selected-class="text-primary"
          mandatory
          column
          class="eq__targets"
          @update:model-value="selectTarget"
        >
          <v-chip
            v-for="target in targets"
            :key="keyOf(target)"
            :value="keyOf(target)"
            variant="outlined"
            prepend-icon="mdi-speaker"
          >
            {{ target.name }}
          </v-chip>
        </v-chip-group>

        <p v-if="unavailable" class="setting__hint eq__hint">
          {{ $t('equalizer.unavailableHint') }}
        </p>

        <v-chip-group
          :model-value="selectedPreset"
          selected-class="text-primary"
          column
          :disabled="unavailable"
          class="eq__presets"
          @update:model-value="pickPreset"
        >
          <v-chip v-for="name in presetNames" :key="name" :value="name" variant="outlined">
            {{ $t(`equalizer.presets.${name}`) }}
          </v-chip>
          <v-chip
            v-for="custom in customPresets"
            :key="`custom:${custom.name}`"
            :value="`custom:${custom.name}`"
            variant="outlined"
            closable
            :close-label="$t('equalizer.deletePreset', { name: custom.name })"
            @click:close="store.deletePreset(custom.name)"
          >
            {{ custom.name }}
          </v-chip>
          <v-chip v-if="selectedPreset === 'custom'" value="custom" variant="outlined" disabled>
            {{ $t('equalizer.custom') }}
          </v-chip>
        </v-chip-group>

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

        <!-- The curve the bands add up to, headroom included: what is
           - actually heard, not ten separate bumps. -->
        <svg
          class="eq__curve"
          :class="{ 'eq__curve--off': !draft.enabled }"
          viewBox="0 0 400 80"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line x1="0" y1="40" x2="400" y2="40" class="eq__zero" />
          <polyline :points="curvePoints" class="eq__line" />
        </svg>

        <div class="eq__bands" :class="{ 'eq__bands--off': !draft.enabled }">
          <div v-for="(frequency, index) in frequencies" :key="frequency" class="eq__band">
            <span class="text-body-small eq__value">{{ gainLabel(draft.gains[index]) }}</span>
            <!-- A native range on a touch screen: Vuetify's slider loses
               - the drag on a real phone (see
               - docs/investigations/phone-and-browser/mobile-volume-slider-ignores-drags.md). -->
            <input
              v-if="coarsePointer"
              type="range"
              class="eq__native"
              :min="-maxGain"
              :max="maxGain"
              :step="step"
              :value="draft.gains[index]"
              :disabled="unavailable"
              :aria-label="bandLabel(frequency)"
              @input="setGain(index, Number(($event.target as HTMLInputElement).value))"
            />
            <!-- No fill: it would grow from -12 dB, while a band's
               - resting place is the middle. -->
            <v-slider
              v-else
              :model-value="draft.gains[index]"
              :min="-maxGain"
              :max="maxGain"
              :step="step"
              :disabled="unavailable"
              :aria-label="bandLabel(frequency)"
              direction="vertical"
              color="primary"
              track-fill-color="transparent"
              density="compact"
              hide-details
              class="eq__slider"
              @update:model-value="setGain(index, $event)"
            />
            <span class="text-body-small text-medium-emphasis">
              {{ frequencyLabel(frequency) }}
            </span>
          </div>
        </div>

        <p v-if="device" class="setting__hint">
          {{ $t(live ? 'equalizer.liveHint' : 'equalizer.speakerHint') }}
        </p>
      </v-card-text>

      <v-card-actions class="eq__actions">
        <v-btn variant="text" :disabled="unavailable || isFlatCurve" @click="pickPreset('flat')">
          {{ $t('equalizer.reset') }}
        </v-btn>
        <v-btn
          v-if="!naming"
          variant="text"
          :disabled="unavailable || selectedPreset !== 'custom'"
          @click="startNaming"
        >
          {{ $t('equalizer.savePreset') }}
        </v-btn>
        <v-btn v-if="canApplyNow" variant="text" color="primary" @click="applyNow">
          {{ $t('equalizer.applyNow') }}
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
import { isCoarsePointer } from '@/services/coarsePointer'
import {
  EQ_FREQUENCIES,
  EQ_MAX_GAIN_DB,
  EQ_PRESETS,
  EQ_PRESET_NAMES,
  EQ_STEP_DB,
  PRESET_NAME_MAX_LENGTH,
  headroomDb,
  isFlat,
  logFrequencies,
  presetOf,
  responseDb,
  sameGains,
  toBands,
  type CustomPreset,
  type EqualizerPreset,
  type EqualizerSetting,
} from '@/services/equalizer'
import type { ConnectDeviceRef } from '@/services/connect/types'

// How long a speaker's curve waits after the last slider movement before it
// is saved and sent: every save goes to the account and, while casting, to
// connect, and a drag would otherwise send one per step. Short, since with
// transitions on the speaker hears it as soon as it arrives.
const SPEAKER_SAVE_DELAY_MS = 200
const CURVE_POINTS = 120
// The drawing's vertical range: one band's whole range either way, plus a
// little, so a single full boost or cut does not touch the edge.
const CURVE_RANGE_DB = 15

/** The equalizer for whatever is playing: the speaker being cast to (one
 * of them, picked here, when there are several), otherwise this device.
 * This device's curve is heard while it is moved. A speaker's is too with
 * transitions on, once the speaker has played what it holds buffered -
 * connect filters the mix live; otherwise from the next song on, or
 * straight away with "Apply now". */
export default {
  name: 'EqualizerDialog',
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
      naming: false,
      presetName: '',
      coarsePointer: isCoarsePointer(),
    }
  },
  computed: {
    store() {
      return useEqualizerStore()
    },
    frequencies(): readonly number[] {
      return EQ_FREQUENCIES
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
    maxGain(): number {
      return EQ_MAX_GAIN_DB
    },
    step(): number {
      return EQ_STEP_DB
    },
    targets(): ConnectDeviceRef[] {
      return useConnectStore().activeTargets.map(({ type, name }) => ({ type, name }))
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
    /** The chip that is lit: a preset, one of the listener's own, or
     * "Custom" for a curve that is neither. */
    selectedPreset(): string {
      const builtIn = presetOf(this.draft.gains)
      if (builtIn) return builtIn
      const own = this.customPresets.find((p) => sameGains(p.gains, this.draft.gains))
      return own ? `custom:${own.name}` : 'custom'
    },
    isFlatCurve(): boolean {
      return isFlat(this.draft.gains)
    },
    curvePoints(): string {
      const bands = toBands({ ...this.draft, enabled: true })
      const headroom = headroomDb(bands)
      return logFrequencies(CURVE_POINTS)
        .map((f, i) => {
          const db = responseDb(bands, f) - headroom
          const x = (i / (CURVE_POINTS - 1)) * 400
          const y =
            40 - (Math.max(-CURVE_RANGE_DB, Math.min(CURVE_RANGE_DB, db)) / CURVE_RANGE_DB) * 40
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    },
    /** A speaker playing a song for this session can be restarted where it
     * is, with the new curve - only needed without transitions. Not a
     * station: those are never equalized (the relay serves every speaker
     * one stream). */
    canApplyNow(): boolean {
      if (!this.device || this.live) return false
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
  },
  beforeUnmount() {
    this.flush()
  },
  methods: {
    keyOf(device: ConnectDeviceRef): string {
      return speakerKey(device)
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
    /** A chip's value: a preset, one of the listener's own, or the
     * "Custom" one, which only ever shows what the curve is. */
    pickPreset(value: string | null | undefined): void {
      if (!value) return
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
    gainLabel(gain: number | undefined): string {
      return gain && gain > 0 ? `+${gain}` : String(gain ?? 0)
    },
    frequencyLabel(frequency: number): string {
      return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
    },
    bandLabel(frequency: number): string {
      return this.$t('equalizer.band', { frequency: this.frequencyLabel(frequency) })
    },
  },
}
</script>

<style scoped>
.eq__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.eq__grow {
  flex: 1;
  min-width: 0;
}

.eq__switch {
  flex: none;
}

.eq__hint {
  margin-bottom: 12px;
}

.eq__targets {
  margin-bottom: 4px;
}

.eq__save {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.eq__actions {
  flex-wrap: wrap;
}

.eq__presets {
  margin-bottom: 8px;
}

.eq__curve {
  display: block;
  width: 100%;
  height: 72px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.eq__zero {
  stroke: rgba(var(--v-theme-on-surface), 0.15);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.eq__line {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.eq__curve--off .eq__line,
.eq__bands--off {
  opacity: 0.45;
}

.eq__bands {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 12px;
}

.eq__band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.eq__value {
  font-variant-numeric: tabular-nums;
}

/* Vuetify gives a vertical slider a 300px minimum, which runs it past the
 * frequency labels; the bands want to be the same height as the native
 * ones below. Vuetify's CSS is layered, so this unlayered rule wins (see
 * base.css). */
.eq__slider {
  flex: none;
  margin: 0;
}

.eq__slider :deep(.v-input__control) {
  min-height: 0;
  height: 160px;
}

.eq__native {
  height: 160px;
  width: 28px;
  writing-mode: vertical-lr;
  direction: rtl;
  accent-color: rgb(var(--v-theme-primary));
}
</style>
