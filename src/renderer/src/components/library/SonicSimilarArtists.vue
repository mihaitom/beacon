<template>
  <!-- Nothing at all until there is something: on a page that has already
   - settled, a placeholder for a row that may never come would only jump. -->
  <section v-if="artists.length && compact" class="sonic-similar-artists">
    <h2 class="section-title">{{ $t('library.soundsSimilar') }}</h2>
    <div class="sonic-similar-artists__list">
      <mobile-artist-row v-for="artist in artists" :key="artist.id" :artist="artist" />
    </div>
  </section>
  <card-shelf v-else-if="artists.length" :title="$t('library.soundsSimilar')">
    <artist-card v-for="artist in artists" :key="artist.id" :artist="artist" />
  </card-shelf>
</template>

<script lang="ts">
import CardShelf from './CardShelf.vue'
import ArtistCard from './ArtistCard.vue'
import MobileArtistRow from '@/components/mobile/MobileArtistRow.vue'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { sonicSimilarArtists } from '@/services/connect/audiomuse'
import type { Artist } from '@/types/library'

const DESKTOP_COUNT = 12
// A list rather than a scrolling row, so fewer of them.
const PHONE_COUNT = 5

/** Artists of the library that AudioMuse-AI hears as close to this one -
 * by the music itself, so also ones no tag or listener statistic connects.
 * Hides itself without AudioMuse, or when it finds nobody. */
export default {
  name: 'SonicSimilarArtists',
  components: { CardShelf, ArtistCard, MobileArtistRow },
  props: {
    artistId: { type: String, required: true },
    /** The phone's rows instead of the desktop's cards. */
    compact: { type: Boolean, default: false },
  },
  data() {
    return {
      artists: [] as Artist[],
      // Only the answer for the artist still shown may land.
      seq: 0,
    }
  },
  computed: {
    available(): boolean {
      return useAudioMuseStore().available
    },
  },
  watch: {
    artistId: { handler: 'load', immediate: true },
    available: 'load',
  },
  created() {
    void useAudioMuseStore().ensure()
  },
  methods: {
    async load() {
      const seq = ++this.seq
      this.artists = []
      if (!this.available) return
      try {
        const artists = await sonicSimilarArtists(
          this.artistId,
          this.compact ? PHONE_COUNT : DESKTOP_COUNT,
        )
        if (seq === this.seq) this.artists = artists
      } catch (error) {
        console.warn('[artist] AudioMuse similar artists failed:', error)
      }
    },
  },
}
</script>

<style scoped>
/* The phone's artist page's own list rhythm (MobileArtistDetailView.vue). */
.sonic-similar-artists__list {
  display: flex;
  flex-direction: column;
  margin-bottom: 24px;
}
</style>
