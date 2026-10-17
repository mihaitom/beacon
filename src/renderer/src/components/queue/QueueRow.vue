<template>
  <div
    class="queue-row"
    :class="{
      'queue-row--current': isCurrent,
      'queue-row--drag-over-before': dragOverPosition === 'before',
      'queue-row--drag-over-after': dragOverPosition === 'after',
      'queue-row--dragging': dragging,
      'queue-row--landed': landed,
    }"
    :draggable="lockedNext ? 'false' : 'true'"
    @dragstart="$emit('dragstart', index, $event)"
    @dragend="$emit('dragend')"
    @dragover.prevent="$emit('dragover', index, $event)"
    @dragleave="$emit('dragleave', index)"
    @drop="$emit('drop', index, $event)"
    @contextmenu.prevent="$emit('menu', index, $event)"
    @click="playbackStore.playAtIndex(index)"
  >
    <div class="queue-row__index text-body-small text-medium-emphasis">
      <!-- audible, not isCurrent: the row stays marked as where the queue
       - stands while a radio station plays over the top of it, but a
       - speaker icon there would be claiming this song is what you are
       - hearing. -->
      <v-icon v-if="audible" icon="mdi-volume-high" size="14" color="primary" />
      <!-- A song the mix has settled on stays put - see the playback
         - store's lockedNextIndex. -->
      <v-icon
        v-else-if="lockedNext"
        icon="mdi-lock-outline"
        :title="$t('queue.nextLocked')"
        size="16"
      />
      <template v-else>{{ index + 1 }}</template>
    </div>
    <cover-art :cover-art-id="song.coverArtId" :size="36" class="queue-row__cover" />
    <div class="queue-row__info">
      <div class="text-body-medium" :class="{ 'text-primary': isCurrent }">
        {{ song.title }}
      </div>
      <div class="text-body-small text-medium-emphasis queue-row__subtitle">
        <!-- Not draggable itself, or grabbing the row by its artist would
           - drag the link instead of the row. -->
        <router-link
          v-if="song.artistId"
          :to="`/artists/${song.artistId}`"
          draggable="false"
          class="queue-row__artist queue-row__artist-link"
          @click.stop
        >
          {{ song.artist }}
        </router-link>
        <span v-else class="queue-row__artist">{{ song.artist }}</span>
        <!-- A party guest's wish: who asked for it, so the host can tell
         - their own queue from the guests'. -->
        <span
          v-if="wishedBy"
          class="queue-row__wish"
          :title="$t('party.wishedBy', { name: wishedBy })"
        >
          <v-icon icon="mdi-party-popper" size="12" color="primary" />
          {{ wishedBy }}
        </span>
      </div>
    </div>
    <span class="text-body-small text-medium-emphasis queue-row__duration">{{
      formattedDuration
    }}</span>
    <v-btn
      icon="mdi-close"
      size="small"
      variant="text"
      :disabled="isCurrent || lockedNext"
      :title="$t('queue.remove')"
      :aria-label="$t('queue.remove')"
      @click.stop="playbackStore.removeFromQueue(index)"
    />
  </div>
</template>

<script lang="ts">
import CoverArt from '@/components/library/CoverArt.vue'
import { usePlaybackStore } from '@/stores/playback'
import { usePartyStore } from '@/stores/party'
import type { Song } from '@/types/library'

/** The drawer's drag in progress, shared with every row rather than handed
 * down as props: a prop the list passes re-renders the whole list on every
 * dragover, while each row reading this re-renders only when its own
 * indicator changes. */
export interface QueueDragState {
  /** The row being dragged. */
  from: number | null
  /** The row under the pointer, and which side of it the drop would land. */
  over: number | null
  half: 'before' | 'after' | null
}

export default {
  name: 'QueueRow',
  components: { CoverArt },
  inject: {
    queueDrag: { default: null },
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
    landed: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend', 'menu'],
  computed: {
    // Which side of *this* row the dragged item would land on if dropped
    // right now — 'before' shows a line above the row, 'after' below.
    // Two distinct positions (not just one boolean) because a single
    // "drag-over" indicator can't tell the user which side of a boundary
    // row they're actually about to land on, and picking the wrong side is
    // exactly what made "swap with the very next track" so easy to
    // overshoot by one — see QueueDrawer.vue's insertBeforeIndex().
    drag(this: { queueDrag: QueueDragState | null }): QueueDragState | null {
      return this.queueDrag
    },
    dragOverPosition(): 'before' | 'after' | null {
      const drag = this.drag
      if (!drag || drag.over !== this.index || drag.from === this.index) return null
      return drag.half
    },
    dragging(): boolean {
      return this.drag?.from === this.index
    },
    playbackStore() {
      return usePlaybackStore()
    },
    isCurrent() {
      return this.index === this.playbackStore.currentIndex
    },
    lockedNext() {
      return this.index === this.playbackStore.lockedNextIndex
    },
    /** isCurrent says where the queue stands; this says whether that is
     * also what's coming out of the speakers. The two only differ while a
     * radio station is playing, which interrupts the queue without
     * discarding it (see the playback store's currentSong). */
    audible() {
      return this.isCurrent && this.playbackStore.radioStation == null
    },
    wishedBy(): string | null {
      return usePartyStore().requestAt(this.index)?.guestName ?? null
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
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 56px;
  /* The whole row is the handle; a click still plays it. */
  cursor: grab;
  border-top: 2px solid transparent;
  background: rgb(var(--v-theme-surface));
  transition:
    opacity 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

/* The artist gives way before the wisher's name does: the name is the
 * reason this line is longer than usual. */
.queue-row__subtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.queue-row__artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.queue-row__wish {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  max-width: 50%;
  overflow: hidden;
  white-space: nowrap;
}

.queue-row:active {
  cursor: grabbing;
}

/* Nothing to grab on the song the mix has settled on. */
.queue-row[draggable='false'] {
  cursor: pointer;
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

/* A shadow, not a border: a border here made the row 2px taller, and every
 * row below it shifted - and animated the shift - each time the pointer
 * crossed a row's middle. */
.queue-row--drag-over-after {
  box-shadow: inset 0 -2px 0 rgb(var(--v-theme-primary));
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

.queue-row__index {
  flex: 0 0 28px;
  text-align: center;
}

.queue-row__artist-link {
  color: inherit;
  text-decoration: none;
}

.queue-row__artist-link:hover {
  text-decoration: underline;
}

/* The cover is an image, which the browser would otherwise drag on its own
 * in place of the row. */
.queue-row :deep(img) {
  -webkit-user-drag: none;
}

.queue-row__cover {
  flex-shrink: 0;
}

.queue-row__info {
  flex: 1;
  min-width: 0;
}

.queue-row__duration {
  flex-shrink: 0;
  padding: 0 4px;
}

.min-width-0 {
  min-width: 0;
}

/* Title and artist each stay on their own single line. */
.queue-row__info > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-row__cover {
  margin-inline: 8px;
}
</style>
