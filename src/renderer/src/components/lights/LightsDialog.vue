<template>
  <v-dialog
    :model-value="modelValue"
    max-width="420"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog">
      <v-card-title class="lights__head">
        <span>{{ $t('lights.title') }}</span>
        <v-switch
          v-if="state?.paired"
          :model-value="state.enabled"
          :disabled="saving"
          :aria-label="$t('lights.enabled')"
          color="primary"
          density="compact"
          hide-details
          class="lights__switch"
          @update:model-value="save({ enabled: !!$event })"
        />
      </v-card-title>

      <v-card-text>
        <p v-if="store.loadFailed && !state" class="setting__hint">
          {{ $t('lights.loadFailed') }}
        </p>

        <!-- Not paired yet: the bridge connect found (or an address typed
           - in), then its button. -->
        <template v-else-if="state && !state.paired">
          <p class="text-body-medium text-medium-emphasis lights__intro">
            {{ $t('lights.pairIntro') }}
          </p>
          <div class="lights__row">
            <v-combobox
              v-model="host"
              :items="foundHosts"
              :label="$t('lights.bridge')"
              :loading="searching"
              :disabled="pairing"
              variant="solo-filled"
              hide-details
              class="lights__grow"
            />
            <v-btn variant="text" :loading="searching" :disabled="pairing" @click="search">
              {{ $t('lights.search') }}
            </v-btn>
          </div>
          <p class="setting__hint">
            {{ pairing ? $t('lights.pressButton') : $t('lights.pairHint') }}
          </p>
          <div class="lights__row lights__pair">
            <v-spacer />
            <v-btn color="primary" :loading="pairing" :disabled="!host || pairing" @click="pair">
              {{ $t('lights.pair') }}
            </v-btn>
          </div>
        </template>

        <template v-else-if="state">
          <lights-stage
            v-if="modelValue"
            :lights="lightCount"
            :light-style="state.style"
            :palette="previewPalette"
            :brightness="brightness / 100"
            :rotate="state.colour_mode === 'rotate'"
            :on="state.enabled"
          />
          <p class="lights__caption">{{ $t('lights.follows') }}</p>

          <div v-if="warning" class="status-row lights__warning">
            <span class="status-dot status-dot--warn" />
            <span class="setting__hint setting__hint--inline">{{ warning }}</span>
          </div>

          <section class="lights__group">
            <h3 class="lights__label">{{ $t('lights.area') }}</h3>
            <div v-if="areas.length" class="lights__areas" role="radiogroup">
              <button
                v-for="area in areas"
                :key="area.id"
                type="button"
                role="radio"
                class="lights__area"
                :class="{ 'lights__area--active': area.id === state.area_id }"
                :aria-checked="area.id === state.area_id"
                :disabled="saving"
                @click="save({ area_id: area.id })"
              >
                <span class="lights__radio" />
                <span class="lights__grow">{{ area.name }}</span>
                <span class="text-medium-emphasis">{{ $t('lights.count', area.lights) }}</span>
              </button>
            </div>
            <p class="setting__hint">
              {{ areas.length ? $t('lights.areaHint') : $t('lights.noAreas') }}
            </p>
          </section>

          <section class="lights__group">
            <h3 class="lights__label">{{ $t('lights.style') }}</h3>
            <div class="lights__styles" role="radiogroup">
              <button
                v-for="option in styles"
                :key="option.value"
                type="button"
                role="radio"
                class="lights__style"
                :class="{ 'lights__style--active': option.value === state.style }"
                :aria-checked="option.value === state.style"
                :disabled="saving"
                @click="save({ style: option.value })"
              >
                <v-icon :icon="option.icon" size="22" />
                <span>{{ $t(`lights.styles.${option.value}.name`) }}</span>
              </button>
            </div>
            <p class="setting__hint lights__style-hint">
              {{ $t(`lights.styles.${state.style}.hint`) }}
            </p>
          </section>

          <section class="lights__group">
            <h3 class="lights__label">{{ $t('lights.colour') }}</h3>
            <segmented-control
              :model-value="state.colour_mode"
              :options="colourModes"
              :label="$t('lights.colour')"
              @update:model-value="saveColourMode"
            />
            <div class="lights__colours">
              <template v-if="state.colour_mode === 'fixed'">
                <button
                  v-for="swatch in swatches"
                  :key="swatch"
                  type="button"
                  class="lights__swatch"
                  :class="{ 'lights__swatch--active': swatch === state.fixed_colour }"
                  :style="{ background: swatch }"
                  :aria-label="swatch"
                  :aria-pressed="swatch === state.fixed_colour"
                  :disabled="saving"
                  @click="save({ fixed_colour: swatch })"
                />
                <label
                  class="lights__swatch lights__custom"
                  :class="{ 'lights__swatch--active': customColour }"
                  :title="$t('lights.customColour')"
                >
                  <input
                    type="color"
                    :value="state.fixed_colour"
                    :aria-label="$t('lights.customColour')"
                    @change="save({ fixed_colour: ($event.target as HTMLInputElement).value })"
                  />
                </label>
              </template>
              <template v-else>
                <span
                  v-for="colour in coverSwatches"
                  :key="colour"
                  class="lights__swatch lights__swatch--static"
                  :style="{ background: colour }"
                />
                <span class="setting__hint setting__hint--inline">{{ coverLine }}</span>
              </template>
            </div>
          </section>

          <section class="lights__group">
            <h3 class="lights__label">{{ $t('lights.brightness') }}</h3>
            <!-- Saved from the brightness watcher, not on @end: Vuetify
               - only sends that at the end of a drag, never for the arrow
               - keys. Not disabled while saving either, which would end a
               - drag that pauses long enough for a save. -->
            <v-slider
              v-model="brightness"
              :min="MIN_BRIGHTNESS"
              :max="100"
              :step="5"
              :aria-label="$t('lights.brightness')"
              color="primary"
              prepend-icon="mdi-brightness-5"
              append-icon="mdi-brightness-7"
              hide-details
            />
          </section>

          <div class="lights__advanced">
            <v-btn
              variant="text"
              size="small"
              :append-icon="showAdvanced ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              :aria-expanded="showAdvanced"
              @click="showAdvanced = !showAdvanced"
            >
              {{ $t('lights.advanced') }}
            </v-btn>
            <v-expand-transition>
              <div v-show="showAdvanced" class="lights__advanced-body">
                <div class="status-row">
                  <span
                    class="status-dot"
                    :class="state.reachable ? 'status-dot--ok' : 'status-dot--warn'"
                  />
                  <span class="setting__hint setting__hint--inline">{{ statusLine }}</span>
                </div>
                <div>
                  <v-text-field
                    v-model="leadInput"
                    :label="$t('lights.lead')"
                    :error="leadInvalid"
                    :disabled="saving"
                    type="number"
                    inputmode="numeric"
                    suffix="ms"
                    variant="solo-filled"
                    hide-details
                    class="lights__lead"
                    @keyup.enter="saveLead"
                    @blur="saveLead"
                  />
                  <p class="setting__hint">{{ $t('lights.leadHint') }}</p>
                </div>
              </div>
            </v-expand-transition>
          </div>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="state?.paired" variant="text" :disabled="saving" @click="forget">
          {{ $t('lights.forget') }}
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
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue'
import {
  discoverBridges,
  type LightsArea,
  type LightsColourMode,
  type LightsState,
  type LightsStyle,
  type LightsUpdate,
} from '@/services/connect/lights'
import { ConnectApiError } from '@/services/connect/http'
import { hexToRgb, rgbToHex, rotation, type Rgb } from '@/services/lights/stagePreview'
import { useLightsStore } from '@/stores/lights'
import LightsStage from './LightsStage.vue'

