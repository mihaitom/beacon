<template>
  <router-link
    ref="root"
    :to="`/playlists/${playlist.id}`"
    class="playlist-card"
    :class="{ 'playlist-card--row': row }"
    @mouseenter="browsing = true"
    @mouseleave="browsing = false"
    @focus="browsing = true"
    @blur="browsing = false"
    @contextmenu.prevent="openMenu"
  >
    <!-- The artwork is the playlist's own albums rather than the image the
     - server makes for it (on Navidrome a mosaic of four covers), standing
     - like records in a crate that is flipped through while the card is
     - hovered - the same stack as the Genres page's crates. Only then: a
     - whole page flipping at once would be restless, and would keep every
     - card on it fetching covers. -->
    <div class="playlist-card__art">
      <!-- The colour of the record in front, cast on the page behind it. -->
      <div v-if="!row" class="playlist-card__glow" :style="glowStyle" />
      <record-stack
        v-if="settled"
        class="playlist-card__stack"
        :covers="covers"
        :size="row ? RECORD_SIZE : GRID_RECORD_SIZE"
        :depth="3"
        :rise="row ? RECORD_RISE : GRID_RECORD_RISE"
        :fetch-as="row ? undefined : GRID_FETCH_SIZE"
        :browsing="browsing"
        fallback-icon="mdi-playlist-music"
        @change="shownCover = $event"
      />
      <v-skeleton-loader
        v-else
        type="image"
        :width="row ? RECORD_SIZE : undefined"
        :height="row ? COVER_SIZE : undefined"
        class="playlist-card__skeleton"
      />
      <div v-if="!row" class="playlist-card__controls">
        <preview-button
          class="playlist-card__preview"
          compact
          :load="loadSongs"
          :song-count="playlist.songCount"
        />
        <v-btn
          class="playlist-card__play"
          icon="mdi-play"
          color="primary"
          variant="flat"
          :title="$t('library.play')"
          :aria-label="$t('library.play')"
          :disabled="!playlist.songCount"
          @click.prevent.stop="$emit('play', playlist)"
        />
      </div>
    </div>
    <div class="playlist-card__info">
      <div class="playlist-card__name">
        <span class="playlist-card__clip">{{ playlist.name }}</span>
        <v-icon
          v-if="!row && playlist.smart"
          icon="mdi-auto-fix"
          size="16"
          class="playlist-card__mark"
          :title="$t('playlists.smart')"
        />
        <v-icon
          v-else-if="!row && playlist.public"
          icon="mdi-earth"
          size="16"
          class="playlist-card__mark"
          :title="$t('playlists.public')"
        />
      </div>
      <div class="text-body-small text-medium-emphasis playlist-card__line">
        {{ row ? meta : shortMeta }}
        <v-icon
          v-if="row && playlist.public"
          icon="mdi-earth"
          size="14"
          class="playlist-card__public"
          :title="$t('playlists.public')"
        />
      </div>
      <!-- Both lines keep their place while the summary loads, so the list
       - does not shift as the summaries come in one card at a time. -->
      <div v-if="row" class="text-body-medium playlist-card__line">
        {{ artistSentence || '\u00a0' }}
      </div>
      <div v-else class="text-body-medium playlist-card__who">
        <span class="playlist-card__clip">{{ artistNames || '\u00a0' }}</span>
        <span v-if="otherArtists" class="text-medium-emphasis">+{{ $n(otherArtists) }}</span>
      </div>
      <div class="playlist-card__genres">
        <v-chip v-for="genre in genres" :key="genre" size="small" variant="tonal" label>
          {{ genre }}
        </v-chip>
      </div>
    </div>
    <div v-if="row" class="playlist-card__actions">
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-play"
        :disabled="!playlist.songCount"
        @click.prevent.stop="$emit('play', playlist)"
      >
        {{ $t('library.play') }}
      </v-btn>
      <preview-button :load="loadSongs" :song-count="playlist.songCount" :pill="false" />
    </div>
    <!-- Renaming and deleting are offered for the user's own playlists
     - only; someone else's shared playlist is not theirs to change. -->
    <tile-context-menu ref="menu">
      <context-menu-section :label="$t('library.menuPlayback')" />
      <v-list-item @click="$emit('play', playlist)">
        <template #prepend><v-icon icon="mdi-play" size="small" /></template>
        <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('play-next', playlist)">
        <template #prepend><v-icon icon="mdi-skip-next-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('add-to-queue', playlist)">
        <template #prepend><v-icon icon="mdi-playlist-plus" size="small" /></template>
        <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
      </v-list-item>
      <template v-if="isOwnPlaylist">
        <context-menu-section :label="$t('library.menuLibrary')" />
        <v-list-item @click="$emit('rename', playlist)">
          <template #prepend><v-icon icon="mdi-pencil-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.edit') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="$emit('delete', playlist)">
          <template #prepend><v-icon icon="mdi-delete-outline" size="small" /></template>
          <v-list-item-title>{{ $t('common.delete') }}</v-list-item-title>
        </v-list-item>
      </template>
      <template v-if="artworkId">
        <context-menu-section :label="$t('library.menuDetails')" />
        <v-list-item @click="showArtwork">
          <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
          <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
        </v-list-item>
      </template>
    </tile-context-menu>
  </router-link>
