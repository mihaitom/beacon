<template>
  <v-container fluid>
    <detail-header fallback-icon="mdi-music-note" :eyebrow="$t('library.genre')" :title="genreName">
      <template v-if="tracks.length" #meta>
        {{ $t('library.albumsAndSongs', { albums: albumCount, songs: tracks.length }) }}
      </template>
      <template #actions>
        <v-btn
          color="primary"
          rounded="pill"
          prepend-icon="mdi-shuffle-variant"
          :disabled="!tracks.length"
          @click="playRandom"
        >
          {{ $t('library.playRandom') }}
        </v-btn>
      </template>
    </detail-header>

    <sticky-filter>
      <v-text-field
        v-model="filterQuery"
        :label="$t('common.filter')"
        prepend-inner-icon="mdi-filter-variant"
        variant="solo-filled"
        density="compact"
        clearable
        class="mb-4"
        style="max-width: 320px"
      />
    </sticky-filter>

    <page-loader v-if="libraryStore.loading" />
    <v-alert v-else-if="libraryStore.error" type="error" variant="tonal" class="mb-4">
      {{ libraryStore.error }}
    </v-alert>
    <template v-else>
      <track-list
        :tracks="filteredTracks"
        :queue-whole-list="false"
        show-cover
        show-album
        show-year
        show-play-count
        show-format
      />
      <v-alert v-if="filteredTracks.length === 0" type="info" variant="tonal">
        {{
          filterQuery
            ? $t('library.noTracksForQuery', { query: filterQuery })
            : $t('library.noTracksFound')
        }}
      </v-alert>
    </template>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import DetailHeader from '@/components/library/DetailHeader.vue'
import TrackList from '@/components/library/TrackList.vue'
import PageLoader from '@/components/PageLoader.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { Track } from '@/types/library'

const RANDOM_PLAY_COUNT = 100

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'GenreDetailView',
  components: { DetailHeader, TrackList, PageLoader, StickyFilter },
  data() {
    return {
      tracks: [] as Track[],
      filterQuery: '',
      // filteredTracks reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in TracksView.vue.
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    genreName(): string {
      return decodeURIComponent(this.$route.params.name as string)
    },
    albumCount(): number {
      return new Set(this.tracks.map((track) => track.albumId)).size
    },
    filteredTracks(): Track[] {
      const query = this.debouncedQuery.trim().toLowerCase()
      if (!query) return this.tracks
      return this.tracks.filter(
        (track) =>
          track.title.toLowerCase().includes(query) ||
          track.artist.toLowerCase().includes(query) ||
          track.album.toLowerCase().includes(query),
      )
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
    '$route.params.name': 'loadTracks',
  },
  created() {
    this.loadTracks()
  },
  methods: {
    async loadTracks() {
      const name = this.genreName
      try {
        const tracks = await this.libraryStore.fetchSongsByGenre(name)
        // A newer navigation may have already resolved and moved the route
        // on while this fetch was in flight — don't let a slower, stale
        // response overwrite what's actually being viewed now.
        if (this.genreName === name) this.tracks = tracks
      } catch (error) {
        if (this.genreName !== name) return
        console.error('[genre-detail] Failed to load tracks:', error)
      }
    },
    async playRandom() {
      if (!this.tracks.length) return
      const sample = shuffled(this.tracks).slice(0, RANDOM_PLAY_COUNT)
      await usePlaybackStore().playTrackList(sample, 0)
    },
  },
}

function shuffled(tracks: Track[]): Track[] {
  const result = [...tracks]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}
</script>
