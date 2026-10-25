<template>
  <section class="smart-preview beacon-panel" :aria-label="$t('smartPlaylists.preview')">
    <h2 class="eyebrow-label panel-title">{{ $t('smartPlaylists.preview') }}</h2>

    <div v-if="!preview" class="smart-preview__loading">
      <v-progress-circular indeterminate size="28" color="primary" />
    </div>

    <template v-else>
      <div class="smart-preview__count">
        <span class="smart-preview__number">{{ $n(shownCount) }}</span>
        <span class="smart-preview__unit">{{ songsWord }}</span>
      </div>
      <div class="text-body-small text-medium-emphasis smart-preview__meta">
        <template v-if="durationLabel">{{ durationLabel }}</template>
        <template v-if="limited"> · {{ $t('smartPlaylists.limit') }} {{ limit }}</template>
      </div>
      <div v-if="preview.uncertain" class="smart-preview__uncertain text-body-small">
        <span>{{ $t('smartPlaylists.uncertain', { count: $n(preview.uncertain) }) }}</span>
        <v-tooltip :text="$t('smartPlaylists.uncertainHint')" location="top" open-on-click>
          <template #activator="{ props: tooltipProps }">
            <v-btn
              v-bind="tooltipProps"
              icon="mdi-information-outline"
              variant="text"
              size="x-small"
              :aria-label="$t('smartPlaylists.uncertainHint')"
            />
          </template>
        </v-tooltip>
      </div>

      <div v-if="covers.length" class="smart-preview__mosaic">
        <cover-art
          v-for="id in covers"
          :key="id"
          :cover-art-id="id"
          size="100%"
          class="smart-preview__tile"
        />
      </div>

      <ol v-if="preview.songs.length" class="smart-preview__songs">
        <li v-for="song in firstSongs" :key="song.id" class="smart-preview__song">
          <button
            type="button"
            class="smart-preview__song-button"
            :aria-label="`${$t('library.play')}: ${song.title}`"
            @click="play(song)"
          >
            <span class="smart-preview__song-cover">
              <cover-art :cover-art-id="song.coverArtId" :size="36" />
              <v-icon icon="mdi-play" size="20" class="smart-preview__song-play" />
            </span>
            <span class="smart-preview__song-text">
              <span class="smart-preview__title" :title="song.title">{{ song.title }}</span>
              <!-- Unlinked: the whole row is a button already. -->
              <artist-credit
                :credit="song.artist"
                :artist-id="song.artistId"
                :linked="false"
                class="smart-preview__artist text-body-small text-medium-emphasis"
              />
            </span>
          </button>
        </li>
      </ol>
      <div
        v-if="preview.songs.length > firstSongs.length"
        class="text-body-small text-medium-emphasis smart-preview__more"
      >
        {{ $t('smartPlaylists.andMore', { count: $n(preview.songs.length - firstSongs.length) }) }}
      </div>

      <div v-if="!preview.songs.length && !preview.uncertain" class="smart-preview__empty">
        <v-icon icon="mdi-playlist-remove" size="32" class="smart-preview__empty-icon" />
        <p>{{ hasRules ? $t('smartPlaylists.empty') : $t('smartPlaylists.noRulesYet') }}</p>
        <p v-if="preview.emptiedBy !== null" class="text-body-small text-medium-emphasis">
          {{ $t('smartPlaylists.emptiedBy') }}
        </p>
      </div>

      <p class="text-body-small text-medium-emphasis smart-preview__note">
        {{ $t('smartPlaylists.previewNote') }}
      </p>
    </template>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import ArtistCredit from '@/components/library/ArtistCredit.vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { formatTotalDuration } from '@/services/totalDuration'
import type { Preview } from '@/services/navidrome/preview'
import { usePlaybackStore } from '@/stores/playback'
import type { Song } from '@/types/library'

/** How many songs the list shows before "and N more". */
const LISTED_SONGS = 8
/** A 3x2 mosaic: enough to tell the playlist's character at a glance. */
const MOSAIC_TILES = 6