// connect's own bounds (lights/config.py).
const MAX_LEAD_MS = 1000
const MIN_BRIGHTNESS = 20
// A drag or a held arrow key settles into one save.
const BRIGHTNESS_SAVE_DELAY_MS = 400
// Before the lights have followed any song: the warm white connect falls
// back to for a cover without colour.
const DEFAULT_COLOUR = '#ff9e52'

const STYLES: { value: LightsStyle; icon: string }[] = [
  { value: 'pulse', icon: 'mdi-pulse' },
  { value: 'calm', icon: 'mdi-weather-night' },
  { value: 'party', icon: 'mdi-party-popper' },
  { value: 'wave', icon: 'mdi-wave' },
]

// Saturated on purpose: a light shows a pale colour as white.
const SWATCHES = ['#ff7a2f', '#ff3b5c', '#c13bff', '#3b6bff', '#22c3e6', '#2fe08b', '#ffd23b']

/**
 * Hue lights playing along with the music (connect/lights/): pairing the
 * bridge, then where and how. Everything here is connect's, for the whole
 * installation. Loads afresh on every open.
 */
export default {
  name: 'LightsDialog',
  components: { LightsStage, SegmentedControl },
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      host: '' as string | null,
      searchedHosts: [] as string[],
      searching: false,
      pairing: false,
      saving: false,
      showAdvanced: false,
      leadInput: '' as string | number,
      brightness: 100,
      brightnessTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      styles: STYLES,
      swatches: SWATCHES,
      MIN_BRIGHTNESS,
    }
  },
  computed: {
    store() {
      return useLightsStore()
    },
    state(): LightsState | null {
      return this.store.lights
    },
    areas(): LightsArea[] {
      return this.state?.areas ?? []
    },
    currentArea(): LightsArea | undefined {
      return this.areas.find((a) => a.id === this.state?.area_id)
    },
    foundHosts(): string[] {
      return [...new Set([...(this.state?.found ?? []).map((b) => b.host), ...this.searchedHosts])]
    },
    colourModes(): SegmentedOption[] {
      return (['cover', 'palette', 'rotate', 'fixed'] as const).map((value) => ({
        value,
        title: this.$t(`lights.colourModes.${value}`),
      }))
    },
    lightCount(): number {
      return this.currentArea?.lights ?? 2
    },
    coverSwatches(): string[] {
      const cover = this.state?.picture_colours ?? [DEFAULT_COLOUR]
      const mode = this.state?.colour_mode
      if (mode === 'palette') return cover
      if (mode === 'rotate') return rotation(hexToRgb(cover[0]!), this.lightCount, 0).map(rgbToHex)
      return cover.slice(0, 1)
    },
    coverLine(): string {
      const mode = this.state?.colour_mode
      if (mode === 'rotate') return this.$t('lights.rotateHint')
      if (!this.state?.picture_colours) return this.$t('lights.coverUnknown')
      return mode === 'palette' ? this.$t('lights.paletteHint') : this.$t('lights.coverHint')
    },
    customColour(): boolean {
      return !!this.state && !SWATCHES.includes(this.state.fixed_colour)
    },
    previewPalette(): Rgb[] {
      const mode = this.state?.colour_mode
      if (mode === 'fixed') return [hexToRgb(this.state!.fixed_colour)]
      // The rotation is worked out frame by frame from where it starts.
      if (mode === 'rotate') return [hexToRgb(this.state?.picture_colours?.[0] ?? DEFAULT_COLOUR)]
      return this.coverSwatches.map(hexToRgb)
    },
    /** Something to know before choosing anything. */
    warning(): string {
      const state = this.state
      if (!state?.bridge) return ''
      if (state.reachable === false) {
        return this.$t('lights.unreachable', { host: state.bridge.host })
      }
      if (state.start_error && state.enabled) return this.$t('lights.startFailed')
      return ''
    },
    statusLine(): string {
      const state = this.state
      if (!state?.bridge) return ''
      if (state.reachable === false) {
        return this.$t('lights.unreachable', { host: state.bridge.host })
      }
      if (state.playing) return this.$t('lights.playing')
      return this.$t('lights.connected', { host: state.bridge.host })
    },
    leadValue(): number {
      return Number(String(this.leadInput).trim())
    },
    leadInvalid(): boolean {
      const value = this.leadValue
      return !(Number.isInteger(value) && Math.abs(value) <= MAX_LEAD_MS)
    },
  },
  watch: {
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open) void this.store.load()
      },
    },
    'state.lead_ms': {
      immediate: true,
      handler(lead: number | undefined) {
        if (lead !== undefined) this.leadInput = lead
      },
    },
    'state.brightness': {
      immediate: true,
      handler(value: number | undefined) {
        if (value !== undefined) this.brightness = value
      },
    },
    brightness(value: number) {
      clearTimeout(this.brightnessTimer)
      if (!this.state || value === this.state.brightness) return
      this.brightnessTimer = setTimeout(
        () => void this.save({ brightness: value }),
        BRIGHTNESS_SAVE_DELAY_MS,
      )
    },
    foundHosts(hosts: string[]) {
      if (!this.host && hosts.length) this.host = hosts[0]!
    },
  },
  unmounted() {
    clearTimeout(this.brightnessTimer)
  },
  methods: {
    async search() {
      this.searching = true
      try {
        const found = await discoverBridges()
        this.searchedHosts = found.map((b) => b.host)
        if (!found.length) this.toast('information', this.$t('lights.noneFound'))
      } catch (error) {
        console.error('[lights] Bridge search failed:', error)
        this.toast('error', this.$t('lights.searchFailed'))
      } finally {
        this.searching = false
      }
    },
    async pair() {
      if (!this.host) return
      const host = this.host.trim()
      this.pairing = true
      try {
        await this.store.pair(host)
      } catch (error) {
        const detail =
          error instanceof ConnectApiError && error.body && typeof error.body === 'object'
            ? (error.body as { detail?: string }).detail
            : undefined
        const message =
          detail === 'link_button'
            ? this.$t('lights.buttonTimeout')
            : detail === 'no_bridge'
              ? this.$t('lights.noBridge', { host })
              : this.$t('lights.pairFailed')
        this.toast('error', message)
        console.error('[lights] Pairing failed:', error)
      } finally {
        this.pairing = false
      }
    },
    async save(update: LightsUpdate) {
      this.saving = true
      try {
        await this.store.update(update)
      } catch (error) {
        console.error('[lights] Could not save:', error)
        this.toast('error', this.$t('lights.saveFailed'))
        // Back to what connect has, not what was dragged to.
        if (this.state) this.brightness = this.state.brightness
      } finally {
        this.saving = false
      }
    },
    saveColourMode(mode: string) {
      void this.save({ colour_mode: mode as LightsColourMode })
    },
    async saveLead() {
      if (this.leadInvalid || this.leadValue === this.state?.lead_ms) return
      await this.save({ lead_ms: this.leadValue })
    },
    async forget() {
      this.saving = true
      try {
        await this.store.forget()
      } catch (error) {
        console.error('[lights] Could not forget the bridge:', error)
        this.toast('error', this.$t('lights.saveFailed'))
      } finally {
        this.saving = false
      }
    },
    toast(level: 'error' | 'information', message: string) {
      this.$emitter.emit('toast', { level, title: this.$t('lights.title'), message })
    },
  },
}
</script>

