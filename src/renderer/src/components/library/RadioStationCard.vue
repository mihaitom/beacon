<template>
  <div
    class="radio-card"
    :class="{ 'radio-card--row': row, 'radio-card--current': isCurrent }"
    tabindex="0"
    @click="$emit('play', station)"
    @keydown.enter.self="$emit('play', station)"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="hovered = true"
    @blur="hovered = false"
    @contextmenu.prevent="openMenu($event)"
  >
    <div class="radio-card__art">
      <!-- The colour of the logo, cast on the page behind it. -->
      <div v-if="!row" class="radio-card__glow" :style="glowStyle" />
      <!-- One sleeve per station: a station has one logo, so there is
       - nothing to stack or flip through. -->
      <div class="radio-card__sleeve" :style="sleeveStyle">
        <img v-if="hazeSrc" class="radio-card__haze" :src="hazeSrc" alt="" />
        <cover-art
          class="radio-card__logo"
          :radio-favicon="radioFavicon"
          :size="logoSize"
          contain
          fallback-icon="mdi-radio"
          @loaded="onLogoLoaded"
        />
      </div>
      <div v-if="!row" class="radio-card__controls">
        <v-btn
          v-if="canManage"
          class="radio-card__menu radio-card__ghost"
          icon="mdi-dots-vertical"
          :title="$t('common.edit')"
          :aria-label="$t('common.edit')"
          @click.stop="openMenu($event)"
        />
        <v-btn
          class="radio-card__play"
          :icon="onAir ? 'mdi-stop' : 'mdi-play'"
          color="primary"
          variant="flat"
          :title="playLabel"
          :aria-label="playLabel"
          @click.stop="$emit('play', station)"
        />
      </div>
    </div>
    <div class="radio-card__info">
      <div class="radio-card__name">
        <span v-if="onAir" class="radio-card__bars" aria-hidden="true"><i /><i /><i /></span>
        <span class="radio-card__clip">{{ station.name }}</span>
      </div>
      <div class="text-body-small text-medium-emphasis radio-card__line">
        {{ (row ? meta : shortMeta) || '\u00a0' }}
      </div>
      <!-- Keeps its line while the details load, so rows do not shift. -->
      <div class="text-body-medium radio-card__line">{{ titleLine || '\u00a0' }}</div>
      <div class="radio-card__tags">
        <v-chip v-for="tag in tags" :key="tag" size="small" variant="tonal" label>
          {{ tag }}
        </v-chip>
      </div>
    </div>
    <div v-if="row" class="radio-card__actions">
      <v-btn
        color="primary"
        variant="flat"
        :prepend-icon="onAir ? 'mdi-stop' : 'mdi-play'"
        @click.stop="$emit('play', station)"
      >
        {{ playLabel }}
      </v-btn>
      <!-- A button as well as the right-click: editing and deleting are only
       - reachable from here, and a touch screen has no right-click. Gone
       - entirely for an account the server won't let manage stations (see
       - services/capabilities.ts's internetRadioManagement). -->
      <v-btn
        v-if="canManage"
        icon="mdi-dots-vertical"
        variant="text"
        density="comfortable"
        class="radio-card__menu"
        :title="$t('common.edit')"
        :aria-label="$t('common.edit')"
        @click.stop="openMenu($event)"
      />
    </div>
    <tile-context-menu v-if="canManage" ref="menu">
      <context-menu-section :label="$t('library.menuLibrary')" />
      <v-list-item @click="$emit('edit', station)">
        <template #prepend><v-icon icon="mdi-pencil-outline" size="small" /></template>
        <v-list-item-title>{{ $t('common.edit') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('delete', station)">
        <template #prepend><v-icon icon="mdi-delete-outline" size="small" /></template>
        <v-list-item-title>{{ $t('common.delete') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useAuthStore } from '@/stores/auth'
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { useRadioStationInfoStore } from '@/stores/radioStationInfo'
import {
  radioFaviconRequest,
  type RadioFaviconRequest,
  type RadioStationInfo,
} from '@/services/connect/radio'
import { timeAgo } from '@/services/relativeTime'
import { getLocale } from '@/i18n'
import { extractDominantColor } from '@/services/colorExtractor'
import { readLogoLook, type LogoLook } from '@/services/stationLogo'
import type { RadioStation } from '@/types/library'

// 88 lands in the same size step as the player bar's and Now Playing's logo
// (see faviconSizeStep), so one resolved logo serves all of them.
const FAVICON_MIN_SIZE = 88
// How far a logo is enlarged at most: past this a small favicon goes blurry.
const MAX_LOGO_SCALE = 3
const GRID_TAGS = 3

export default {
  name: 'RadioStationCard',
  components: { CoverArt, TileContextMenu, ContextMenuSection },
  props: {
    station: {
      type: Object as PropType<RadioStation>,
      required: true,
    },
    /** The list form: one line per station, its buttons beside it. */
    row: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play', 'edit', 'delete'],
  data() {
    return {
      hovered: false,
      logoSrc: null as string | null,
      look: null as LogoLook | null,
      glow: null as string | null,
    }
  },
  computed: {
    canManage(): boolean {
      return useAuthStore().capabilities.internetRadioManagement
    },
    // Matches on id, not streamUrl — the same station edited to a new URL
    // is still "the same station" for this purpose, and id is what
    // playRadioStation() carries through to playbackStore.radioStation.
    isCurrent(): boolean {
      return usePlaybackStore().radioStation?.id === this.station.id
    },
    onAir(): boolean {
      return this.isCurrent && usePlaybackStore().isPlaying
    },
    playLabel(): string {
      return this.$t(this.onAir ? 'radio.stop' : 'library.play')
    },
    tags(): string[] {
      const tags = this.info?.tags ?? []
      return this.row ? tags : tags.slice(0, GRID_TAGS)
    },
    sleeveStyle(): { backgroundColor: string } | undefined {
      const sleeve = this.look?.sleeve
      return sleeve ? { backgroundColor: `rgb(${sleeve.join(', ')})` } : undefined
    },
    /** A logo with no background of its own to continue stands in front of
     * a blurred copy of itself; the sleeve would be plain grey otherwise. */
    hazeSrc(): string | null {
      return this.look && !this.look.sleeve ? this.logoSrc : null
    },
    logoSize(): string {
      const box = this.row ? '60px' : '62cqi'
      if (!this.look) return box
      const { fill, pixels } = this.look
      // Grown by the margin the image has around the logo, so that it is the
      // logos that come out the same size; the sleeve clips the margin.
      const fitted = `calc(${box} / ${fill})`
      return pixels ? `min(${fitted}, ${pixels * MAX_LOGO_SCALE}px)` : fitted
    },
    /** Which logo the glow should follow; none until it is wanted, so a
     * page of cards reads no colour nobody asked about. */
    glowSource(): string | null {
      return !this.row && (this.hovered || this.isCurrent) ? this.logoSrc : null
    },
    glowStyle(): { backgroundColor: string } | undefined {
      return this.glow ? { backgroundColor: `rgb(${this.glow})` } : undefined
    },
    info(): RadioStationInfo | null {
      return useRadioStationInfoStore().infoFor(this.station)
    },
    // homePageUrl over streamUrl deliberately — the stream host is often a
    // faceless CDN/relay, while the homepage is the station's own
    // recognizable domain. The stream's host only when there is no
    // homepage at all, rather than showing nothing.
    hostname(): string {
      return this.hostnameOf(this.station.homePageUrl || this.station.streamUrl)
    },
    format(): string {
      return [
        this.info?.codec,
        this.info?.bitrate ? this.$t('radio.bitrate', { bitrate: this.info.bitrate }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    },
    meta(): string {
      return [this.hostname, this.info?.country, this.format].filter(Boolean).join(' · ')
    },
    /** A column has no room for the host as well. */
    shortMeta(): string {
      return [this.info?.country, this.format].filter(Boolean).join(' · ') || this.hostname
    },
    /** What is on now for the station playing, else the last title heard
     * on it. */
    titleLine(): string {
      if (this.isCurrent) {
        const now = useRadioMetadataStore().nowPlaying
        return now ? this.$t('radio.nowPlayingLine', { title: now }) : ''
      }
      const last = this.info?.lastTitle
      if (!last) return ''
      const ago = timeAgo(last.at * 1000, Date.now(), getLocale())
      return this.$t('radio.lastHeard', { title: last.title, ago })
    },
    /** The station's logo, or null for a station that has nothing to look
     * one up with. Both halves count: a station added from the discover
     * dialog carries Radio Browser's own favicon URL and may have no
     * homepage at all (see RadioStation.favicon). */
    radioFavicon(): RadioFaviconRequest | null {
      if (!this.station.homePageUrl && !this.station.favicon) return null
      return radioFaviconRequest(
        this.station.homePageUrl ?? '',
        FAVICON_MIN_SIZE,
        this.station.favicon ?? '',
      )
    },
  },
  watch: {
    glowSource(src: string | null) {
      if (src) void this.loadGlow(src)
    },
  },
  methods: {
    async onLogoLoaded(src: string | null): Promise<void> {
      this.logoSrc = src
      this.look = null
      this.glow = null
      if (!src) return
      const look = await readLogoLook(src)
      // Replaced by another logo in the meantime.
      if (src === this.logoSrc) this.look = look
    },
    async loadGlow(src: string): Promise<void> {
      const color = await extractDominantColor(src)
      if (src === this.glowSource) this.glow = color ? color.join(', ') : null
    },
    hostnameOf(url: string): string {
      try {
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        // Not a parseable absolute URL — a malformed saved entry shouldn't
        // crash the row, just show nothing rather than the raw garbage.
        return ''
      }
    },
    openMenu(event: MouseEvent) {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
  },
}
</script>

<style scoped>
.radio-card {
  position: relative;
  /* What the grid's cqi sizes are measured against. */
  container-type: inline-size;
  cursor: pointer;
}

.radio-card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
  border-radius: 4px;
}

.radio-card__art {
  position: relative;
}

.radio-card__glow {
  position: absolute;
  inset: 8% 4% -7%;
  border-radius: 30%;
  filter: blur(44px);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    background-color 0.6s ease;
}

.radio-card:hover .radio-card__glow,
.radio-card:focus-visible .radio-card__glow,
.radio-card--current .radio-card__glow {
  opacity: 0.5;
}

.radio-card__sleeve {
  position: relative;
  display: grid;
  place-items: center;
  width: 100cqi;
  height: 100cqi;
  overflow: hidden;
  border-radius: 4px;
  background-color: rgb(var(--v-theme-surface-bright));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  transition: background-color 0.3s ease;
}

/* Oversized so the blur's faded rim falls outside the sleeve. */
.radio-card__haze {
  position: absolute;
  top: -30%;
  left: -30%;
  width: 160%;
  height: 160%;
  object-fit: cover;
  filter: blur(46px) saturate(1.5);
  opacity: 0.55;
}

/* The sleeve is the backdrop: CoverFrame's own would show through a
 * transparent logo as a second, lighter square. Both classes, to outrank its
 * scoped rule whatever the build order. */
.radio-card__logo.cover-art {
  position: relative;
  background: transparent;
}

.radio-card__controls {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.radio-card:hover .radio-card__controls,
.radio-card:focus-within .radio-card__controls,
.radio-card--current .radio-card__controls {
  opacity: 1;
}

/* Nothing to point with: without this a touch screen never gets the buttons. */
@media (hover: none) {
  .radio-card__controls {
    opacity: 1;
  }
}

.radio-card__play.v-btn,
.radio-card__ghost.v-btn {
  width: 44px;
  height: 44px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}

/* A dark pill whatever the theme: it stands on a logo, not on the page. */
.radio-card__ghost.v-btn {
  background: rgba(10, 11, 16, 0.72);
  color: #fff;
}

.radio-card__info {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-top: 14px;
}

.radio-card__name {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 1.05rem;
  font-weight: 600;
}

.radio-card:hover .radio-card__name,
.radio-card--current .radio-card__name {
  color: rgb(var(--v-theme-primary));
}

.radio-card__clip,
.radio-card__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.radio-card__bars {
  display: inline-flex;
  flex-shrink: 0;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
}

.radio-card__bars i {
  width: 3px;
  height: 100%;
  border-radius: 1px;
  background: rgb(var(--v-theme-primary));
  transform-origin: bottom;
  animation: radio-card-bar 1.1s ease-in-out infinite alternate;
}

.radio-card__bars i:nth-child(1) {
  height: 60%;
}

.radio-card__bars i:nth-child(2) {
  animation-delay: -0.35s;
}

.radio-card__bars i:nth-child(3) {
  height: 40%;
  animation-delay: -0.7s;
}

@keyframes radio-card-bar {
  to {
    transform: scaleY(0.35);
  }
}

/* One line's height even when empty, for the same reason as the title line
 * above it. */
.radio-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  max-height: 24px;
  margin-top: 5px;
  overflow: hidden;
}

/* The list form, PlaylistCard's row. */
.radio-card--row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 20px 14px 14px;
  container-type: normal;
  transition: background 0.15s ease;
}

.radio-card--row + .radio-card--row {
  border-top: 1px solid var(--beacon-hairline);
}

.radio-card--row:hover {
  background: var(--beacon-hover);
}

.radio-card--row .radio-card__art {
  flex-shrink: 0;
}

.radio-card--row .radio-card__sleeve {
  width: 88px;
  height: 88px;
}

.radio-card--row .radio-card__haze {
  filter: blur(18px) saturate(1.5);
}

.radio-card--row .radio-card__info {
  flex: 1 1 auto;
  margin-top: 0;
}

.radio-card--row .radio-card__name {
  font-size: 1.15rem;
}

.radio-card--row .radio-card__tags {
  max-height: none;
  margin-top: 2px;
}

.radio-card__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
}

/* Below this the button would squeeze the name down to a few letters; it
 * goes under the text instead. Same cut as PlaylistCard.vue's. */
@media (max-width: 760px) {
  .radio-card--row {
    flex-wrap: wrap;
  }

  .radio-card__actions {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .radio-card__glow,
  .radio-card__sleeve {
    transition: none;
  }

  .radio-card__bars i {
    animation: none;
  }
}
</style>
