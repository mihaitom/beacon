<template>
  <v-container fluid>
    <v-text-field
      v-model="query"
      :label="$t('search.label')"
      prepend-inner-icon="mdi-magnify"
      variant="solo-filled"
      class="mb-4"
      clearable
      @update:model-value="onQueryChange"
    />

    <template v-if="libraryStore.searchResults.artists.length">
      <h2 class="section-title mb-2">{{ $t('search.artists') }}</h2>
      <v-list class="beacon-list mb-4">
        <v-list-item
          v-for="artist in libraryStore.searchResults.artists"
          :key="artist.id"
          :to="`/artists/${artist.id}`"
          :title="artist.name"
        >
          <template #prepend>
            <cover-art :cover-art-id="artist.coverArtId" :size="40" rounded class="mr-3" />
          </template>
        </v-list-item>
      </v-list>
    </template>

    <template v-if="libraryStore.searchResults.albums.length">
      <h2 class="section-title mb-2">{{ $t('search.albums') }}</h2>
      <div class="album-grid mb-4">
        <album-card
          v-for="album in libraryStore.searchResults.albums"
          :key="album.id"
          :album="album"
        />
      </div>
    </template>

    <template v-if="libraryStore.searchResults.tracks.length">
      <h2 class="section-title mb-2">{{ $t('search.tracks') }}</h2>
      <track-list
        :tracks="libraryStore.searchResults.tracks"
        show-cover
        show-album
        show-genre
        show-year
        show-play-count
        show-format
      />
    </template>

    <v-progress-circular v-if="libraryStore.loading" indeterminate />
    <v-alert v-else-if="query && !hasResults" type="info" variant="tonal">
      {{ $t('search.noResults', { query }) }}
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import CoverArt from '@/components/library/CoverArt.vue'
import AlbumCard from '@/components/library/AlbumCard.vue'
import TrackList from '@/components/library/TrackList.vue'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'SearchView',
  components: { CoverArt, AlbumCard, TrackList },
  data() {
    return {
      query: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    hasResults() {
      const r = this.libraryStore.searchResults
      return r.artists.length > 0 || r.albums.length > 0 || r.tracks.length > 0
    },
  },
  created() {
    if (typeof this.$route.query.q === 'string') {
      this.query = this.$route.query.q
      this.libraryStore.search(this.query)
    }
  },
  methods: {
    onQueryChange(value: string) {
      this.$router.replace({ query: { q: value || undefined } })
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => this.libraryStore.search(value ?? ''), 300)
    },
  },
}
</script>

<style scoped>
.album-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
</style>
