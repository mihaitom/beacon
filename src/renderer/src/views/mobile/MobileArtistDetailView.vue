<template>
  <v-container v-if="artist" fluid>
    <div class="mobile-header">
      <cover-art
        :cover-art-id="artist.coverArtId"
        :image-url="artist.imageUrl"
        :size="72"
        fallback-icon="mdi-account-music"
        class="mobile-artist-detail__photo"
      />
      <div class="mobile-header__title">
        <h1 class="page-title">{{ artist.name }}</h1>
        <div class="text-body-small text-medium-emphasis">{{ meta }}</div>
      </div>
      <v-btn
        v-if="authStore.capabilities.favorites"
        :icon="artist.starred ? 'mdi-heart' : 'mdi-heart-outline'"
        :color="artist.starred ? 'primary' : undefined"
        variant="text"
        :title="$t(artist.starred ? 'library.unstar' : 'library.star')"
        :aria-label="$t(artist.starred ? 'library.unstar' : 'library.star')"
        @click="toggleFavorite"
      />
      <v-btn
        v-if="authStore.capabilities.songRadio"
        icon="mdi-radio-tower"
        color="primary"
        variant="text"
        :title="$t('library.artistRadio')"
        :aria-label="$t('library.artistRadio')"
        @click="startArtistRadio"
      />
    </div>

    <!-- The desktop page's two halves, stacked: what they are known for
     - first, since that is what a phone is usually opened for, then the
     - albums. Bio, links and the Fanart backdrop stay a desktop thing - a
     - phone screen has the room for the list and little else. -->
    <template v-if="topSongs.length">
      <h2 class="section-title">{{ $t('library.mostPlayed') }}</h2>
      <div class="mobile-artist-detail__list">
        <mobile-song-row
          v-for="(song, index) in topSongs"
          :key="song.id"
          :song="song"
          @play="playTopSong(index)"
          @open-actions="openActions(song)"
        />
      </div>
    </template>
    <div v-else-if="loadingTopSongs" class="mobile-artist-detail__loading">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-if="albums.length">
      <h2 class="section-title">{{ $t('library.albums') }}</h2>
      <div class="mobile-artist-detail__list">
        <mobile-album-row
          v-for="album in albums"
          :key="album.id"
          :album="album"
          @play="playAlbum(album)"
        />
      </div>
    </template>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
  <v-container v-else>
    <div v-if="libraryStore.loading" class="mobile-artist-detail__loading">
      <v-progress-circular indeterminate color="primary" />
    </div>
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal">{{
      libraryStore.error
    }}</v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import CoverArt from '@/components/library/CoverArt.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileAlbumRow from '@/components/mobile/MobileAlbumRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import type { Album, Song } from '@/types/library'

type ArtistDetail = Awaited<ReturnType<ReturnType<typeof useLibraryStore>['fetchArtist']>>

export default {
  name: 'MobileArtistDetailView',
  components: { CoverArt, MobileSongRow, MobileAlbumRow, MobileSongActionSheet },
  data() {
    return {
      artist: null as ArtistDetail | null,
      topSongs: [] as Song[],
      loadingTopSongs: false,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    authStore() {
      return useAuthStore()
    },
    /** Newest first, as on the desktop page; undated albums last. */
    albums(): Album[] {
      return [...(this.artist?.albums ?? [])].sort((a, b) => {
        if (a.year == null) return b.year == null ? 0 : 1
        if (b.year == null) return -1
        return b.year - a.year
      })
    },
    meta(): string {
      const count = this.artist?.albums.length ?? 0
      return `${this.$n(count)} ${count === 1 ? this.$t('library.album1') : this.$t('library.albumsN')}`
    },
  },
  watch: {
    '$route.params.id': 'loadArtist',
  },
  created() {
    this.loadArtist()
  },
  methods: {
    async loadArtist() {
      const id = this.$route.params.id as string
      this.topSongs = []
      // A newer navigation can resolve first; the id checks keep a slower,
      // now-stale answer from replacing the artist on screen.
      let artist: ArtistDetail
      try {
        artist = await this.libraryStore.fetchArtist(id)
      } catch (error) {
        if (this.$route.params.id === id) {
          console.error('[mobile-artist-detail] Failed to load artist:', error)
        }
        return
      }
      if (this.$route.params.id !== id) return
      this.artist = artist
      this.loadingTopSongs = true
      try {
        const songs = await this.libraryStore.fetchTopSongsForArtist(artist)
        if (this.$route.params.id === id) this.topSongs = songs
      } catch (error) {
        if (this.$route.params.id === id) {
          console.error('[mobile-artist-detail] Failed to load top songs:', error)
        }
      } finally {
        if (this.$route.params.id === id) this.loadingTopSongs = false
      }
    },
    /** The rest of the top songs follow the tapped one, as on the desktop
     * page's table: it is a list somebody put together to be heard. */
    async playTopSong(index: number) {
      await usePlaybackStore().playSongList(this.topSongs, index)
    },
    /** Same call as MobileLibraryView.vue's playAlbum(), for the same
     * reasons. */
    async playAlbum(album: Album) {
      const full = await this.libraryStore.fetchAlbum(album.id)
      await usePlaybackStore().playSongList(full.songs, 0, false, true)
    },
    async toggleFavorite() {
      if (this.artist) await this.libraryStore.toggleFavorite('artist', this.artist)
    },
    async startArtistRadio() {
      if (!this.artist) return
      try {
        await usePlaybackStore().startArtistRadio(this.artist)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.artistRadio'),
          message: this.$t('library.artistRadioError'),
        })
        console.error('[artist-radio]', error)
      }
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-artist-detail__photo {
  flex-shrink: 0;
}

.mobile-artist-detail__loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.mobile-artist-detail__list {
  display: flex;
  flex-direction: column;
  margin-bottom: 24px;
}

.mobile-header__title .page-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
