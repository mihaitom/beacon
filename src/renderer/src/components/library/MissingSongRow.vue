<template>
  <!-- A track of the album the library does not hold (SongTable.vue's
   - edition), in the same columns as the songs around it, dimmed - which
   - is what says it is missing. Only the number, the title, the running
   - time and a menu with its preview and "Artist - Title" to copy: there
   - is nothing to star, rate or queue. -->
  <div
    class="missing-row"
    :class="{ 'missing-row--previewing': previewing }"
    :title="$t('library.notInLibrary')"
    @dblclick="togglePreview"
    @contextmenu.prevent="openMenu($event)"
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
        <div class="text-body-small text-medium-emphasis">{{ track.artist }}</div>
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
          icon="mdi-dots-vertical"
          variant="text"
          density="comfortable"
          size="small"
          :loading="starting"
          :title="$t('common.moreActions')"
          :aria-label="$t('common.moreActions')"
          @click.stop="openMenu($event)"
        />
      </div>

      <div v-else class="missing-col" :style="{ flex: column.flex, minWidth: column.minWidth }" />
    </template>

    <tile-context-menu ref="menu">
      <context-menu-section :label="$t('library.menuPlayback')" />
      <v-list-item :disabled="!canPreview" @click="togglePreview">
        <template #prepend><v-icon :icon="previewIcon" size="small" /></template>
        <v-list-item-title>{{ previewLabel }}</v-list-item-title>
      </v-list-item>
      <context-menu-section :label="$t('library.menuDetails')" />
      <v-list-item @click="copyArtistTitle">
        <template #prepend><v-icon icon="mdi-content-copy" size="small" /></template>
        <v-list-item-title>{{ $t('library.copyArtistTitle') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
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
import { emitter } from '@/emitter'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'

export default {
  name: 'MissingSongRow',
  components: { TileContextMenu, ContextMenuSection },
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
    openMenu(event: MouseEvent) {
      ;(this.$refs.menu as { open: (event: MouseEvent) => void } | undefined)?.open(event)
    },
    /** "Artist - Title", the shape a web search expects - what finding a
     * song the library lacks starts with. */
    async copyArtistTitle() {
      const text = `${this.track.artist} - ${this.track.title}`
      try {
        await navigator.clipboard.writeText(text)
        emitter.emit('toast', {
          level: 'success',
          title: this.$t('library.copyArtistTitle'),
          message: text,
        })
      } catch (error) {
        console.error('[missing-songs] Failed to copy artist and title:', error)
      }
    },
    /** Over the queue, which waits paused, like the playlist builder's
     * previews (the store's startTracksPreview()); a second one stops it. */
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
