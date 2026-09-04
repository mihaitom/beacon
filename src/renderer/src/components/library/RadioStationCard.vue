<template>
  <div
    class="radio-tile"
    :class="{ 'radio-tile--current': isCurrent }"
    @click="$emit('play', station)"
  >
    <div class="radio-tile__cover-wrap">
      <!-- Smaller and to the side, unlike AlbumCard.vue/ArtistCard.vue's own
       - big cover-on-top layout — a station's favicon is rarely artwork
       - worth the same real estate an album cover gets, and a horizontal
       - tile with a bordered/tinted background (see .radio-tile below,
       - same chrome as StatsView.vue's own .stat-tile) reads as its own
       - kind of thing at a glance instead of a smaller, blurrier album
       - grid. -->
      <!-- No `rounded` prop — same default 4px-square treatment
       - PlayerBar.vue/SongInfo.vue/NowPlayingView.vue's own radio favicons
       - already use everywhere else in the app, not CoverArt.vue's oddly-
       - named `rounded` (a literal square v-avatar, no radius at all —
       - see that component's own comment). -->
      <cover-art
        :radio-favicon="station.homePageUrl ? faviconRequest(station.homePageUrl, 48) : null"
        :size="48"
        fallback-icon="mdi-radio"
      />
      <!-- Hover-reveal on desktop, same idea as AlbumCard.vue's own play
       - overlay — but pinned visible for the station actually playing right
       - now (see RadioView.vue's own comment on why this can't be
       - hover-only for that state), with a volume icon in place of play so
       - "playing" reads differently from "click to play". -->
      <div
        class="radio-tile__cover-overlay"
        :class="{ 'radio-tile__cover-overlay--current': isCurrent }"
      >
        <v-icon :icon="isCurrent ? 'mdi-volume-high' : 'mdi-play'" size="18" color="white" />
      </div>
    </div>
    <div class="radio-tile__info">
      <div
        class="text-body-medium text-truncate radio-tile__name"
        :class="{ 'text-primary': isCurrent }"
      >
        {{ station.name }}
      </div>
      <!-- The raw stream URL used to sit here — accurate, but the kind of
       - detail nobody actually browses a station grid for. The site the
       - station belongs to reads as an actual caption instead; a station
       - with none just omits the line rather than falling back to the
       - stream URL anyway. -->
      <div v-if="hostname" class="text-body-small text-medium-emphasis text-truncate">
        {{ hostname }}
      </div>
    </div>
    <!-- Not hover-gated like AlbumCard.vue's own corner star — this is
     - reused verbatim on mobile (MobileRadioView.vue, no hover there at
     - all), and edit/delete is the one thing a tile needs to offer beyond
     - play, so it has to stay reachable by a plain tap. -->
    <v-btn
      icon="mdi-dots-vertical"
      variant="text"
      density="comfortable"
      size="small"
      class="radio-tile__menu"
      :title="$t('common.edit')"
      @click.stop="openMenu($event)"
    />
    <v-menu v-model="menuOpen" :target="menuTarget">
      <v-list density="compact">
        <v-list-item @click="$emit('edit', station)">
          <template #prepend><v-icon icon="mdi-pencil-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.edit') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="$emit('delete', station)">
          <template #prepend><v-icon icon="mdi-delete-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.delete') }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from './CoverArt.vue'
import { usePlaybackStore } from '@/stores/playback'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import type { RadioStation } from '@/types/library'

export default {
  name: 'RadioStationCard',
  components: { CoverArt },
  props: {
    station: {
      type: Object as PropType<RadioStation>,
      required: true,
    },
  },
  emits: ['play', 'edit', 'delete'],
  data() {
    return {
      menuOpen: false,
      menuTarget: [0, 0] as [number, number],
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    // Matches on id, not streamUrl — the same station edited to a new URL
    // is still "the same station" for this purpose, and id is what
    // playRadioStation() actually carries through to playbackStore.radioStation.
    isCurrent(): boolean {
      return this.playbackStore.radioStation?.id === this.station.id
    },
    // homePageUrl over streamUrl deliberately — the stream host is often a
    // faceless CDN/relay (icecast mirrors, streaming providers), while the
    // homepage is the station's own recognizable domain. Falls back to the
    // stream URL's own host only when there's no homepage at all, rather
    // than showing nothing.
    hostname(): string {
      return this.hostnameOf(this.station.homePageUrl || this.station.streamUrl)
    },
  },
  methods: {
    faviconRequest(homePageUrl: string, minSize = 0): RadioFaviconRequest {
      return radioFaviconRequest(homePageUrl ?? '', minSize, this.station.favicon ?? '')
    },
    hostnameOf(url: string): string {
      try {
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        // Not a parseable absolute URL — a malformed saved entry shouldn't
        // crash the tile, just show nothing rather than the raw garbage.
        return ''
      }
    },
    openMenu(event: MouseEvent) {
      this.menuTarget = [event.clientX, event.clientY]
      this.menuOpen = true
    },
  },
}
</script>

<style scoped>
/* Same bordered/tinted chrome as StatsView.vue's own .stat-tile — a
 * horizontal box rather than AlbumCard.vue/ArtistCard.vue's bare
 * cover-plus-caption, deliberately: this grid sits right next to those in
 * the app's mental model (another browse-your-library screen) and needed
 * to *not* read as a smaller, blurrier version of the same card. */
.radio-tile {
  display: flex;
  align-items: center;
  width: 300px;
  padding: 10px 8px 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--beacon-hairline);
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.radio-tile:hover {
  background: var(--beacon-hover);
}

.radio-tile--current {
  background: rgba(var(--v-theme-primary), 0.08);
  border-color: rgba(var(--v-theme-primary), 0.35);
}

.radio-tile--current:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.radio-tile__cover-wrap {
  position: relative;
  flex-shrink: 0;
  margin-right: 12px;
}

.radio-tile__cover-overlay {
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

.radio-tile:hover .radio-tile__cover-overlay,
.radio-tile__cover-overlay--current {
  opacity: 1;
}

.radio-tile__info {
  flex: 1 1 auto;
  min-width: 0;
}

.radio-tile__name {
  font-weight: 500;
}

.radio-tile__menu {
  flex-shrink: 0;
  margin-left: 2px;
}

/* Below this the fixed 300px tile stops filling the row — a single narrow
 * column with a dead gutter beside it, rather than the full-width tap
 * target every other mobile list row in the app (mobile-song-row,
 * mobile-playlist-row) already gives you. Same 600px cutoff as
 * releaseNotes.vue's own phone breakpoint. */
@media (max-width: 600px) {
  .radio-tile {
    width: 100%;
  }
}
</style>
