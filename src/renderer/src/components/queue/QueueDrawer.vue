<template>
  <!-- `temporary` so this floats over the main content instead of pushing/
   - resizing it (Vuetify's default non-temporary drawer reserves layout
   - space, which reflowed every view underneath every time this opened/
   - closed) — `persistent` keeps it open across navigation and on an
   - outside click regardless, and `scrim="false"` drops the darkening
   - backdrop `temporary` would otherwise add, since the point is to keep
   - browsing the rest of the app comfortably while this stays open. -->
  <v-navigation-drawer
    :model-value="modelValue"
    location="right"
    width="380"
    temporary
    persistent
    :scrim="false"
    color="#0B0D13"
    class="beacon-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column fill-height">
      <v-toolbar
        density="compact"
        color="#0B0D13"
        class="beacon-drawer__toolbar"
        :title="$t('queue.title')"
      >
        <template #append>
          <v-btn
            v-if="playbackStore.queue.length > 1"
            icon="mdi-notification-clear-all"
            variant="text"
            size="small"
            :title="$t('queue.clear')"
            @click="playbackStore.clearQueue()"
          />
        </template>
      </v-toolbar>

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
            v-for="(song, index) in playbackStore.queue"
            :key="queueRowKey(song)"
            :song="song"
            :index="index"
            :drag-over-position="dragIndex !== index ? dragOverPosition(index) : null"
            :dragging="dragIndex === index"
            :landed="queueRowKey(song) === landedKey"
            @dragstart="onDragStart(index, $event)"
            @dragover="onDragOver(index, $event)"
            @dragleave="onDragLeave(index)"
            @drop="onDrop(index, $event)"
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
          <template #default="{ item: song, index }">
            <queue-row
              :key="queueRowKey(song)"
              :song="song"
              :index="index"
              :drag-over-position="dragIndex !== index ? dragOverPosition(index) : null"
              :dragging="dragIndex === index"
              :landed="queueRowKey(song) === landedKey"
              @dragstart="onDragStart(index, $event)"
              @dragover="onDragOver(index, $event)"
              @dragleave="onDragLeave(index)"
              @drop="onDrop(index, $event)"
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
import type { Song } from '@/types/library'

// Per-row identity for :key and the "landed" flash, keyed off the Song
// *object* rather than its id — the queue can legitimately hold the same
// song more than once (see playbackStore's dedupeForQueue()), and an
// id-keyed Set/Map would make both occurrences resolve to the same key,
// producing a Vue duplicate-key warning and mixing up which row the FLIP
// move animation / landed pulse actually targets. A WeakMap survives
// reorderQueue() unaffected since that moves the same object reference to a
// new array index rather than replacing it.
let queueRowKeySeq = 0
const queueRowKeys = new WeakMap<Song, string>()
function queueRowKey(song: Song): string {
  let key = queueRowKeys.get(song)
  if (key === undefined) {
    key = `qrow-${queueRowKeySeq++}`
    queueRowKeys.set(song, key)
  }
  return key
}

// Past this many songs, switch from an animated plain v-for to
// v-virtual-scroll instead — comfortably above any realistic queue built
// from actual queueing actions (Song Radio caps at 100, "Play next"/"Add
// to queue" add one song at a time), but well under what actually risks
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
      // Which half of dragOverIndex's own row the pointer is currently
      // over — see insertBeforeIndex()'s own comment for why this matters:
      // without it, dropping anywhere within a row's bounding box always
      // meant "insert before this row's original index", which only
      // produces the expected result for a drag moving *up*. Moving down
      // past even a single adjacent row landed one further than intended
      // (a "swap with the very next track" drag reliably overshot to the
      // track after that).
      dragOverHalf: null as 'before' | 'after' | null,
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
    dragOverPosition(index: number): 'before' | 'after' | null {
      return this.dragOverIndex === index ? this.dragOverHalf : null
    },
    onDragStart(index: number, event: DragEvent) {
      this.dragIndex = index
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        // Firefox requires setData for the drag to actually start.
        event.dataTransfer.setData('text/plain', String(index))
      }
    },
    // The *original* array index to insert the dragged item before, given
    // which half of `index`'s own row the pointer is over — top half means
    // "right here, before this row" (index itself), bottom half means
    // "right after this row" (index + 1). reorderQueue()'s own `to` is a
    // post-removal splice index, not this original-array one — dropIndex()
    // below converts between the two, since removing the dragged item
    // first shifts every *later* original index left by one (see its own
    // comment).
    insertBeforeIndex(index: number, event: DragEvent): number {
      const row = event.currentTarget as HTMLElement
      const rect = row.getBoundingClientRect()
      const isBottomHalf = event.clientY > rect.top + rect.height / 2
      return isBottomHalf ? index + 1 : index
    },
    // Converts insertBeforeIndex()'s original-array target into the
    // post-removal index reorderQueue(from, to) actually expects.
    dropIndex(index: number, event: DragEvent): number {
      const insertBefore = this.insertBeforeIndex(index, event)
      return insertBefore > (this.dragIndex ?? 0) ? insertBefore - 1 : insertBefore
    },
    onDragOver(index: number, event: DragEvent) {
      this.dragOverIndex = index
      this.dragOverHalf = this.insertBeforeIndex(index, event) > index ? 'after' : 'before'
    },
    onDragLeave(index: number) {
      if (this.dragOverIndex === index) {
        this.dragOverIndex = null
        this.dragOverHalf = null
      }
    },
    onDrop(index: number, event: DragEvent) {
      if (this.dragIndex !== null) {
        const to = this.dropIndex(index, event)
        if (to !== this.dragIndex) {
          const moved = this.playbackStore.queue[this.dragIndex]
          this.playbackStore.reorderQueue(this.dragIndex, to)
          if (moved) this.flashLanded(this.queueRowKey(moved))
        }
      }
      this.dragIndex = null
      this.dragOverIndex = null
      this.dragOverHalf = null
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
      this.dragOverHalf = null
    },
  },
}
</script>

<style scoped>
/* Matches the app's own dark chrome (PlayerBar.vue/DefaultLayout.vue's
 * app-bar/rail) rather than Vuetify's default surface color — now that this
 * floats over content as its own panel (see `temporary` above), it reads
 * more like a bolted-on default dialog without this. */
.beacon-drawer {
  border-left: 1px solid var(--beacon-hairline);
}

.beacon-drawer__toolbar {
  border-bottom: 1px solid var(--beacon-hairline);
}

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
