<template>
  <v-container fluid class="mobile-home">
    <mobile-home-hero
      :cover-id="heroCoverId"
      :radio-favicon="heroRadioFavicon"
      :eyebrow="heroEyebrow"
      :title="heroTitle"
      :subtitle="heroSubtitle"
      :artist-name="heroArtistName"
      :artist-id="heroArtistId"
      :album-name="heroAlbumName"
      :album-id="heroAlbumId"
      :cover-to="heroCoverTo ? '/m/now-playing' : null"
      :is-playing-this="heroIsPlaying"
      :has-content="heroHasContent"
      :loading="heroLoading"
      :can-start-radio="heroCanStartRadio"
      :radio-loading="heroRadioLoading"
      @play="onHeroPlay"
      @song-radio="onHeroSongRadio"
    />

    <!-- Most played first, then what changes: a phone's Home is for
     - starting something, and browsing comes after. The desktop page's
     - "new artists" shelf is left out - those artists are not in the
     - library, and every way to them leads out of the app. -->
    <section v-if="loadingRecent || shownRecent.length" class="mobile-home__section">
      <div class="mobile-home__head">
        <h2 class="section-title mobile-home__title">{{ $t('home.recentlyPlayed') }}</h2>
        <v-btn
          v-if="shownRecent.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          :loading="playingAllShelf === 'recent'"
          :title="$t('home.playAll')"
          :aria-label="$t('home.playAll')"
          @click="playAllAlbums(shownRecent, 'recent')"
        />
      </div>
      <div class="mobile-home__tiles">
        <template v-if="loadingRecent">
          <v-skeleton-loader v-for="n in RECENT_TILES" :key="n" type="list-item-avatar" />
        </template>
        <mobile-album-tile
          v-for="album in shownRecent"
          v-else
          :key="album.id"
          :album="album"
          @play="playAlbum(album)"
        />
      </div>
    </section>

    <section v-if="loadingTopSongs || shownTopSongs.length" class="mobile-home__section">
      <div class="mobile-home__head">
        <h2 class="section-title mobile-home__title">{{ $t('home.topSongs') }}</h2>
        <v-btn
          v-if="shownTopSongs.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          :title="$t('home.playAll')"
          :aria-label="$t('home.playAll')"
          @click="playSongList(shownTopSongs)"
        />
      </div>
      <div v-if="loadingTopSongs" class="mobile-home__loading">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <div v-else class="mobile-home__rows">
        <mobile-song-row
          v-for="(song, index) in shownTopSongs"
          :key="song.id"
          :song="song"
          @play="playFrom(shownTopSongs, index)"
          @open-actions="openActions(song)"
        />
      </div>
    </section>

    <section v-if="loadingNewest || newestAlbums.length" class="mobile-home__section">
      <div class="mobile-home__head">
        <h2 class="section-title mobile-home__title">{{ $t('home.recentlyAdded') }}</h2>
        <v-btn
          v-if="newestAlbums.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          :loading="playingAllShelf === 'newest'"
          :title="$t('home.playAll')"
          :aria-label="$t('home.playAll')"
          @click="playAllAlbums(newestAlbums, 'newest')"
        />
      </div>
      <div v-if="loadingNewest" class="mobile-home__loading">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <v-slide-group v-else class="mobile-home__shelf">
        <mobile-album-tile
          v-for="album in newestAlbums"
          :key="album.id"
          :album="album"
          shelf
          @play="playAlbum(album)"
        />
      </v-slide-group>
    </section>

    <section
      v-if="
        authStore.capabilities.playHistoryStats && (loadingRediscover || shownRediscover.length)
      "
      class="mobile-home__section"
    >
      <div class="mobile-home__head">
        <h2 class="section-title mobile-home__title">{{ $t('home.rediscover') }}</h2>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :title="$t('home.reroll')"
          :aria-label="$t('home.reroll')"
          @click="loadRediscover"
        />
        <v-btn
          v-if="shownRediscover.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          :title="$t('home.playAll')"
          :aria-label="$t('home.playAll')"
          @click="playSongList(rediscoverSongs)"
        />
      </div>
      <div v-if="loadingRediscover" class="mobile-home__loading">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <div v-else class="mobile-home__rows">
        <mobile-song-row
          v-for="(song, index) in shownRediscover"
          :key="song.id"
          :song="song"
          @play="playFrom(rediscoverSongs, index)"
          @open-actions="openActions(song)"
        />
      </div>
    </section>

    <section v-if="discoverAlbumsLoading || randomAlbums.length" class="mobile-home__section">
      <div class="mobile-home__head">
        <h2 class="section-title mobile-home__title">{{ $t('home.discover') }}</h2>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :loading="discoverAlbumsLoading"
          :title="$t('home.reroll')"
          :aria-label="$t('home.reroll')"
          @click="rerollDiscover(undefined, true, 'albums')"
        />
        <v-btn
          v-if="randomAlbums.length"
          icon="mdi-play-circle-outline"
          variant="text"
          size="small"
          :loading="playingAllShelf === 'random'"
          :title="$t('home.playAll')"
          :aria-label="$t('home.playAll')"
          @click="playAllAlbums(randomAlbums, 'random')"
        />
      </div>
      <div v-if="discoverAlbumsLoading && !randomAlbums.length" class="mobile-home__loading">
        <v-progress-circular indeterminate color="primary" />
      </div>
      <v-slide-group v-else class="mobile-home__shelf">
        <mobile-album-tile
          v-for="album in randomAlbums"
          :key="album.id"
          :album="album"
          shelf
          @play="playAlbum(album)"
        />
      </v-slide-group>
    </section>

    <mobile-song-action-sheet v-model="actionsOpen" :song="activeSong" />
  </v-container>