</template>

<script lang="ts">
import RecordStack from './RecordStack.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import PreviewButton from './PreviewButton.vue'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaylistSummariesStore } from '@/stores/playlistSummaries'
import {
  leadingArtists,
  summaryKey,
  type PlaylistSummary,
} from '@/services/library/playlistSummary'
import { formatTotalDuration } from '@/services/totalDuration'
import { timeAgo } from '@/services/relativeTime'
import { getLocale } from '@/i18n'
import { emitter } from '@/emitter'
import { extractDominantColor } from '@/services/colorExtractor'
import { isOwnedBy } from '@/services/library/playlistOwnership'
import type { Playlist } from '@/types/library'

const COVER_SIZE = 112
// The front record: three of them, each 8px higher than the one before,
// fill the same 112px the artwork has always taken.
const RECORD_RISE = 8
const RECORD_SIZE = COVER_SIZE - 2 * RECORD_RISE

// In the grid a record is as wide as its column (the card is the size
// container), and a rise scales with it so a wider window does not flatten
// the stack.
const GRID_RECORD_SIZE = '100cqi'
const GRID_RECORD_RISE = 'calc(100cqi * 0.075)'
// Columns are 220-300px on a desktop window; the 320 tier covers them.
const GRID_FETCH_SIZE = 320
// Two names rather than the row's three: a column is too narrow for more.
const GRID_ARTISTS = 2

// Same lead as CoverArt.vue's own: the summary starts loading a little
// before the row scrolls into view.
const LAZY_ROOT_MARGIN = '400px 0px'

