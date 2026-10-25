<template>
  <v-bottom-sheet
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card v-if="song">
      <div class="mobile-song-actions__header">
        <cover-art :cover-art-id="song.coverArtId" :size="40" class="mobile-song-actions__art" />
        <div class="mobile-song-actions__labels">
          <div class="text-body-medium">{{ song.title }}</div>
          <artist-credit
            :credit="song.artist"
            :artist-id="song.artistId"
            :linked="false"
            class="text-body-small text-medium-emphasis"
          />
        </div>
      </div>
      <!-- Opened on a queue row: what the desktop queue's context menu
         - offers, for the song at that position rather than for the song. -->
      <v-list v-if="!playlistPicker && inQueue" density="compact">
        <v-list-subheader v-if="isLockedNext">{{ $t('queue.nextLocked') }}</v-list-subheader>
        <v-list-item :disabled="isCurrent" @click="queuePlay">
          <template #prepend><v-icon icon="mdi-play" /></template>
          <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
        </v-list-item>
        <v-list-item :disabled="!canMove('next')" @click="queueMove('next')">
          <template #prepend><v-icon icon="mdi-skip-next-outline" /></template>
          <v-list-item-title>
            {{
              playbackStore.lockedNextIndex >= 0 ? $t('queue.moveAfterNext') : $t('queue.moveNext')
            }}
          </v-list-item-title>
        </v-list-item>
        <v-list-item :disabled="!canMove('end')" @click="queueMove('end')">
          <template #prepend><v-icon icon="mdi-arrow-collapse-down" /></template>
          <v-list-item-title>{{ $t('queue.moveToEnd') }}</v-list-item-title>
        </v-list-item>
        <v-list-item :disabled="isCurrent || isLockedNext" @click="queueRemove">
          <template #prepend><v-icon icon="mdi-playlist-remove" /></template>
          <v-list-item-title>{{ $t('queue.remove') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.songRadio" @click="startSongRadio">
          <template #prepend><v-icon icon="mdi-radio-tower" /></template>
          <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.favorites" @click="toggleFavorite">
          <template #prepend>
            <v-icon :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'" />
          </template>
          <v-list-item-title>
            {{ song.starred ? $t('library.unstar') : $t('library.star') }}
          </v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item @click="playlistPicker = true">
          <template #prepend><v-icon icon="mdi-playlist-music" /></template>
          <v-list-item-title>{{ $t('common.addToPlaylistMenu') }}</v-list-item-title>
          <template #append><v-icon icon="mdi-menu-right" /></template>
        </v-list-item>
        <v-list-item v-if="song.albumId" @click="goToAlbum">
          <template #prepend><v-icon icon="mdi-album" /></template>
          <v-list-item-title>{{ $t('library.goToAlbum') }}</v-list-item-title>
        </v-list-item>
        <v-list-item
          v-for="artist in artistTargets"
          :key="artist.id!"
          @click="goToArtist(artist.id!)"
        >
          <template #prepend><v-icon icon="mdi-account-music" /></template>
          <v-list-item-title>
            {{
              artistTargets.length > 1
                ? `${$t('library.goToArtist')}: ${artist.name}`
                : $t('library.goToArtist')
            }}
          </v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item v-if="song.coverArtId" @click="showArtwork">
          <template #prepend><v-icon icon="mdi-image-outline" /></template>
          <v-list-item-title>{{ $t('library.showArtwork') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="showInfo">
          <template #prepend><v-icon icon="mdi-information-outline" /></template>
          <v-list-item-title>{{ $t('library.songInfo') }}</v-list-item-title>
        </v-list-item>
      </v-list>
      <v-list v-else-if="!playlistPicker" density="compact">
        <v-list-item @click="playNow">
          <template #prepend><v-icon icon="mdi-play" /></template>
          <v-list-item-title>{{ $t('library.play') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="playNext">
          <template #prepend><v-icon icon="mdi-skip-next-outline" /></template>
          <v-list-item-title>{{ $t('library.playNext') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.songRadio" @click="startSongRadio">
          <template #prepend><v-icon icon="mdi-radio-tower" /></template>
          <v-list-item-title>{{ $t('library.songRadio') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="authStore.capabilities.favorites" @click="toggleFavorite">
          <template #prepend>
            <v-icon :icon="song.starred ? 'mdi-heart' : 'mdi-heart-outline'" />
          </template>
          <v-list-item-title>
            {{ song.starred ? $t('library.unstar') : $t('library.star') }}
          </v-list-item-title>
        </v-list-item>
        <v-divider />
        <v-list-item @click="addToQueue">
          <template #prepend><v-icon icon="mdi-playlist-plus" /></template>
          <v-list-item-title>{{ $t('common.addToQueue') }}</v-list-item-title>
        </v-list-item>
        <v-list-item @click="playlistPicker = true">
          <template #prepend><v-icon icon="mdi-playlist-music" /></template>
          <v-list-item-title>{{ $t('common.addToPlaylistMenu') }}</v-list-item-title>
          <template #append><v-icon icon="mdi-menu-right" /></template>
        </v-list-item>
        <!-- Only on a playlist's own page — the album page and the library
           - open this same sheet, where "the playlist" would mean nothing. -->
        <v-list-item v-if="removable" @click="remove">
          <template #prepend><v-icon icon="mdi-playlist-minus" /></template>
          <v-list-item-title>{{ $t('library.removeFromPlaylist') }}</v-list-item-title>
        </v-list-item>
      </v-list>
      <v-list v-else density="compact" class="mobile-song-actions__playlists">
        <v-list-item @click="createPlaylistWithSong">
          <template #prepend><v-icon icon="mdi-plus" /></template>
          <v-list-item-title>{{ $t('common.createNewPlaylist') }}</v-list-item-title>
        </v-list-item>
        <template v-if="libraryStore.playlistsAcceptingSongs.length">
          <v-divider />
          <v-list-item
            v-for="playlist in libraryStore.playlistsAcceptingSongs"
            :key="playlist.id"
            @click="addToPlaylist(playlist.id)"
          >
            <v-list-item-title>{{ playlist.name }}</v-list-item-title>
          </v-list-item>
        </template>
      </v-list>
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import ArtistCredit from '@/components/library/ArtistCredit.vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore, type QueueMoveTarget } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import type { Song } from '@/types/library'
import type { CreditPart } from '@/services/artistCredits'

export default {
  name: 'MobileSongActionSheet',
  components: { ArtistCredit, CoverArt },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    song: {
      type: Object as () => Song | null,
      default: null,
    },
    // Set by the playlist page only (see its own comment) — everywhere else
    // this sheet opens, there is no playlist to remove from.
    removable: {
      type: Boolean,
      default: false,
    },
    /** The song's position, when the sheet is opened on a queue row - it
     * then offers the queue's own actions. -1 everywhere else. */
    queueIndex: {
      type: Number,
      default: -1,
    },
  },
  emits: ['update:modelValue', 'remove'],
  data() {
    return {
      playlistPicker: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    /** Every artist the song credits, as ArtistCredit splits them. */
    artistTargets(): CreditPart[] {
      if (!this.song) return []
      return useLibraryStore()
        .artistCredit(this.song.artist, this.song.artistId)
        .filter((part) => part.id)
    },
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    inQueue(): boolean {
      return this.queueIndex >= 0
    },
    isCurrent(): boolean {
      return this.queueIndex === this.playbackStore.currentIndex
    },
    isLockedNext(): boolean {
      return this.queueIndex === this.playbackStore.lockedNextIndex
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (open) {
        this.playlistPicker = false
        if (this.libraryStore.playlists.length === 0) void this.libraryStore.fetchPlaylists()
      }
    },
  },
  methods: {
    close() {
      this.$emit('update:modelValue', false)
    },
    act(fn: () => unknown) {
      void fn()
      this.close()
    },
    canMove(where: QueueMoveTarget): boolean {
      return this.playbackStore.queueMoveTarget(this.queueIndex, where) != null
    },
    queuePlay() {
      this.act(() => this.playbackStore.playAtIndex(this.queueIndex))
    },
    queueMove(where: QueueMoveTarget) {
      this.act(() => this.playbackStore.moveInQueue(this.queueIndex, where))
    },
    queueRemove() {
      this.act(() => this.playbackStore.removeFromQueue(this.queueIndex))
    },
    goToAlbum() {
      const albumId = this.song?.albumId
      if (!albumId) return
      this.act(() => this.$router.push(`/m/albums/${albumId}`))
    },
    goToArtist(artistId: string) {
      this.act(() => this.$router.push(`/m/artists/${artistId}`))
    },
    showArtwork() {
      const song = this.song
      if (!song) return
      this.act(() =>
        this.$emitter.emit('showArtwork', {
          coverArtId: song.coverArtId,
          title: song.title,
          subtitle: song.album || song.artist,
        }),
      )
    },
    showInfo() {
      const song = this.song
      if (!song) return
      this.act(() => this.$emitter.emit('showSongInfo', song))
    },
    playNow() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.playSongList([song], 0))
    },
    // The page owns the removal itself — it is the only side that knows
    // which playlist this is and which entry the sheet was opened on.
    remove() {
      if (!this.song) return
      this.act(() => this.$emit('remove'))
    },
    playNext() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.queueNext([song]))
    },
    startSongRadio() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.startSongRadio(song))
    },
    toggleFavorite() {
      const song = this.song
      if (!song) return
      this.act(() => this.libraryStore.toggleFavorite('song', song))
    },
    addToQueue() {
      const song = this.song
      if (!song) return
      this.act(() => this.playbackStore.addToQueue([song]))
    },
    addToPlaylist(playlistId: string) {
      const song = this.song
      if (!song) return
      this.act(() => this.libraryStore.addToPlaylist(playlistId, [song.id]))
    },
    createPlaylistWithSong() {
      const song = this.song
      if (!song) return
      this.act(() => this.libraryStore.createPlaylist(song.title, [song.id]))
    },
  },
}
</script>

<style scoped>
.mobile-song-actions__header {
  display: flex;
  align-items: center;
  padding: 16px 16px 8px;
}

.mobile-song-actions__playlists {
  max-height: 50vh;
  overflow-y: auto;
}

.min-width-0 {
  min-width: 0;
}

/* The sheet names one song, on two single lines. */
.mobile-song-actions__labels > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-song-actions__art {
  margin-right: 12px;
}
</style>
