<template>
  <div
    class="radio-row"
    :class="{ 'radio-row--current': isCurrent }"
    @click="$emit('play', station)"
    @contextmenu.prevent="openMenu($event)"
  >
    <div class="radio-row__logo">
      <!-- No `rounded` prop: the same 4px square every other radio logo in
       - the app gets (PlayerBar.vue, NowPlayingView.vue), not CoverArt.vue's
       - oddly-named `rounded` (a square v-avatar, no radius at all). -->
      <cover-art :radio-favicon="radioFavicon" :size="LOGO_SIZE" fallback-icon="mdi-radio" />
      <!-- Pinned for the station that is playing, with a volume icon in
       - place of play, so "playing" reads differently from "click to
       - play". -->
      <div
        class="radio-row__logo-overlay"
        :class="{ 'radio-row__logo-overlay--current': isCurrent }"
      >
        <v-icon :icon="isCurrent ? 'mdi-volume-high' : 'mdi-play'" size="28" color="white" />
      </div>
    </div>
    <div class="radio-row__info">
      <div class="radio-row__name" :class="{ 'text-primary': isCurrent }">{{ station.name }}</div>
      <div class="text-body-small text-medium-emphasis radio-row__line">
        {{ meta || ' ' }}
      </div>
      <!-- Keeps its line while the details load, so rows do not shift. -->
      <div class="text-body-medium radio-row__line">{{ titleLine || ' ' }}</div>
      <div class="radio-row__tags">
        <v-chip v-for="tag in info?.tags ?? []" :key="tag" size="small" variant="tonal" label>
          {{ tag }}
        </v-chip>
      </div>
    </div>
    <div class="radio-row__actions">
      <v-btn
        color="primary"
        :variant="isCurrent ? 'tonal' : 'flat'"
        :prepend-icon="isCurrent ? 'mdi-volume-high' : 'mdi-play'"
        @click.stop="$emit('play', station)"
      >
        {{ isCurrent ? $t('radio.playing') : $t('library.play') }}
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
        class="radio-row__menu"
        :title="$t('common.edit')"
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
import type { RadioStation } from '@/types/library'

const LOGO_SIZE = 88

export default {
  name: 'RadioStationRow',
  components: { CoverArt, TileContextMenu, ContextMenuSection },
  props: {
    station: {
      type: Object as PropType<RadioStation>,
      required: true,
    },
  },
  emits: ['play', 'edit', 'delete'],
  data() {
    return { LOGO_SIZE }
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
    meta(): string {
      const format = [
        this.info?.codec,
        this.info?.bitrate ? this.$t('radio.bitrate', { bitrate: this.info.bitrate }) : '',
      ]
        .filter(Boolean)
        .join(' ')
      return [this.hostname, this.info?.country, format].filter(Boolean).join(' · ')
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
        LOGO_SIZE,
        this.station.favicon ?? '',
      )
    },
  },
  methods: {
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
/* Same row as PlaylistRow.vue's, in the same flush panel - see
 * docs/styleguide.md's Lists section. */
.radio-row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 20px 14px 14px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.radio-row + .radio-row {
  border-top: 1px solid var(--beacon-hairline);
}

.radio-row:hover {
  background: var(--beacon-hover);
}

.radio-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.radio-row--current:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.radio-row__logo {
  position: relative;
  flex-shrink: 0;
}

.radio-row__logo-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: rgba(11, 13, 19, 0.45);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.radio-row:hover .radio-row__logo-overlay,
.radio-row__logo-overlay--current {
  opacity: 1;
}

.radio-row__info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.radio-row__name {
  font-size: 1.15rem;
  font-weight: 600;
}

.radio-row__name,
.radio-row__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* One line's height even when empty, for the same reason as the title
 * line above it. */
.radio-row__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  margin-top: 2px;
}

.radio-row__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
}

/* Below this the button would squeeze the name down to a few letters; it
 * goes under the text instead. Same cut as PlaylistRow.vue's. */
@media (max-width: 760px) {
  .radio-row {
    flex-wrap: wrap;
  }

  .radio-row__actions {
    width: 100%;
  }
}
</style>
