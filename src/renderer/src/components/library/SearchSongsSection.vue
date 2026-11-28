<template>
  <section class="search-songs">
    <div class="search-songs__header">
      <h2 class="section-title">{{ title }}</h2>
      <!-- Stays in both states, so the list folds back as well. -->
      <v-btn v-if="folds" variant="text" size="small" @click="toggle">
        {{
          expanded
            ? $t('library.showLess')
            : $t('library.showAllMatches', { count: $n(songs.length) })
        }}
      </v-btn>
    </div>
    <!-- One song per click, not the whole list: a search result is a list
     - of things that merely match, not a sequence anyone meant to listen to
     - in order. The row's own menu still offers Play next, Add to queue and
     - Song Radio for building a queue on purpose.
     -
     - default-sort-key null keeps the order the matches were ranked in
     - (best first) instead of re-sorting them alphabetically, which would
     - bury an exact title behind every other match. A click on a column
     - still sorts them. -->
    <song-table
      :songs="shownSongs"
      :loading="loading"
      :queue-whole-list="false"
      :default-sort-key="null"
    />
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import SongTable from './SongTable.vue'
import type { Song } from '@/types/library'

// The search page stacks several song lists, and a common word can match
// a hundred titles: folded to this many, what comes after - AudioMuse's
// "sounds like" and lyrics sections - stays within reach. Ten is about a
// screen of rows. Only with something after it (`foldable`): the last list
// on the page hides nothing by being long.
const COLLAPSED_COUNT = 10

/** One of the search page's song lists, folded to its first matches. */
export default {
  name: 'SearchSongsSection',
  components: { SongTable },
  props: {
    title: { type: String, required: true },
    songs: { type: Array as PropType<Song[]>, required: true },
    loading: { type: Boolean, default: false },
    /** Whether another section follows that a long list would push away. */
    foldable: { type: Boolean, default: false },
  },
  data() {
    return {
      COLLAPSED_COUNT,
      expanded: false,
    }
  },
  computed: {
    folds(): boolean {
      return this.foldable && this.songs.length > COLLAPSED_COUNT
    },
    shownSongs(): Song[] {
      return this.folds && !this.expanded ? this.songs.slice(0, COLLAPSED_COUNT) : this.songs
    },
  },
  watch: {
    // A new search starts folded again.
    songs() {
      this.expanded = false
    },
  },
  methods: {
    toggle() {
      this.expanded = !this.expanded
    },
  },
}
</script>

<style scoped>
.search-songs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
</style>
