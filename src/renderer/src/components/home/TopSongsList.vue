<template>
  <!-- v-show, not v-if: the list has to exist from mount for its width to
   - be watched, even while there is nothing in it yet. -->
  <section v-show="songs.length || loading" class="top-songs">
    <div class="top-songs__head">
      <h2 class="section-title">{{ title }}</h2>
      <v-btn
        v-if="songs.length && !loading"
        icon="mdi-play-circle-outline"
        variant="text"
        size="small"
        density="comfortable"
        :title="$t('home.playAll')"
        @click="$emit('play-all', shown)"
      />
    </div>
    <!-- Ranked down the first column and on into the next, the way a chart
     - printed in columns reads. -->
    <ol ref="list" class="top-songs__list" :style="listStyle">
      <template v-if="loading">
        <li v-for="n in shownCount" :key="n" class="top-songs__skeleton">
          <v-skeleton-loader type="image" width="40" height="40" class="rounded" />
          <div class="top-songs__skeleton-text">
            <v-skeleton-loader type="text" width="60%" height="18" />
            <v-skeleton-loader type="text" width="35%" height="14" />
          </div>
        </li>
      </template>
      <template v-else>
        <li v-for="(song, index) in shown" :key="song.id">
          <song-card :song="song" row>
            <template #lead>
              <v-icon
                v-if="song.id === playingId"
                icon="mdi-volume-high"
                size="small"
                color="primary"
                :title="$t('home.nowPlaying')"
              />
              <span v-else class="text-body-small text-medium-emphasis">{{ index + 1 }}</span>
            </template>
            <template #figure>{{ $t('home.playCount', song.playCount) }}</template>
          </song-card>
        </li>
      </template>
    </ol>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import SongCard from '@/components/library/SongCard.vue'
import { usePlaybackStore } from '@/stores/playback'
import type { Song } from '@/types/library'

const ROWS = 5
// Section widths at which another column still leaves each title room next
// to the rank, the cover, the play count and the heart.
const TWO_COLUMNS_FROM = 760
const THREE_COLUMNS_FROM = 1500

/** Home's most played songs as a compact chart: ranked lines rather than a
 * song table, whose column headings and sort controls are tools for a list
 * you work through - this one is only read. Two columns of five, and a
 * third on a wide window, where two would only stretch each line further.
 * Clicking a line plays that song alone; the button by the heading plays
 * the ones shown. */
export default {
  name: 'TopSongsList',
  components: { SongCard },
  props: {
    title: { type: String, required: true },
    songs: { type: Array as PropType<Song[]>, required: true },
    loading: { type: Boolean, default: false },
  },
  emits: ['play-all'],
  data() {
    return {
      columns: 2,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  computed: {
    // A single column still shows two columns' worth.
    shownCount(): number {
      return Math.max(this.columns, 2) * ROWS
    },
    shown(): Song[] {
      return this.songs.slice(0, this.shownCount)
    },
    listStyle(): Record<string, string> {
      if (this.columns === 1) return {}
      return {
        gridTemplateColumns: `repeat(${this.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${ROWS}, auto)`,
        gridAutoFlow: 'column',
      }
    },
    playingId(): string | null {
      return usePlaybackStore().currentSong?.id ?? null
    },
  },
  mounted() {
    const list = this.$refs.list as HTMLElement | undefined
    if (!list) return
    const measure = (width: number) => {
      // Zero is a list not laid out yet (jsdom, a hidden tab), not a narrow one.
      if (width <= 0) return
      this.columns = width >= THREE_COLUMNS_FROM ? 3 : width >= TWO_COLUMNS_FROM ? 2 : 1
    }
    measure(list.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    this.resizeObserver = new ResizeObserver((entries) =>
      measure(entries[0]?.contentRect.width ?? 0),
    )
    this.resizeObserver.observe(list)
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
}
</script>

<style scoped>
.top-songs {
  margin-bottom: 40px;
}

.top-songs__head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
}

.top-songs__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 32px;
}

/* The height and the cover of SongCard.vue's row, so nothing moves when
 * the songs replace these. */
.top-songs__skeleton {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding-left: 46px;
}

.top-songs__skeleton-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.top-songs__skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
