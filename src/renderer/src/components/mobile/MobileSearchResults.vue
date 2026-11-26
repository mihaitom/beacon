<template>
  <div class="mobile-search-results">
    <!-- A handful of each kind rather than every match: this is for
       - landing on the one thing being looked for, and a section that runs
       - long pushes the next kind off the screen. "Show all" is the
       - library's own list for that kind, filtered by the same term. -->
    <section v-for="section in sections" :key="section.kind" class="mobile-search-results__section">
      <div class="mobile-search-results__head">
        <h2 class="section-title mobile-search-results__title">{{ titleOf(section.kind) }}</h2>
        <v-btn
          v-if="hasOwnList(section.kind) && section.total > section.items.length"
          variant="text"
          size="small"
          color="primary"
          @click="$emit('show-all', section.kind)"
        >
          {{ $t('library.showAllMatches', { count: $n(section.total) }) }}
        </v-btn>
      </div>

      <template v-if="section.kind === 'artists'">
        <mobile-artist-row v-for="artist in section.items" :key="artist.id" :artist="artist" />
      </template>
      <template v-else-if="section.kind === 'albums'">
        <mobile-album-row
          v-for="album in section.items"
          :key="album.id"
          :album="album"
          @play="$emit('play-album', album)"
        />
      </template>
      <template v-else-if="section.kind === 'songs'">
        <mobile-song-row
          v-for="song in section.items"
          :key="song.id"
          :song="song"
          @play="$emit('play-song', song)"
          @open-actions="$emit('open-actions', song)"
        />
      </template>
      <template v-else-if="section.kind === 'playlists'">
        <mobile-playlist-row
          v-for="playlist in section.items"
          :key="playlist.id"
          :playlist="playlist"
          @play="$emit('play-playlist', playlist)"
        />
      </template>
      <template v-else>
        <!-- Play only: editing and deleting a station belong to the Radio
           - page, not to a search result. -->
        <mobile-radio-row
          v-for="station in section.items"
          :key="station.id"
          :station="station"
          @play="$emit('play-station', station)"
        />
      </template>
    </section>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import MobileAlbumRow from './MobileAlbumRow.vue'
import MobileArtistRow from './MobileArtistRow.vue'
import MobilePlaylistRow from './MobilePlaylistRow.vue'
import MobileRadioRow from './MobileRadioRow.vue'
import MobileSongRow from './MobileSongRow.vue'
import type { SearchSection, SearchSources } from '@/services/library/searchEverything'

export default {
  name: 'MobileSearchResults',
  components: { MobileAlbumRow, MobileArtistRow, MobilePlaylistRow, MobileRadioRow, MobileSongRow },
  props: {
    sections: {
      type: Array as PropType<SearchSection[]>,
      required: true,
    },
  },
  emits: ['show-all', 'play-song', 'play-album', 'play-playlist', 'play-station', 'open-actions'],
  methods: {
    titleOf(kind: keyof SearchSources): string {
      switch (kind) {
        case 'artists':
          return this.$t('search.artists')
        case 'albums':
          return this.$t('search.albums')
        case 'songs':
          return this.$t('search.songs')
        case 'playlists':
          return this.$t('nav.playlists')
        default:
          return this.$t('nav.radio')
      }
    },
    /** Playlists and stations have no half of the library to open, and a
     * term rarely matches more of them than the section already shows. */
    hasOwnList(kind: keyof SearchSources): boolean {
      return kind === 'artists' || kind === 'albums' || kind === 'songs'
    },
  },
}
</script>

<style scoped>
.mobile-search-results {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mobile-search-results__section {
  display: flex;
  flex-direction: column;
}

.mobile-search-results__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  margin-bottom: 4px;
}

.mobile-search-results__title {
  margin: 0;
}
</style>
