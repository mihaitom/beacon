<template>
  <router-link
    ref="root"
    :to="`/playlists/${playlist.id}`"
    class="playlist-row"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @contextmenu.prevent="openMenu"
  >
    <!-- The artwork is the playlist's own albums rather than the image the
     - server makes for it (on Navidrome a mosaic of four covers), and it
     - cycles through them while the row is hovered. Only then: a whole list
     - fading at once would be restless, and would keep every row on the
     - page fetching covers. -->
    <playlist-cover
      :covers="covers"
      :loading="!settled"
      :size="COVER_SIZE"
      :cycling="hovered"
      @change="shownCover = $event"
    />
    <div class="playlist-row__info">
      <div class="playlist-row__name">{{ playlist.name }}</div>
      <div class="text-body-small text-medium-emphasis playlist-row__line">
        {{ meta }}
        <v-icon
          v-if="playlist.public"
          icon="mdi-earth"
          size="14"
          class="playlist-row__public"
          :title="$t('playlists.public')"
        />
      </div>
      <!-- Both lines keep their place while the summary loads, so the list
       - does not shift as the summaries come in one row at a time. -->
      <div class="text-body-medium playlist-row__line">{{ artistSentence || ' ' }}</div>
      <div class="playlist-row__genres">
        <v-chip v-for="genre in genres" :key="genre" size="small" variant="tonal" label>
          {{ genre }}
        </v-chip>
      </div>
    </div>
    <div class="playlist-row__actions">
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-play"
        :disabled="!playlist.songCount"
        @click.prevent.stop="$emit('play', playlist)"
      >
        {{ $t('library.play') }}
      </v-btn>
      <v-btn
        variant="tonal"
        prepend-icon="mdi-shuffle-variant"
        :disabled="!playlist.songCount"
        @click.prevent.stop="$emit('shuffle', playlist)"
      >
        {{ $t('library.playShuffled') }}
      </v-btn>
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
import PlaylistCover from './PlaylistCover.vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useAuthStore } from '@/stores/auth'
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
import type { Playlist } from '@/types/library'

const COVER_SIZE = 112

// Same lead as CoverArt.vue's own: the summary starts loading a little
// before the row scrolls into view.
const LAZY_ROOT_MARGIN = '400px 0px'

export default {
  name: 'PlaylistRow',
  components: { PlaylistCover, TileContextMenu, ContextMenuSection },
  props: {
    playlist: {
      type: Object as () => Playlist,
      required: true,
    },
    // Set in the "global playlists" section, where every playlist belongs
    // to someone else (see PlaylistsView.vue's globalPlaylists).
    showOwner: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play', 'shuffle', 'play-next', 'add-to-queue', 'rename', 'delete'],
  data() {
    return {
      COVER_SIZE,
      hovered: false,
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
      return this.playlist.owner === useAuthStore().username
    },
    meta(): string {
      const ago = this.playlist.changed
        ? timeAgo(Date.parse(this.playlist.changed), Date.now(), getLocale())
        : ''
      const parts = [
        this.$t('playlists.songCount', { count: this.playlist.songCount }),
        formatTotalDuration(this.playlist.duration, this.$t),
        ago ? this.$t('playlists.editedAgo', { ago }) : '',
      ]
      if (this.showOwner && this.playlist.owner) {
        parts.push(this.$t('playlists.byOwner', { owner: this.playlist.owner }))
      }
      return parts.filter(Boolean).join(' · ')
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
    /** Once seen, a row keeps its summary current for as long as it is
     * mounted - an edit while it is scrolled away is still picked up. */
    onVisible(): void {
      this.inView = true
      this.observer?.disconnect()
      this.observer = null
      void this.summaries.ensure(this.playlist)
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
.playlist-row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 20px 14px 14px;
  color: inherit;
  text-decoration: none;
  transition: background 0.15s ease;
}

.playlist-row + .playlist-row {
  border-top: 1px solid var(--beacon-hairline);
}

.playlist-row:hover {
  background: var(--beacon-hover);
}

.playlist-row__info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.playlist-row__name {
  font-size: 1.15rem;
  font-weight: 600;
}

.playlist-row:hover .playlist-row__name {
  color: rgb(var(--v-theme-primary));
}

.playlist-row__name,
.playlist-row__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-row__public {
  margin-left: 4px;
  vertical-align: -2px;
}

/* One line's height even when empty, for the same reason as the artist
 * line above it. */
.playlist-row__genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  margin-top: 2px;
}

.playlist-row__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

/* Below this the buttons would squeeze the name down to a few letters;
 * they go under the text instead, the cover keeping its place. */
@media (max-width: 760px) {
  .playlist-row {
    flex-wrap: wrap;
  }

  .playlist-row__actions {
    width: 100%;
  }
}
</style>
