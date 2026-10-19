<template>
  <section v-if="songs.length || loading" class="top-songs">
    <div class="top-songs__head">
      <h2 class="section-title">{{ title }}</h2>
      <v-btn
        v-if="songs.length && !loading"
        icon="mdi-play-circle-outline"
        variant="text"
        size="small"
        density="comfortable"
        :title="$t('home.playAll')"
        @click="$emit('play-all')"
      />
    </div>
    <!-- Ranked down the first column and on into the second, the way a
     - chart printed in two columns reads. -->
    <ol class="top-songs__list">
      <template v-if="loading">
        <li v-for="n in placeholderCount" :key="n" class="top-songs__skeleton">
          <v-skeleton-loader type="image" width="40" height="40" class="rounded" />
          <div class="top-songs__skeleton-text">
            <v-skeleton-loader type="text" width="60%" height="18" />
            <v-skeleton-loader type="text" width="35%" height="14" />
          </div>
        </li>
      </template>
      <template v-else>
        <li v-for="(song, index) in songs" :key="song.id">
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
import { HOME_TOP_SONGS } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { Song } from '@/types/library'

/** Home's most played songs as a compact chart: two columns of ranked
 * lines rather than a song table, whose column headings and sort controls
 * are tools for a list you work through - this one is only read. Clicking a
 * line plays that song alone; the button by the heading plays them all. */
export default {
  name: 'TopSongsList',
  components: { SongCard },
  props: {
    title: { type: String, required: true },
    songs: { type: Array as PropType<Song[]>, required: true },
    loading: { type: Boolean, default: false },
  },
  emits: ['play-all'],
  computed: {
    placeholderCount(): number {
      return HOME_TOP_SONGS
    },
    playingId(): string | null {
      return usePlaybackStore().currentSong?.id ?? null
    },
  },
}
</script>

<style scoped>
.top-songs {
  margin-bottom: 40px;
  container-type: inline-size;
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
  grid-template-columns: 1fr;
  column-gap: 32px;
}

/* Two columns once each can still hold a title of reasonable length next
 * to the rank, the cover, the play count and the heart. */
@container (min-width: 760px) {
  .top-songs__list {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: repeat(5, auto);
    grid-auto-flow: column;
  }
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
