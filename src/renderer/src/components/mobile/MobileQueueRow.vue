<template>
  <div
    class="mobile-queue-row mobile-row"
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
      <!-- See QueueRow.vue's identical split: `audible`, not `isCurrent`,
       - so a station playing over the queue doesn't leave a speaker icon
       - on a song nobody is hearing. -->
      <v-icon v-if="audible" icon="mdi-volume-high" size="14" color="primary" />
      <template v-else>{{ index + 1 }}</template>
    </div>
    <cover-art
      :cover-art-id="song.coverArtId"
      :size="MOBILE_ROW_ART_SIZE"
      class="mobile-row__art mobile-queue-row__art"
    />
    <div class="mobile-row__text">
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
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import type { Song } from '@/types/library'

export default {
  name: 'MobileQueueRow',
  components: { CoverArt },
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
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
    /** Whether isCurrent is also what's actually audible — false while a
     * radio station plays over the queue. Only the speaker icon turns on
     * this; the highlight and the un-removable current row follow
     * isCurrent either way. */
    audible: {
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
  border-top: 2px solid transparent;
  touch-action: pan-y;
}

.mobile-queue-row--current {
  background: rgba(var(--v-theme-primary), 0.08);
}

/* Doubled class, deliberately: .mobile-row (assets/base.css) now draws a
 * hairline on this same edge, and a single class would only tie with it —
 * leaving which one wins up to stylesheet order, i.e. up to a drop
 * indicator quietly rendering as a hairline. */
.mobile-queue-row--drag-over-before.mobile-queue-row--drag-over-before {
  border-top-color: rgb(var(--v-theme-primary));
}

.mobile-queue-row--drag-over-after.mobile-queue-row--drag-over-after {
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
</style>
