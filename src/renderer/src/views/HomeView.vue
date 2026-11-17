<template>
  <v-container fluid class="home-view">
    <hero-band
      :cover-id="heroCoverId"
      :radio-favicon="heroRadioFavicon"
      :eyebrow="heroEyebrow"
      :title="heroTitle"
      :title-to="heroTitleTo"
      :cover-to="heroCoverTo"
      :subtitle="heroSubtitle"
      :artist-name="heroArtistName"
      :artist-id="heroArtistId"
      :album-name="heroAlbumName"
      :album-id="heroAlbumId"
      :is-playing-this="heroIsPlaying"
      :has-content="heroHasContent"
      :loading="heroLoading"
      :can-start-radio="heroCanStartRadio"
      :radio-loading="heroRadioLoading"
      @play="onHeroPlay"
      @song-radio="onHeroSongRadio"
    />

    <!-- Frequently played used to have a shelf of its own here, and on any
     - settled listening habit it showed much the same albums as this one.
     - It still seeds Discover (see rerollDiscover()). -->
    <recent-album-tiles
      :title="$t('home.recentlyPlayed')"
      :albums="recentTiles"
      :loading="loadingRecent"
      :play-all-loading="playingAllShelf === 'recent'"
      @play-all="playAllAlbums($event, 'recent')"
    />

    <top-songs-list
      :title="$t('home.topSongs')"
      :songs="topSongs"
      :loading="loadingTopSongs"
      @play-all="playSongList"
    />

    <album-shelf
      :title="$t('home.recentlyAdded')"
      :albums="newestAlbums"
      :loading="loadingNewest"
      :play-all-loading="playingAllShelf === 'newest'"
      play-on-click
      @play-all="playAllAlbums(newestAlbums, 'newest')"
    />
    <song-shelf
      v-if="authStore.capabilities.playHistoryStats"
      :title="$t('home.rediscover')"
      :songs="rediscoverSongs"
      :loading="loadingRediscover"
      @play-all="playSongList(rediscoverSongs)"
    >
      <template #action>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :title="$t('home.reroll')"
          @click="loadRediscover"
        />
      </template>
    </song-shelf>

    <!-- Scrolls like every other shelf now, fit-to-screen dropped — see
     - DISCOVER_SHELF_SIZE's own comment for why a fixed-size pool this
     - much bigger than one screenful is worth scrolling through rather
     - than cropping to whatever fits, now that it matches the other
     - shelves' own 30. -->
    <album-shelf
      :title="$t('home.discover')"
      :albums="randomAlbums"
      :loading="discoverAlbumsLoading"
      :play-all-loading="playingAllShelf === 'random'"
      play-on-click
      @play-all="playAllAlbums(randomAlbums, 'random')"
    >
      <template #action>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :loading="discoverAlbumsLoading"
          :title="$t('home.reroll')"
          @click="rerollDiscover(undefined, true, 'albums')"
        />
      </template>
    </album-shelf>

    <similar-artists-shelf
      :title="$t('home.newArtistsTitle')"
      :artists="newArtistDiscoveries"
      :loading="discoverArtistsLoading"
    >
      <template #action>
        <v-btn
          icon="mdi-shuffle-variant"
          variant="text"
          size="small"
          :loading="discoverArtistsLoading"
          :title="$t('home.reroll')"
          @click="rerollDiscover(undefined, true, 'artists')"
        />
      </template>
    </similar-artists-shelf>
  </v-container>
</template>

<script lang="ts">
import HeroBand from '@/components/home/HeroBand.vue'
import RecentAlbumTiles from '@/components/home/RecentAlbumTiles.vue'
import TopSongsList from '@/components/home/TopSongsList.vue'
import AlbumShelf from '@/components/library/AlbumShelf.vue'
import SimilarArtistsShelf from '@/components/library/SimilarArtistsShelf.vue'
import SongShelf from '@/components/library/SongShelf.vue'
import { homeShelvesMixin } from '@/composables/homeShelves'

export default {
  name: 'HomeView',
  components: {
    HeroBand,
    RecentAlbumTiles,
    TopSongsList,
    AlbumShelf,
    SimilarArtistsShelf,
    SongShelf,
  },
  mixins: [homeShelvesMixin],
}
</script>

<style scoped>
.home-view {
  padding-bottom: 24px;
}
</style>
