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
            :song="previewSong"
            :clock="previewClock"
          />
          <p class="lights__caption">
            {{ $t('lights.follows') }}
            {{ $t(livePreview ? 'lights.previewLive' : 'lights.previewMadeUp') }}
          </p>

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
            <!-- Cards like the styles above, each with what it would give
               - right now as its chip; what it is made of below. -->
            <div class="lights__styles" role="radiogroup" :aria-label="$t('lights.colour')">
              <button
                v-for="mode in colourModes"
                :key="mode"
                type="button"
                role="radio"
                class="lights__style"
                :class="{ 'lights__style--active': mode === state.colour_mode }"
                :aria-checked="mode === state.colour_mode"
                :disabled="saving"
                @click="saveColourMode(mode)"
              >
                <span class="lights__chip" :style="chipStyle(mode)" />
                <span>{{ $t(`lights.colourModes.${mode}`) }}</span>
              </button>
            </div>

            <div class="lights__detail">
              <div v-if="state.colour_mode === 'theme'" class="lights__detail-row">
                <span class="lights__swatch" :style="{ background: themeLight }" />
                <div>
                  <div class="text-body-medium">{{ themeName }}</div>
                  <div class="setting__hint setting__hint--inline">
                    {{ themeLine }}
                  </div>
                </div>
              </div>

              <template v-else-if="state.colour_mode === 'palette'">
                <div class="lights__detail-row">
                  <img v-if="pictureThumb" :src="pictureThumb" alt="" class="lights__thumb" />
                  <div>
                    <div v-if="state.picture" class="text-body-medium">
                      {{ $t(`lights.paletteFrom.${state.picture.source}`) }}
                    </div>
                    <div class="lights__swatches">
                      <span
                        v-for="colour in paletteColours"
                        :key="colour"
                        class="lights__swatch"
                        :style="{ background: colour }"
                      />
                    </div>
                  </div>
                </div>
                <p class="setting__hint">{{ paletteLine }}</p>
              </template>

              <div v-else-if="state.colour_mode === 'rotate'" class="lights__detail-row">
                <lights-colour-wheel
                  v-if="modelValue"
                  :start="hexToRgb(paletteColours[0]!)"
                  :lights="lightCount"
                  :song="previewSong"
                  :clock="previewClock"
                />
                <p class="setting__hint setting__hint--inline">{{ $t('lights.rotateHint') }}</p>
              </div>

              <template v-else>
                <!-- A native range rather than v-slider, whose drag gets
                   - lost on real touch screens (see TouchVolumeSlider). Hue
                   - only: a lamp shows a pale colour as white. -->
                <input
                  v-model.number="hue"
                  type="range"
                  min="0"
                  max="359"
                  step="1"
                  class="lights__hue"
                  :style="{ '--hue-colour': hueColour }"
                  :aria-label="$t('lights.hue')"
                />
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
import { markRaw } from 'vue'
import {
  discoverBridges,
  getSongAnalysis,
  type LightsArea,
  type LightsColourMode,
  type LightsState,
  type LightsStyle,
  type LightsUpdate,
} from '@/services/connect/lights'
import { ConnectApiError } from '@/services/connect/http'
import { fanartImageUrl } from '@/services/connect/fanart'
import {
  MADE_UP_SONG,
  analysedSong,
  fromHue,
  hexToRgb,
  hueOf,
  playbackClock,
  previewTime,
  rgbToHex,
  type PreviewSong,
  type Rgb,
} from '@/services/lights/stagePreview'
import { useAppearanceStore } from '@/stores/appearance'
import { useLibraryStore } from '@/stores/library'
import { themeColour, themeSettings, useLightsStore } from '@/stores/lights'
import { usePlaybackStore } from '@/stores/playback'
import LightsColourWheel from './LightsColourWheel.vue'
import LightsStage from './LightsStage.vue'

// connect's own bounds (lights/config.py).
const MAX_LEAD_MS = 1000
const MIN_BRIGHTNESS = 20
// A drag or a held arrow key settles into one save - the brightness and
// the hue alike.
const SAVE_DELAY_MS = 400
const COLOUR_MODES: LightsColourMode[] = ['theme', 'palette', 'rotate', 'fixed']
const THUMB_SIZE = 112
// While open, how often the picture is asked for again: a track change
// shows its picture within this.
const PICTURE_REFRESH_MS = 2000
// While connect is still analysing the playing song (1-2 s for a pop
// song), how often the preview asks again.
const ANALYSIS_POLL_MS = 1000
// The rotation's chip: the whole wheel, as its detail shows.
const WHEEL = 'conic-gradient(#ff3b3b, #ffd23b, #3bff6b, #3bd8ff, #3b5bff, #d43bff, #ff3b3b)'