</template>

<script lang="ts">
import MobileHomeHero from '@/components/mobile/MobileHomeHero.vue'
import MobileAlbumTile from '@/components/mobile/MobileAlbumTile.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import { homeShelvesMixin } from '@/composables/homeShelves'
import { usePlaybackStore } from '@/stores/playback'
import type { Album, Song } from '@/types/library'

/** Two columns of three: what fits above the fold under the hero on a
 * common phone. */
const RECENT_TILES = 6
/** A song list on a phone runs long quickly; the full list is one "play
 * all" away. */
const SONG_ROWS = 5

/** The phone's Home: the desktop page's shelves (see homeShelvesMixin),
 * laid out for one hand. */
export default {
  name: 'MobileHomeView',
  components: { MobileHomeHero, MobileAlbumTile, MobileSongRow, MobileSongActionSheet },
  mixins: [homeShelvesMixin],
  data() {
    return {
      RECENT_TILES,
      actionsOpen: false,
      activeSong: null as Song | null,
    }
  },
  computed: {
    shownRecent(): Album[] {
      return this.recentTiles.slice(0, RECENT_TILES)
    },
    shownTopSongs(): Song[] {
      return this.topSongs.slice(0, SONG_ROWS)
    },
    shownRediscover(): Song[] {
      return this.rediscoverSongs.slice(0, SONG_ROWS)
    },
  },
  methods: {
    /** See MobileLibraryView's playAlbum(). */
    async playAlbum(album: Album) {
      const full = await this.libraryStore.fetchAlbum(album.id)
      await usePlaybackStore().playSongList(full.songs, 0, false, true)
    },
    /** On from the tapped song, as on an artist's page: these are short
     * picked lists rather than a whole catalogue to choose one from. */
    async playFrom(songs: Song[], index: number) {
      await usePlaybackStore().playSongList(songs, index)
    },
    openActions(song: Song) {
      this.activeSong = song
      this.actionsOpen = true
    },
  },
}
</script>

<style scoped>
.mobile-home__section {
  margin-bottom: 28px;
}

.mobile-home__head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
}

.mobile-home__title {
  flex: 1;
  min-width: 0;
}

.mobile-home__tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mobile-home__rows {
  display: flex;
  flex-direction: column;
}

.mobile-home__loading {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

/* Out to the screen's edges, so a cover scrolls off the side rather than
 * vanishing at the container's padding. */
.mobile-home__shelf {
  margin: 0 -16px;
}

.mobile-home__shelf :deep(.v-slide-group__content) {
  gap: 12px;
  padding: 0 16px;
}
</style>
