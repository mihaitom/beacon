<template>
  <div
    class="queue-row d-flex align-center px-2"
    :class="{
      'queue-row--current': isCurrent,
      'queue-row--drag-over-before': dragOverPosition === 'before',
      'queue-row--drag-over-after': dragOverPosition === 'after',
      'queue-row--dragging': dragging,
      'queue-row--landed': landed,
    }"
    @dragover.prevent="$emit('dragover', $event)"
    @dragleave="$emit('dragleave')"
    @drop="$emit('drop', $event)"
    @click="playbackStore.playAtIndex(index)"
  >
    <v-icon
      icon="mdi-drag-vertical"
      size="18"
      class="queue-row__handle text-medium-emphasis mr-1"
      draggable="true"
      @click.stop
      @dragstart="$emit('dragstart', $event)"
      @dragend="$emit('dragend')"
    />
    <div class="queue-row__index text-body-small text-medium-emphasis">
      <v-icon v-if="isCurrent" icon="mdi-volume-high" size="14" color="primary" />
      <template v-else>{{ index + 1 }}</template>
    </div>
    <cover-art :cover-art-id="song.coverArtId" :size="36" class="queue-row__cover mx-2" />
    <div class="queue-row__info min-width-0 flex-grow-1">
      <div class="text-body-medium text-truncate" :class="{ 'text-primary': isCurrent }">
        {{ song.title }}
      </div>
      <div class="text-body-small text-medium-emphasis text-truncate">{{ song.artist }}</div>
    </div>
    <span class="text-body-small text-medium-emphasis queue-row__duration">{{
      formattedDuration
    }}</span>
    <v-btn
      icon="mdi-close"
      size="small"
      variant="text"
      :disabled="isCurrent"
      @click.stop="playbackStore.removeFromQueue(index)"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { usePlaybackStore } from '@/stores/playback'
import type { Song } from '@/types/library'

export default {
  name: 'QueueRow',
  components: { CoverArt },
  props: {
    song: {
      type: Object as () => Song,
      required: true,
    },
    index: {
      type: Number,
      required: true,
    },
    // Which side of *this* row the dragged item would land on if dropped
    // right now — 'before' shows a line above the row, 'after' below.
    // Two distinct positions (not just one boolean) because a single
    // "drag-over" indicator can't tell the user which side of a boundary
    // row they're actually about to land on, and picking the wrong side is
    // exactly what made "swap with the very next track" so easy to
    // overshoot by one — see QueueDrawer.vue's insertBeforeIndex().
    dragOverPosition: {
      type: String as () => 'before' | 'after' | null,
      default: null,
    },
    dragging: {
      type: Boolean,
      default: false,
    },
    landed: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend'],
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    isCurrent() {
      return this.index === this.playbackStore.currentIndex
    },
    formattedDuration() {
      const total = Math.round(this.song.duration ?? 0)
      const minutes = Math.floor(total / 60)
      const secs = total % 60
      return `${minutes}:${String(secs).padStart(2, '0')}`
    },
  },
}
</script>

<style scoped>
.queue-row {
  height: 56px;
  cursor: pointer;
  border-top: 2px solid transparent;
  background: rgb(var(--v-theme-surface));
  transition:
    opacity 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.queue-row:hover {
  background: var(--beacon-hover);
}

.queue-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.queue-row--drag-over-before {
  border-top-color: rgb(var(--v-theme-primary));
}

.queue-row--drag-over-after {
  border-bottom: 2px solid rgb(var(--v-theme-primary));
}

.queue-row--dragging {
  opacity: 0.4;
}

.queue-row--landed {
  animation: queue-row-landed 0.5s ease;
}

@keyframes queue-row-landed {
  0% {
    transform: scale(1.015);
    box-shadow: inset 0 0 0 1px rgba(var(--v-theme-primary), 0.5);
  }
  100% {
    transform: scale(1);
    box-shadow: inset 0 0 0 1px rgba(var(--v-theme-primary), 0);
  }
}

.queue-row__handle {
  cursor: grab;
  flex-shrink: 0;
}

.queue-row__index {
  flex: 0 0 20px;
  text-align: center;
}

.queue-row__cover {
  flex-shrink: 0;
}

.queue-row__info {
  min-width: 0;
}

.queue-row__duration {
  flex-shrink: 0;
  padding: 0 4px;
}

.min-width-0 {
  min-width: 0;
}
</style>