/**
 * What the rules would pick, estimated while they are being written: the
 * count, the albums it draws from, the first songs. An empty result says
 * which rule emptied it (the view marks that rule), and songs the preview
 * cannot judge are counted apart with the reason behind a tooltip.
 */
export default {
  name: 'SmartPreviewPanel',
  components: { ArtistCredit, CoverArt },
  props: {
    /** Null while the catalogue is still loading. */
    preview: { type: Object as PropType<Preview | null>, default: null },
    limit: { type: Number as PropType<number | null>, default: null },
    hasRules: { type: Boolean, default: true },
  },
  computed: {
    shownCount(): number {
      return this.preview?.songs.length ?? 0
    },
    /** The word alone: the number sits beside it, larger. */
    songsWord(): string {
      return this.$t('smartPlaylists.songsUnit', this.shownCount)
    },
    limited(): boolean {
      return this.limit !== null && (this.preview?.matched ?? 0) > this.limit
    },
    durationLabel(): string {
      const seconds = this.preview?.songs.reduce((total, song) => total + song.duration, 0) ?? 0
      return seconds ? formatTotalDuration(seconds, this.$t) : ''
    },
    /** One cover per album, in the order the songs come. */
    covers(): string[] {
      const ids: string[] = []
      const albums = new Set<string>()
      for (const song of this.preview?.songs ?? []) {
        if (!song.coverArtId || albums.has(song.albumId)) continue
        albums.add(song.albumId)
        ids.push(song.coverArtId)
        if (ids.length === MOSAIC_TILES) break
      }
      return ids
    },
    firstSongs() {
      return this.preview?.songs.slice(0, LISTED_SONGS) ?? []
    },
  },
  methods: {
    /** Only the clicked song, as for any playlist being edited: the preview
     * is a guess at what the rules pick, not a queue anybody meant. */
    play(song: Song) {
      void usePlaybackStore().playSongList([song], 0)
    },
  },
}
</script>

<style scoped>
.smart-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.smart-preview__loading {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}

/* The count is the answer the whole page is asking for, so it gets the
 * serif at display size - one of the two or three a screen may have. */
.smart-preview__count {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.smart-preview__number {
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: 3rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.smart-preview__unit {
  font-size: 1.1rem;
  opacity: 0.8;
}

.smart-preview__uncertain {
  display: flex;
  align-items: center;
  gap: 2px;
  color: rgb(var(--v-theme-warning));
}

.smart-preview__mosaic {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.smart-preview__tile {
  aspect-ratio: 1;
  border-radius: 4px;
  overflow: hidden;
}

.smart-preview__songs {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.smart-preview__song + .smart-preview__song {
  border-top: 1px solid var(--beacon-hairline);
}

/* The negative margin lets the hover tint reach past the text while the
 * cover and title stay in line with the rest of the panel. */
.smart-preview__song-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 6px;
  background: none;
  border: none;
  border-radius: 6px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.smart-preview__song-button:hover,
.smart-preview__song-button:focus-visible {
  background: var(--beacon-hover);
}

.smart-preview__song-cover {
  position: relative;
  flex: 0 0 auto;
  border-radius: 4px;
  overflow: hidden;
}

.smart-preview__song-play {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.smart-preview__song-button:hover .smart-preview__song-cover::after,
.smart-preview__song-button:focus-visible .smart-preview__song-cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}

.smart-preview__song-button:hover .smart-preview__song-play,
.smart-preview__song-button:focus-visible .smart-preview__song-play {
  opacity: 1;
  z-index: 1;
}

/* Takes what the cover leaves and no more, so a long title ends in an
 * ellipsis instead of running out of the panel. */
.smart-preview__song-text {
  display: block;
  flex: 1;
  min-width: 0;
}

.smart-preview__title,
.smart-preview__artist {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.smart-preview__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 8px;
  text-align: center;
}

.smart-preview__empty p {
  margin: 0;
}

.smart-preview__empty-icon {
  opacity: 0.4;
}

.smart-preview__note {
  margin: 4px 0 0;
}
</style>
