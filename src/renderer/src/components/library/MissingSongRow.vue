<template>
  <!-- A track of the album the library does not hold (SongTable.vue's
   - missingTracks), in the same columns as the songs around it. Only the
   - number, the title, the running time and a preview of it - there is
   - nothing to star, rate or queue. -->
  <div
    class="missing-row"
    :class="{ 'missing-row--previewing': previewing }"
    :title="$t('library.notInLibrary')"
    @dblclick="togglePreview"
  >
    <template v-for="column in columns" :key="column.key">
      <div
        v-if="column.cell === 'index'"
        class="missing-col missing-col--end text-body-small text-medium-emphasis"
        :style="{ flex: column.flex, minWidth: column.minWidth }"
      >
        <v-icon v-if="previewing" icon="mdi-headphones" size="14" color="primary" />
        <template v-else>{{ track.trackNumber || '' }}</template>
      </div>

      <div
        v-else-if="column.cell === 'title'"
        class="missing-col missing-col--text"
        :style="{ flex: column.flex, minWidth: column.minWidth }"
      >
        <div class="text-body-medium" :class="{ 'text-primary': previewing }">
          {{ track.title }}
        </div>
        <div class="text-body-small text-medium-emphasis">
          {{ $t('library.notInLibrary') }}
        </div>
      </div>

      <div
        v-else-if="column.key === 'duration'"
        class="missing-col missing-col--end text-body-small text-medium-emphasis"
        :style="{ flex: column.flex, minWidth: column.minWidth }"
      >
        {{ duration }}
      </div>

      <div
        v-else-if="column.cell === 'actions'"
        class="missing-col missing-col--actions"
        :style="{ flex: column.flex, minWidth: column.minWidth }"
      >
        <v-btn
          :icon="previewIcon"
          :color="previewing ? 'primary' : undefined"
          variant="text"
          density="comfortable"
          size="small"
          :loading="starting"
          :disabled="!canPreview"
          :title="previewLabel"
          :aria-label="previewLabel"
          @click.stop="togglePreview"
        />
      </div>

      <div v-else class="missing-col" :style="{ flex: column.flex, minWidth: column.minWidth }" />
    </template>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { deezerPreviewSong } from '@/services/playback/preview'
import { previewHeardByGuests } from '@/services/playback/previewAvailability'
import { formatDuration } from '@/services/library/songFormat'
import type { SongColumn } from '@/services/library/songColumns'
import type { DeezerAlbumTrack } from '@/services/connect/deezer'

export default {
  name: 'MissingSongRow',
  props: {
    track: { type: Object as PropType<DeezerAlbumTrack>, required: true },
    columns: { type: Array as PropType<SongColumn[]>, required: true },
  },
  data() {
    return { starting: false }
  },
  computed: {
    previewSongId(): string {
      return deezerPreviewSong(this.track.deezerId, this.track).id
    },
    previewing(): boolean {
      const playback = usePlaybackStore()
      return !!playback.preview && playback.currentSong?.id === this.previewSongId
    },
    canPreview(): boolean {
      return this.track.deezerId > 0 && !previewHeardByGuests()
    },
    previewIcon(): string {
      if (!this.track.deezerId) return 'mdi-music-note-off'
      return this.previewing ? 'mdi-stop' : 'mdi-play'
    },
    previewLabel(): string {
      if (!this.track.deezerId) return this.$t('builder.noPreview')
      return this.previewing ? this.$t('builder.stopPreview') : this.$t('builder.preview')
    },
    duration(): string {
      return this.track.duration ? (formatDuration(this.track.duration) ?? '') : ''
    },
  },
  methods: {
    /** Over the queue, which waits paused, like the playlist builder's
     * previews (the store's startTracksPreview()); a second click stops it. */
    async togglePreview() {
      const playback = usePlaybackStore()
      if (this.previewing) {
        playback.endPreview()
        return
      }
      if (!this.canPreview || this.starting) return
      this.starting = true
      try {
        const song = deezerPreviewSong(this.track.deezerId, this.track)
        await playback.startTracksPreview([song])
      } finally {
        this.starting = false
      }
    },
  },
}
</script>

<style scoped>
/* The box of SongRow.vue's .song-row, so the columns line up with the
 * songs around it; dimmed, because it is not in the library. */
.missing-row {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  gap: 12px;
  border-radius: 4px;
  user-select: none;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}

.missing-row:hover,
.missing-row--previewing {
  opacity: 1;
  background: var(--beacon-hover);
}

.missing-col {
  min-width: 0;
}

.missing-col--text > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.missing-col--end {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.missing-col--actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
</style>
