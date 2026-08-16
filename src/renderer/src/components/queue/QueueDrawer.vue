<template>
  <!-- No `temporary` — persistent/docked, not an overlay: stays open across
   - navigation and doesn't close on an outside click. -->
  <v-navigation-drawer
    :model-value="modelValue"
    location="right"
    width="380"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column fill-height">
      <v-toolbar density="compact" :title="$t('queue.title')" />

      <template v-if="playbackStore.queue.length">
        <!-- Real Vue move animation (TransitionGroup's FLIP-based .move class)
         - for anything reasonably sized — this is what actually animates a
         - drag-reorder sliding into place. Only falls back to
         - v-virtual-scroll (see below) past QUEUE_VIRTUALIZE_THRESHOLD,
         - where mounting every row at once risks freezing/crashing the
         - renderer (the scenario that made v-virtual-scroll necessary here
         - in the first place — see its comment) and a real per-row
         - transition wouldn't have anything correct to animate from anyway,
         - since off-screen rows aren't in the DOM to begin with. -->
        <transition-group
          v-if="!virtualizeQueue"
          tag="div"
          name="queue-move"
          class="flex-grow-1 queue-scroll"
        >
          <queue-row
            v-for="(track, index) in playbackStore.queue"
            :key="queueRowKey(track)"
            :track="track"
            :index="index"
            :drag-over="dragOverIndex === index && dragIndex !== index"
            :dragging="dragIndex === index"
            :landed="queueRowKey(track) === landedKey"
            @dragstart="onDragStart(index, $event)"
            @dragover="onDragOver(index)"
            @dragleave="onDragLeave(index)"
            @drop="onDrop(index)"
            @dragend="onDragEnd"
          />
        </transition-group>

        <v-virtual-scroll
          v-else
          :items="playbackStore.queue"
          item-height="56"
          class="flex-grow-1"
          style="min-height: 0"
        >
          <template #default="{ item: track, index }">
            <queue-row
              :key="queueRowKey(track)"
              :track="track"
              :index="index"
              :drag-over="dragOverIndex === index && dragIndex !== index"
              :dragging="dragIndex === index"
              :landed="queueRowKey(track) === landedKey"
              @dragstart="onDragStart(index, $event)"
              @dragover="onDragOver(index)"
              @dragleave="onDragLeave(index)"
              @drop="onDrop(index)"
              @dragend="onDragEnd"
            />
          </template>
        </v-virtual-scroll>
      </template>

      <v-list-item v-else>
        <span class="text-medium-emphasis text-body-2">{{ $t('queue.empty') }}</span>
      </v-list-item>
    </div>
  </v-navigation-drawer>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import QueueRow from './QueueRow.vue'
import type { Track } from '@/types/library'

// Per-row identity for :key and the "landed" flash, keyed off the Track
// *object* rather than its id — the queue can legitimately hold the same
// track more than once (see playbackStore's dedupeForQueue()), and an
// id-keyed Set/Map would make both occurrences resolve to the same key,
// producing a Vue duplicate-key warning and mixing up which row the FLIP
// move animation / landed pulse actually targets. A WeakMap survives
// reorderQueue() unaffected since that moves the same object reference to a
// new array index rather than replacing it.
let queueRowKeySeq = 0
const queueRowKeys = new WeakMap<Track, string>()
function queueRowKey(track: Track): string {
  let key = queueRowKeys.get(track)
  if (key === undefined) {
    key = `qrow-${queueRowKeySeq++}`
    queueRowKeys.set(track, key)
  }
  return key
}

// Past this many tracks, switch from an animated plain v-for to
// v-virtual-scroll instead — comfortably above any realistic queue built
// from actual queueing actions (Track Radio caps at 100, "Play next"/"Add
// to queue" add one track at a time), but well under what actually risks
// freezing the renderer (that took ~20,000 — see git history / the
// v-virtual-scroll comment below for the incident this guards against).
const QUEUE_VIRTUALIZE_THRESHOLD = 500

export default {
  name: 'QueueDrawer',
  components: { QueueRow },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      // Native HTML5 drag & drop, not a library — has to work across both
      // rendering paths below (plain v-for and v-virtual-scroll), and a
      // library wired to assume every row is mounted wouldn't survive the
      // virtualized path.
      dragIndex: null as number | null,
      dragOverIndex: null as number | null,
      // Briefly set to the moved row's queueRowKey() right after a drop, so
      // it gets a "landed here" pulse on top of the slide animation (or, in
      // the virtualized path with no slide, as the only landing feedback).
      landedKey: null as string | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    virtualizeQueue(): boolean {
      return this.playbackStore.queue.length > QUEUE_VIRTUALIZE_THRESHOLD
    },
  },
  methods: {
    queueRowKey,
    onDragStart(index: number, event: DragEvent) {
      this.dragIndex = index
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        // Firefox requires setData for the drag to actually start.
        event.dataTransfer.setData('text/plain', String(index))
      }
    },
    onDragOver(index: number) {
      this.dragOverIndex = index
    },
    onDragLeave(index: number) {
      if (this.dragOverIndex === index) this.dragOverIndex = null
    },
    onDrop(index: number) {
      if (this.dragIndex !== null && this.dragIndex !== index) {
        const moved = this.playbackStore.queue[this.dragIndex]
        this.playbackStore.reorderQueue(this.dragIndex, index)
        if (moved) this.flashLanded(this.queueRowKey(moved))
      }
      this.dragIndex = null
      this.dragOverIndex = null
    },
    flashLanded(key: string) {
      this.landedKey = key
      setTimeout(() => {
        if (this.landedKey === key) this.landedKey = null
      }, 500)
    },
    onDragEnd() {
      this.dragIndex = null
      this.dragOverIndex = null
    },
  },
}
</script>

<style scoped>
.queue-scroll {
  display: block;
  position: relative;
  overflow-y: auto;
  min-height: 0;
}

/* TransitionGroup's FLIP move animation — the actual "slides into its new
 * position" effect. Applies to every row whose index changed, not just the
 * dragged one, since reordering shifts everything in between too. */
.queue-move-move {
  transition: transform 0.3s ease;
}

.queue-move-enter-active,
.queue-move-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.queue-move-enter-from {
  opacity: 0;
  transform: translateX(12px);
}

.queue-move-leave-to {
  opacity: 0;
}

/* A leaving row must not hold its layout space during its own fade-out —
 * otherwise the rows below it can't slide up until it's fully gone,
 * defeating the point of the move transition above. */
.queue-move-leave-active {
  position: absolute;
  width: 100%;
}
</style>