<style scoped>
.lights__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lights__switch {
  flex: none;
}

.lights__intro {
  margin-bottom: 16px;
}

.lights__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lights__grow {
  flex: 1;
  min-width: 0;
}

.lights__pair {
  margin-top: 12px;
}

.lights__caption {
  margin: 6px 0 18px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.lights__warning {
  margin-bottom: 18px;
}

.lights__group {
  margin-bottom: 20px;
}

/* A quiet label rather than .eyebrow-label: amber here would put five
 * accents in one small dialog, and the accent is for signal. */
.lights__label {
  margin: 0 0 8px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

/* Plain buttons need the browser's own face taken off first. */
.lights__area,
.lights__style,
.lights__swatch {
  appearance: none;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.lights__areas {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--beacon-hairline);
  border-radius: 10px;
  overflow: hidden;
}

.lights__area {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  text-align: left;
  transition: background 0.15s ease;
}

.lights__area + .lights__area {
  border-top: 1px solid var(--beacon-hairline);
}

.lights__area:hover {
  background: var(--beacon-hover);
}

.lights__radio {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(var(--v-theme-on-surface), 0.35);
}

.lights__area--active .lights__radio {
  border-color: rgb(var(--v-theme-primary));
  background: radial-gradient(circle, rgb(var(--v-theme-primary)) 40%, transparent 45%);
}

.lights__styles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.lights__style {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 4px 8px;
  border: 1px solid var(--beacon-hairline);
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.02);
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.7);
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.lights__style:hover {
  background: var(--beacon-hover);
}

.lights__style--active {
  border-color: rgba(var(--v-theme-primary), 0.8);
  background: rgba(var(--v-theme-primary), 0.08);
  color: rgb(var(--v-theme-on-surface));
}

.lights__style--active .v-icon {
  color: rgb(var(--v-theme-primary));
}

/* Two lines for every style, so switching does not move what is below. */
.lights__style-hint {
  min-height: 2.7em;
}

.lights__colours {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  min-height: 30px;
}

.lights__swatch {
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 50%;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s ease;
}

.lights__swatch--active {
  outline-color: rgba(var(--v-theme-on-surface), 0.85);
}

.lights__swatch--static {
  cursor: default;
}

.lights__custom {
  position: relative;
  overflow: hidden;
  background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
}

.lights__custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.lights__advanced {
  border-top: 1px solid var(--beacon-hairline);
  padding-top: 8px;
}

.lights__advanced-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 0 4px;
}

/* A few digits; full width would read as a text box. */
.lights__lead {
  max-width: 180px;
}
</style>