export default {
  name: 'PlaylistCard',
  components: { RecordStack, TileContextMenu, ContextMenuSection, PreviewButton },
  props: {
    playlist: {
      type: Object as () => Playlist,
      required: true,
    },
    /** The list form: one line per playlist, its buttons beside it. */
    row: {
      type: Boolean,
      default: false,
    },
    // Set in the "global playlists" section, where every playlist belongs
    // to someone else (see PlaylistsView.vue's globalPlaylists).
    showOwner: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play', 'play-next', 'add-to-queue', 'rename', 'delete'],
  data() {
    return {
      COVER_SIZE,
      RECORD_SIZE,
      RECORD_RISE,
      GRID_RECORD_SIZE,
      GRID_RECORD_RISE,
      GRID_FETCH_SIZE,
      browsing: false,
      glow: null as string | null,
      inView: false,
      shownCover: null as string | null,
      observer: null as IntersectionObserver | null,
    }
  },
  computed: {
    summaries() {
      return usePlaylistSummariesStore()
    },
    summary(): PlaylistSummary | null {
      return this.summaries.summaryFor(this.playlist)
    },
    settled(): boolean {
      return this.summary !== null || this.summaries.isSettled(this.playlist)
    },
    /** The playlist's own albums; the server's artwork only if they could
     * not be read. */
    covers(): string[] {
      if (this.summary) return this.summary.covers
      if (this.settled && this.playlist.coverArtId) return [this.playlist.coverArtId]
      return []
    },
    genres(): string[] {
      return this.summary?.genres ?? []
    },
    artworkId(): string | null {
      return this.shownCover ?? this.covers[0] ?? null
    },
    /** Same rule as PlaylistDetailView.vue's own edit/delete buttons. */
    isOwnPlaylist(): boolean {
      return isOwnedBy(this.playlist, useAuthStore().username)
    },
    meta(): string {
      const ago = this.playlist.changed
        ? timeAgo(Date.parse(this.playlist.changed), Date.now(), getLocale())
        : ''
      const parts = [
        this.$t('playlists.songCount', { count: this.$n(this.playlist.songCount) }),
        formatTotalDuration(this.playlist.duration, this.$t),
        this.playlist.smart ? this.$t('playlists.smart') : '',
        ago ? this.$t('playlists.editedAgo', { ago }) : '',
      ]
      if (this.showOwner && this.playlist.owner) {
        parts.push(this.$t('playlists.byOwner', { owner: this.playlist.owner }))
      }
      return parts.filter(Boolean).join(' · ')
    },
    shortMeta(): string {
      const parts = [
        this.$t('playlists.songCount', { count: this.$n(this.playlist.songCount) }),
        formatTotalDuration(this.playlist.duration, this.$t),
      ]
      if (this.showOwner && this.playlist.owner) {
        parts.push(this.$t('playlists.byOwner', { owner: this.playlist.owner }))
      }
      return parts.filter(Boolean).join(' · ')
    },
    artistNames(): string {
      return (this.summary?.artists ?? []).slice(0, GRID_ARTISTS).join(', ')
    },
    otherArtists(): number {
      return Math.max(0, (this.summary?.artists.length ?? 0) - GRID_ARTISTS)
    },
    /** Which cover the glow should follow; none until the card is browsed,
     * so a page of cards reads no cover it was not asked about. */
    glowCover(): string | null {
      return !this.row && this.browsing ? this.artworkId : null
    },
    glowStyle(): { backgroundColor: string } | undefined {
      return this.glow ? { backgroundColor: `rgb(${this.glow})` } : undefined
    },
    artistSentence(): string {
      const artists = this.summary?.artists ?? []
      if (!artists.length) return ''
      const named = leadingArtists(artists)
      const rest = artists.length - named.length
      return rest > 0
        ? this.$t('playlists.withArtistsAndMore', { artists: named.join(', '), count: rest })
        : this.$t('playlists.withArtists', { artists: named.join(', ') })
    },
    /** Changes with every edit of the playlist - see summaryKey(). */
    version(): string {
      return summaryKey(this.playlist)
    },
  },
  watch: {
    version() {
      if (this.inView) void this.summaries.ensure(this.playlist)
    },
    glowCover(id: string | null) {
      if (id) void this.loadGlow(id)
    },
  },
  mounted() {
    const el = (this.$refs.root as { $el: HTMLElement } | undefined)?.$el
    if (!el || typeof IntersectionObserver === 'undefined') {
      this.onVisible()
      return
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.onVisible()
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    )
    this.observer.observe(el)
  },
  beforeUnmount() {
    this.observer?.disconnect()
  },
  methods: {
    /** The row carries only the playlist's summary; its songs come with
     * the preview's click, as Play's do (PlaylistsView's playPlaylist()). */
    async loadSongs() {
      return (await useLibraryStore().fetchPlaylist(this.playlist.id)).songs
    },
    /** Once seen, a row keeps its summary current for as long as it is
     * mounted - an edit while it is scrolled away is still picked up. */
    onVisible(): void {
      this.inView = true
      this.observer?.disconnect()
      this.observer = null
      void this.summaries.ensure(this.playlist)
    },
    /** Same size as every artwork backdrop, so it is one cached image. */
    async loadGlow(id: string): Promise<void> {
      const url = useLibraryStore().client().coverArtUrl(id, 300)
      if (!url) return
      const color = await extractDominantColor(url)
      // The stack may have flipped on, or the pointer left, in the meantime.
      if (id === this.glowCover) this.glow = color ? color.join(', ') : null
    },
    openMenu(event: MouseEvent): void {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
    showArtwork(): void {
      emitter.emit('showArtwork', {
        coverArtId: this.artworkId,
        title: this.playlist.name,
        fallbackIcon: 'mdi-playlist-music',
      })
    },
  },
}
</script>

<style scoped>
.playlist-card {
  position: relative;
  display: block;
  /* What the grid's 100cqi records are measured against. */
  container-type: inline-size;
  color: inherit;
  text-decoration: none;
}

.playlist-card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
  border-radius: 4px;
}

.playlist-card__art {
  position: relative;
}

/* Scales with the record: the row's fixed 600px would exaggerate the fall
 * of a record several times its size. */
.playlist-card__stack.record-stack {
  perspective: calc(100cqi * 5.2);
}

.playlist-card--row .playlist-card__stack.record-stack {
  perspective: 600px;
}

.playlist-card__glow {
  position: absolute;
  inset: 14% 4% -7%;
  border-radius: 30%;
  filter: blur(44px);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    background-color 0.6s ease;
}

.playlist-card:hover .playlist-card__glow,
.playlist-card:focus-visible .playlist-card__glow {
  opacity: 0.5;
}

/* Same outline as the stack it stands in for, so nothing shifts. */
.playlist-card__skeleton {
  aspect-ratio: 1 / 1.15;
  background: transparent;
}

.playlist-card__skeleton :deep(.v-skeleton-loader__bone) {
  height: 100%;
  margin: 0;
}

.playlist-card--row .playlist-card__skeleton {
  flex-shrink: 0;
  aspect-ratio: auto;
}

.playlist-card__controls {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.playlist-card:hover .playlist-card__controls,
.playlist-card:focus-within .playlist-card__controls {
  opacity: 1;
}

/* Nothing to point with: without this a touch screen never gets the buttons. */
@media (hover: none) {
  .playlist-card__controls {
    opacity: 1;
  }
}

.playlist-card__play.v-btn,
.playlist-card__preview.v-btn {
  width: 44px;
  height: 44px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}

/* A dark pill whatever the theme: it stands on a cover, not on the page. */
.playlist-card__preview.v-btn {
  background: rgba(10, 11, 16, 0.72);
  color: #fff;
}

.playlist-card__info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-top: 14px;
}

.playlist-card__name {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 1.05rem;
  font-weight: 600;
}

.playlist-card:hover .playlist-card__name {
  color: rgb(var(--v-theme-primary));
}

.playlist-card__mark {
  flex-shrink: 0;
  color: rgb(var(--v-theme-primary));
}

.playlist-card__clip,
.playlist-card__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-card__who {
  display: flex;
  gap: 6px;
}

.playlist-card__who > * {
  flex-shrink: 0;
}

.playlist-card__who > .playlist-card__clip {
  flex-shrink: 1;
  min-width: 0;
}

.playlist-card__public {
  margin-left: 4px;
  vertical-align: -2px;
}

/* One line's height even when empty, for the same reason as the artist
 * line above it. */
.playlist-card__genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  max-height: 24px;
  margin-top: 5px;
  overflow: hidden;
}

/* The list form. */
.playlist-card--row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 20px 14px 14px;
  container-type: normal;
  transition: background 0.15s ease;
}

.playlist-card--row + .playlist-card--row {
  border-top: 1px solid var(--beacon-hairline);
}

.playlist-card--row:hover {
  background: var(--beacon-hover);
}

.playlist-card--row .playlist-card__art {
  flex-shrink: 0;
}

.playlist-card--row .playlist-card__info {
  flex: 1 1 auto;
  margin-top: 0;
}

.playlist-card--row .playlist-card__name {
  font-size: 1.15rem;
}

.playlist-card--row .playlist-card__genres {
  max-height: none;
  margin-top: 2px;
}

.playlist-card__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

/* Below this the buttons would squeeze the name down to a few letters;
 * they go under the text instead, the cover keeping its place. */
@media (max-width: 760px) {
  .playlist-card--row {
    flex-wrap: wrap;
  }

  .playlist-card__actions {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .playlist-card__glow {
    transition: none;
  }
}
</style>
