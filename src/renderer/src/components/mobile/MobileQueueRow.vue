<template>
  <div
    class="mobile-queue-row d-flex align-center"
    :data-index="index"
    :class="{
      'mobile-queue-row--current': isCurrent,
      'mobile-queue-row--drag-over-before': dragOverPosition === 'before',
      'mobile-queue-row--drag-over-after': dragOverPosition === 'after',
      'mobile-queue-row--dragging': dragging,
    }"
    @click="!dragging && $emit('play')"
  >
    <div class="mobile-queue-row__index text-body-small text-medium-emphasis">
      <v-icon v-if="isCurrent" icon="mdi-volume-high" size="14" color="primary" />
      <template v-else>{{ index + 1 }}</template>
    </div>
    <cover-art :cover-art-id="song.coverArtId" :size="40" class="mx-2 flex-shrink-0" />
    <div class="min-width-0 flex-grow-1">
      <div class="text-body-medium text-truncate" :class="{ 'text-primary': isCurrent }">
        {{ song.title }}
      </div>
      <div class="text-body-small text-medium-emphasis text-truncate">{{ song.artist }}</div>
    </div>
    <v-btn
      icon="mdi-close"
      size="small"
      variant="text"
      :disabled="isCurrent"
      @click.stop="$emit('remove')"
    />
    <v-icon
      icon="mdi-drag-vertical"
      size="22"
      class="mobile-queue-row__handle text-medium-emphasis ml-1"
      @pointerdown.stop="$emit('drag-start', $event)"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import type { Song } from '@/types/library'

export default {
  name: 'MobileQueueRow',
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
    isCurrent: {
      type: Boolean,
      default: false,
    },
    // Which side of *this* row the dragged item would land on if dropped
    // right now — see MobileQueueView.vue's insertBeforeIndex() for why a
    // single boolean isn't enough to represent that.
    dragOverPosition: {
      type: String as () => 'before' | 'after' | null,
      default: null,
    },
    dragging: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['play', 'remove', 'drag-start'],
}
</script>

<style scoped>
.mobile-queue-row {
  min-height: 56px;
  padding: 0 8px;
  border-top: 2px solid transparent;
  touch-action: pan-y;
}

.mobile-queue-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

.mobile-queue-row--drag-over-before {
  border-top-color: rgb(var(--v-theme-primary));
}

.mobile-queue-row--drag-over-after {
  border-bottom: 2px solid rgb(var(--v-theme-primary));
}

.mobile-queue-row--dragging {
  opacity: 0.4;
}

.mobile-queue-row__index {
  flex: 0 0 20px;
  text-align: center;
}

.mobile-queue-row__handle {
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

.min-width-0 {
  min-width: 0;
}
</style>