const STYLES: { value: LightsStyle; icon: string }[] = [
  { value: 'pulse', icon: 'mdi-pulse' },
  { value: 'calm', icon: 'mdi-weather-night' },
  { value: 'party', icon: 'mdi-party-popper' },
  { value: 'chase', icon: 'mdi-chevron-triple-right' },
]

/**
 * Hue lights playing along with the music (connect/lights/): pairing the
 * bridge, then where and how. Everything here is connect's, for the whole
 * installation. Loads afresh on every open.
 */
export default {
  name: 'LightsDialog',
  components: { LightsColourWheel, LightsStage },
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
      hue: 0,
      hueTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      pictureTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      analysisTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      liveSong: null as { id: string; song: PreviewSong } | null,
      gone: false,
      colourModes: COLOUR_MODES,
      styles: STYLES,
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
    lightCount(): number {
      return this.currentArea?.lights ?? 2
    },
    /** The picture's colours, or the theme's in place of none - what
     * connect lights with in "palette", and where "rotate" starts. */
    paletteColours(): string[] {
      const colours = this.state?.picture?.colours
      return colours?.length ? colours : [this.state?.theme_colour ?? themeColour()]
    },
    paletteLine(): string {
      const picture = this.state?.picture
      if (!picture) return this.$t('lights.paletteUnknown')
      if (!picture.colours.length) return this.$t('lights.paletteGrey')
      return this.$t('lights.paletteCount', picture.colours.length)
    },
    pictureThumb(): string | null {
      const picture = this.state?.picture
      if (!picture) return null
      if (picture.url) return fanartImageUrl(picture.url)
      if (!picture.cover_art_id) return null
      try {
        return useLibraryStore().client().coverArtUrl(picture.cover_art_id, THUMB_SIZE)
      } catch {
        return null // not signed in to a server here
      }
    },
    /** What "theme" lights with: the picture's strongest colour where the
     * app's accent follows the picture (Settings -> Appearance), else the
     * theme's accent. */
    themeLight(): string {
      const state = this.state!
      const colours = state.picture?.colours
      if (state.theme_follows_picture && colours?.length) return colours[0]!
      return state.theme_colour
    },
    themeLine(): string {
      return this.$t(
        this.state?.theme_follows_picture ? 'lights.themeFollowsPicture' : 'lights.themeHint',
      )
    },
    themeName(): string {
      return this.$t(`settings.themes.${useAppearanceStore().theme}.name`)
    },
    /** The song the preview plays along with: whatever plays here, paused
     * or radio aside. */
    playingSongId(): string | null {
      if (!this.modelValue || !this.state?.paired) return null
      const playback = usePlaybackStore()
      if (!playback.isPlaying || playback.radioStation) return null
      return playback.currentSong?.id ?? null
    },
    livePreview(): boolean {
      return !!this.liveSong && this.liveSong.id === this.playingSongId
    },
    previewSong(): PreviewSong {
      return this.livePreview ? this.liveSong!.song : MADE_UP_SONG
    },
    /** Seconds into the preview's song: the playing song's position, or
     * the made-up song's own clock. */
    previewClock(): (now: number) => number {
      if (!this.livePreview) return previewTime
      const follow = playbackClock()
      const playback = usePlaybackStore()
      return (now) => follow(now, playback.localPosition, playback.isPlaying)
    },
    hueColour(): string {
      return rgbToHex(fromHue(this.hue / 360))
    },
    previewPalette(): Rgb[] {
      const mode = this.state?.colour_mode
      if (mode === 'fixed') return [hexToRgb(this.state!.fixed_colour)]
      if (mode === 'theme') return [hexToRgb(this.themeLight)]
      // The rotation is worked out frame by frame from where it starts.
      if (mode === 'rotate') return [hexToRgb(this.paletteColours[0]!)]
      return this.paletteColours.map(hexToRgb)
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
      async handler(open: boolean) {
        clearTimeout(this.pictureTimer)
        if (!open) return
        await this.store.load()
        // Somebody is setting the lights up here: this device's theme.
        await this.store.syncTheme()
        this.followPicture()
      },
    },
    'state.fixed_colour': {
      immediate: true,
      handler(colour: string | undefined) {
        if (colour) this.hue = Math.round(hueOf(hexToRgb(colour)) * 360) % 360
      },
    },
    hue(value: number) {
      clearTimeout(this.hueTimer)
      const colour = rgbToHex(fromHue(value / 360))
      if (!this.state || colour === this.state.fixed_colour) return
      // A stored colour's own hue rounds to one a step off it; leave it be.
      if (Math.round(hueOf(hexToRgb(this.state.fixed_colour)) * 360) % 360 === value) return
      this.hueTimer = setTimeout(() => void this.save({ fixed_colour: colour }), SAVE_DELAY_MS)
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
      this.brightnessTimer = setTimeout(() => void this.save({ brightness: value }), SAVE_DELAY_MS)
    },
    playingSongId: {
      immediate: true,
      handler(id: string | null) {
        clearTimeout(this.analysisTimer)
        if (id && this.liveSong?.id !== id) void this.loadAnalysis(id)
      },
    },
    foundHosts(hosts: string[]) {
      if (!this.host && hosts.length) this.host = hosts[0]!
    },
  },
  unmounted() {
    clearTimeout(this.brightnessTimer)
    clearTimeout(this.hueTimer)
    clearTimeout(this.pictureTimer)
    clearTimeout(this.analysisTimer)
    this.gone = true
  },
  methods: {
    /** Keeps the picture current while open: the track may change under
     * the dialog. */
    followPicture() {
      clearTimeout(this.pictureTimer)
      this.pictureTimer = setTimeout(async () => {
        if (!this.modelValue || this.gone) return
        await this.store.refreshPicture()
        // Closed or gone while it was asked for: that is the end of it.
        if (this.modelValue && !this.gone) this.followPicture()
      }, PICTURE_REFRESH_MS)
    },
    /** connect's analysis of the playing song, asked for again until it
     * is done. Until then, and for a song it could not analyse, the
     * preview plays the made-up song. */
    async loadAnalysis(songId: string) {
      let reply: Awaited<ReturnType<typeof getSongAnalysis>> | null = null
      try {
        reply = await getSongAnalysis(songId)
      } catch (error) {
        console.error('[lights] Could not load the song for the preview:', error)
      }
      if (this.gone || this.playingSongId !== songId) return
      if (reply?.status === 'ready') {
        this.liveSong = { id: songId, song: markRaw(analysedSong(reply)) }
      } else if (reply?.status === 'pending') {
        this.analysisTimer = setTimeout(() => void this.loadAnalysis(songId), ANALYSIS_POLL_MS)
      }
    },
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
    saveColourMode(mode: LightsColourMode) {
      // Theme: the theme this is being chosen on.
      void this.save(
        mode === 'theme' ? { colour_mode: mode, ...themeSettings() } : { colour_mode: mode },
      )
    },
    /** Each mode's card shows what it would light with right now. */
    chipStyle(mode: LightsColourMode): Record<string, string> {
      const state = this.state!
      if (mode === 'theme') return { background: this.themeLight }
      if (mode === 'fixed') return { background: state.fixed_colour }
      if (mode === 'rotate') return { background: WHEEL }
      const colours = this.paletteColours
      const share = 100 / colours.length
      const stops = colours.map((c, i) => `${c} ${i * share}% ${(i + 1) * share}%`)
      return { background: `conic-gradient(${stops.join(', ')})` }
    },
    hexToRgb,
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

.lights__chip {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.12);
}

/* What the chosen colour mode is made of, on a surface of its own so it
 * reads as belonging to the card picked above. */
.lights__detail {
  margin-top: 10px;
  padding: 12px;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface-bright));
  min-height: 84px;
}

.lights__detail-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lights__thumb {
  flex: none;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
}

.lights__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.lights__swatch {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.12);
}

/* The hue band: the whole wheel laid flat, the thumb in the colour it
 * picks. Its own look in both engines, since neither styles a range's
 * track like this by default. */
.lights__hue {
  appearance: none;
  display: block;
  width: 100%;
  height: 26px;
  margin: 0;
  border-radius: 13px;
  background: linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000);
  cursor: pointer;
}

.lights__hue::-webkit-slider-thumb {
  appearance: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 3px solid #fff;
  background: var(--hue-colour);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
}

.lights__hue::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 3px solid #fff;
  background: var(--hue-colour);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
}

.lights__hue:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
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
