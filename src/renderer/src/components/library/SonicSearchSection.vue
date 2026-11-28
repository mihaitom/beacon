<template>
  <!-- Only while it is searching or has found something: a heading over
   - nothing would read as an empty result for the whole search. -->
  <section v-if="loading || songs.length" class="sonic-search">
    <h2 class="section-title">{{ title }}</h2>
    <template v-if="compact">
      <div v-if="loading" class="sonic-search__loading">
        <v-skeleton-loader v-for="n in 3" :key="n" type="list-item-avatar-two-line" />
      </div>
      <template v-else>
        <mobile-song-row
          v-for="song in songs"
          :key="song.id"
          :song="song"
          @play="$emit('play-song', song)"
          @open-actions="$emit('open-actions', song)"
        />
      </template>
    </template>
    <!-- One song per click, like the matches above it (see SearchView.vue's
     - own comment): these fit a description, they are not an order. -->
    <song-table
      v-else
      :songs="songs"
      :loading="loading"
      :queue-whole-list="false"
      :default-sort-key="null"
    />
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import SongTable from './SongTable.vue'
import MobileSongRow from '@/components/mobile/MobileSongRow.vue'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { sonicSearch, type SonicSearchKind } from '@/services/connect/audiomuse'
import type { Song } from '@/types/library'

// The phone's search follows the field as it is typed and AudioMuse needs a
// second or more per query, so this waits for the typing to settle rather
// than starting a search on every pause and dropping all but the last.
const SETTLE_MS = 600

/**
 * Songs AudioMuse-AI finds for the search words by how they sound, or by
 * what their lyrics are about - under the ordinary matches, which never
 * wait for it. Nothing at all without AudioMuse.
 */
export default {
  name: 'SonicSearchSection',
  components: { SongTable, MobileSongRow },
  props: {
    kind: { type: String as PropType<SonicSearchKind>, required: true },
    query: { type: String, required: true },
    /** The phone's rows instead of the desktop's table. */
    compact: { type: Boolean, default: false },
    limit: { type: Number, default: 20 },
  },
  emits: ['play-song', 'open-actions', 'showing'],
  data() {
    return {
      songs: [] as Song[],
      loading: false,
      // Only the newest search may fill the list: an older one answering
      // late would otherwise replace what was typed after it.
      seq: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    available(): boolean {
      return useAudioMuseStore().available
    },
    title(): string {
      const key = this.kind === 'sound' ? 'search.bySound' : 'search.byLyrics'
      return this.$t(key, { query: this.query })
    },
    showing(): boolean {
      return this.loading || this.songs.length > 0
    },
  },
  watch: {
    query: { handler: 'schedule', immediate: true },
    available: 'schedule',
    showing(value: boolean) {
      this.$emit('showing', value)
    },
  },
  beforeUnmount() {
    clearTimeout(this.timer)
    this.seq += 1
  },
  methods: {
    schedule() {
      clearTimeout(this.timer)
      this.seq += 1
      this.songs = []
      const query = this.query.trim()
      if (!query || !this.available) {
        this.loading = false
        return
      }
      this.loading = true
      this.timer = setTimeout(() => void this.run(query), SETTLE_MS)
    },
    async run(query: string) {
      const seq = this.seq
      try {
        const songs = await sonicSearch(this.kind, query, this.limit)
        if (seq === this.seq) this.songs = songs
      } catch (error) {
        console.warn(`[search] AudioMuse ${this.kind} search failed:`, error)
      } finally {
        if (seq === this.seq) this.loading = false
      }
    },
  },
}
</script>

<style scoped>
.sonic-search {
  margin-top: 24px;
}

.sonic-search .section-title {
  margin-bottom: 8px;
}
</style>
