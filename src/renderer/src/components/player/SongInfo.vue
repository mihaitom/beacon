<template>
  <!-- Only the parts that actually go somewhere look like they do. The
   - whole block used to carry a pointer cursor unconditionally: with
   - nothing playing it pointed at a click that does nothing, and on radio
   - it made two labels look like links to a page that does not exist (a
   - station has no page of its own — see the plain text below). What is
   - left clickable is the artwork and the space around it, which opens Now
   - Playing, plus a song's own artist link. -->
  <div
    class="song-info"
    :class="{ 'song-info--clickable': hasPlayable }"
    @click="hasPlayable && $router.push('/now-playing')"
    @contextmenu="onContextMenu"
  >
    <cover-art v-if="currentSong" :cover-art-id="currentSong.coverArtId" :size="48" class="cover" />
    <cover-art
      v-else-if="playbackStore.radioStation"
      :radio-favicon="radioFavicon"
      :size="48"
      fallback-icon="mdi-radio"
      class="cover"
    />
    <!-- A song's labels stay part of the block's own click (its title is
     - one more way to reach Now Playing, and its artist is a real link).
     - Radio's are text and nothing else: neither line has anywhere of its
     - own to lead, so neither pretends to. -->
    <div
      class="song-info__labels"
      :class="{ 'song-info__labels--inert': !currentSong }"
      @click="onLabelsClick"
    >
      <preview-status />
      <div class="text-body-medium">
        {{
          currentSong?.title ??
          radioMeta.nowPlaying ??
          playbackStore.radioStation?.name ??
          $t('player.nothingPlaying')
        }}
      </div>
      <router-link
        v-if="currentSong"
        :to="`/artists/${currentSong.artistId}`"
        class="text-body-small text-medium-emphasis artist-link"
        @click.stop
      >
        {{ currentSong.artist }}
      </router-link>
      <!-- Station name, not the ICY tag — swapped with the top label above
       - so the tag (what's actually playing right now) is the prominent
       - one and the station is secondary, same as NowPlayingView.vue's own
       - swap for consistency. Only shown once there's a tag to go with it
       - (mirrors the top label's own fallback chain above); with no tag the
       - station name already sits up there, so repeating it here would
       - just be noise. -->
      <div v-else-if="radioMeta.nowPlaying" class="text-body-small text-medium-emphasis">
        {{ playbackStore.radioStation?.name }}
      </div>
      <div v-else class="text-body-small text-medium-emphasis" />
    </div>
    <div v-if="currentSong" class="song-info__actions">
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="currentSong.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="currentSong.starred ? 'primary' : undefined"
        :disabled="starringInFlight"
        variant="text"
        density="comfortable"
        :title="favoriteTitle"
        :aria-label="favoriteTitle"
        @click.stop="toggleStar"
      />
      <!-- The same menu a right-click opens, for anyone who doesn't think
         - to right-click a player bar. -->
      <v-btn
        class="song-info__more"
        icon="mdi-dots-vertical"
        variant="text"
        density="comfortable"
        size="small"
        :title="$t('common.moreActions')"
        :aria-label="$t('common.moreActions')"
        @click.stop="openMenu"
      />
    </div>
    <!-- SongCard.vue's menu, minus the queue entries: this song is the one
     - already playing. The stars live here rather than in the bar, which
     - has no room for five more targets beside the heart (#55). -->
    <tile-context-menu v-if="currentSong" ref="menu">
      <context-menu-section
        v-if="authStore.capabilities.songRadio"
        :label="$t('library.menuPlayback')"
      />
      <v-list-item v-if="authStore.capabilities.songRadio" @click="startSongRadio">
        <template #prepend><v-icon icon="mdi-radio-tower" size="small" /></template>
        <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
      </v-list-item>
      <context-menu-section :label="$t('library.menuLibrary')" />
      <div v-if="authStore.capabilities.personalRating" class="song-info__rating">
        <v-rating
          :model-value="currentSong.rating"
          length="5"
          size="small"
          density="compact"
          active-color="primary"
          hover
          clearable
          :aria-label="$t('library.rating')"
          @update:model-value="setRating"
        />
      </div>
      <add-to-playlist-submenu @create="createPlaylist" @select="addToPlaylist" />
      <context-menu-section :label="$t('library.menuNavigation')" />
      <v-list-item v-if="currentSong.albumId" :to="`/albums/${currentSong.albumId}`">
        <template #prepend><v-icon icon="mdi-album" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
      </v-list-item>
      <v-list-item v-if="currentSong.artistId" :to="`/artists/${currentSong.artistId}`">
        <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
        <v-list-item-title>{{ $t('library.goToArtist') }}</v-list-item-title>
      </v-list-item>
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item v-if="currentSong.coverArtId" @click="showArtwork">
        <template #prepend><v-icon icon="mdi-image-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="showInfo">
        <template #prepend><v-icon icon="mdi-information-outline" size="small" /></template>
        <v-list-item-title>{{ $t('library.songInfo') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
    <create-playlist-dialog ref="createDialog" />
  </div>
</template>

<script lang="ts">
import { withShortcut } from '@/services/keyboardShortcuts'
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import { emitter } from '@/emitter'
import CoverArt from '@/components/library/CoverArt.vue'
import TileContextMenu from '@/components/library/TileContextMenu.vue'
import ContextMenuSection from '@/components/library/ContextMenuSection.vue'
import AddToPlaylistSubmenu from '@/components/library/AddToPlaylistSubmenu.vue'
import CreatePlaylistDialog from '@/components/library/CreatePlaylistDialog.vue'
import PreviewStatus from './PreviewStatus.vue'

export default {
  name: 'SongInfo',
  components: {
    CoverArt,
    PreviewStatus,
    TileContextMenu,
    ContextMenuSection,
    AddToPlaylistSubmenu,
    CreatePlaylistDialog,
  },
  data() {
    return {
      starringInFlight: false,
    }
  },
  computed: {
    favoriteTitle(): string {
      const label = this.$t(this.currentSong?.starred ? 'library.unstar' : 'library.star')
      return withShortcut(label, 'toggleFavorite')
    },
    playbackStore() {
      return usePlaybackStore()
    },
    radioMeta() {
      return useRadioMetadataStore()
    },
    authStore() {
      return useAuthStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    // 96, not 48 (the box's actual CSS size) — a favicon this small still
    // benefits from headroom on a high-DPI display, and the source is
    // free to just be smaller than that if that's all the station's
    // homepage actually declares (see routes/radio.py's _select()).
    radioFavicon(): RadioFaviconRequest | null {
      const station = this.playbackStore.radioStation
      if (!station?.homePageUrl && !station?.favicon) return null
      return radioFaviconRequest(station.homePageUrl ?? '', 96, station.favicon ?? '')
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
  },
  methods: {
    /** Swallows the click on radio's (and the idle placeholder's) labels,
     * so what they do matches what they look like. A song's labels fall
     * through to the block's own handler as before. */
    onLabelsClick(event: MouseEvent) {
      if (!this.currentSong) event.stopPropagation()
    },
    /** Radio and the idle bar keep the browser's own menu: there is no
     * song to act on. */
    onContextMenu(event: MouseEvent) {
      if (!this.currentSong) return
      event.preventDefault()
      this.openMenu(event)
    },
    openMenu(event: MouseEvent) {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
      // Same eager warm-up as SongRow.vue's openMenu().
      if (useLibraryStore().playlists.length === 0) {
        void useLibraryStore().fetchPlaylists()
      }
    },
    /** Rates the song the menu was opened for, optimistically like
     * SongTable.vue's setRating(). Held on to, not re-read from the store:
     * the track can change during the round trip. */
    async setRating(value: number | string) {
      const song = this.currentSong
      if (!song) return
      const library = useLibraryStore()
      const previous = song.rating
      library.markRating(song, Number(value))
      try {
        await library.setRating(song.id, Number(value))
      } catch (error) {
        library.markRating(song, previous)
        console.error('[song-info] Failed to set rating:', error)
      }
    },
    async startSongRadio() {
      if (!this.currentSong) return
      try {
        await this.playbackStore.startSongRadio(this.currentSong)
      } catch (error) {
        emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.songRadio'),
          message: this.$t('library.songRadioError'),
        })
        console.error('[song-radio]', error)
      }
    },
    async addToPlaylist(playlistId: string) {
      if (!this.currentSong) return
      await useLibraryStore().addToPlaylist(playlistId, [this.currentSong.id])
    },
    createPlaylist() {
      if (!this.currentSong) return
      const dialog = this.$refs.createDialog as { open: (ids: string[]) => void } | undefined
      dialog?.open([this.currentSong.id])
    },
    showArtwork() {
      if (!this.currentSong) return
      emitter.emit('showArtwork', {
        coverArtId: this.currentSong.coverArtId,
        title: this.currentSong.title,
        subtitle: this.currentSong.album || this.currentSong.artist,
      })
    },
    showInfo() {
      if (this.currentSong) emitter.emit('showSongInfo', this.currentSong)
    },
    async toggleStar() {
      if (!this.currentSong || this.starringInFlight) return
      this.starringInFlight = true
      try {
        await useLibraryStore().toggleFavorite('song', this.currentSong)
      } finally {
        this.starringInFlight = false
      }
    },
  },
}
</script>

<style scoped>
.song-info__actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-inline: 8px 0;
}

/* Lined up with the menu items' own text, see ContextMenuSection.vue. */
.song-info__rating {
  padding: 2px 12px 6px;
}

/* Fills its grid track rather than sitting at a fixed 300px inside it.
 *
 * The two flanks of PlayerBar.vue's row share one width, whichever of the
 * two needs more room in the current state (see .player-bar__row's own
 * comment) — so whenever the toolbar is the wider one, this sat at 300px
 * in a 434px track with the difference simply unused, while the text next
 * to it truncated. Radio shows that plainest: a station's ICY metadata
 * arrives as a single "Artist - Title" string with no artist line to split
 * it across, so all of it competes for the top line's width.
 *
 * Nothing about the centering changes: the track is exactly as wide as it
 * was, this just uses all of it. min-width: 0 because a grid item's
 * automatic minimum is its content, which would otherwise stop the text
 * inside from ever truncating. */
.song-info {
  display: flex;
  align-items: center;
  min-width: 0;
}

.song-info--clickable {
  cursor: pointer;
}

/* Text, not a control — the default cursor is the whole point. */
.song-info__labels--inert {
  cursor: default;
}

.cover {
  flex-shrink: 0;
}

/* Block, not the anchor's default inline — the ellipsis rule on
 * .song-info__labels' children needs a constrained box to truncate
 * against, which an inline element sitting in normal block flow doesn't
 * have here (this row isn't itself a flex item, see .song-info__labels
 * above it). */
.artist-link {
  display: block;
  text-decoration: none;
}

.artist-link:hover {
  color: rgb(var(--v-theme-primary));
}

/* Without min-width: 0, a flex item refuses to shrink below its content's
 * natural width by default — the title/artist text wouldn't truncate at
 * all, just push the star button (and this whole row) wider instead. */
.song-info__labels {
  min-width: 0;
}

/* Every line in the player bar clips: the bar is a fixed height, and a
 * radio station's ICY tag arrives as one long "Artist - Title" string. */
.song-info__labels > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cover {
  margin-right: 12px;
}
</style>
