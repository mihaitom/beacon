<template>
  <v-container fluid class="mobile-queue">
    <div class="d-flex align-center mb-3">
      <h1 class="page-title">{{ $t('queue.title') }}</h1>
      <v-spacer />
      <v-btn
        v-if="playbackStore.queue.length > 1"
        icon="mdi-notification-clear-all"
        variant="text"
        size="small"
        :title="$t('queue.clear')"
        @click="playbackStore.clearQueue()"
      />
    </div>

    <div v-if="playbackStore.queue.length" ref="listEl" class="mobile-queue__list">
      <mobile-queue-row
        v-for="(song, index) in playbackStore.queue"
        :key="rowKey(song)"
        :song="song"
        :index="index"
        :is-current="index === playbackStore.currentIndex"
        :drag-over-position="dragIndex !== index ? dragOverPosition(index) : null"
        :dragging="dragIndex === index"
        @play="playbackStore.playAtIndex(index)"
        @remove="playbackStore.removeFromQueue(index)"
        @drag-start="onDragStart(index, $event)"
      />
    </div>

    <v-alert v-else type="info" variant="tonal">{{ $t('queue.empty') }}</v-alert>
  </v-container>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import MobileQueueRow from '@/components/mobile/MobileQueueRow.vue'
import type { Song } from '@/types/library'

// Per-row identity keyed off the Song *object*, not its id — the queue can
// legitimately hold the same song more than once (see playbackStore's own
// dedupeForQueue()); an id-keyed map would collide both occurrences onto the
// same :key. Same approach as QueueDrawer.vue's queueRowKey().
let rowKeySeq = 0
const rowKeys = new WeakMap<Song, string>()
function rowKey(song: Song): string {
  let key = rowKeys.get(song)
  if (key === undefined) {
    key = `mqrow-${rowKeySeq++}`
    rowKeys.set(song, key)
  }
  return key
}

export default {
  name: 'MobileQueueView',
  components: { MobileQueueRow },
  data() {
    return {
      // Pointer-based reorder (not HTML5 drag-and-drop, which doesn't fire
      // reliably from touch) — mirrors the interaction pattern already
      // validated in the LAN remote's connect/static/remote/js/views/
      // queue.js, rebuilt against Vue state/reactivity instead of direct DOM
      // manipulation. dragIndex is the row being moved; overIndex is
      // whichever row the pointer is currently over — the actual
      // reorderQueue() call only fires once, on release.
      dragIndex: null as number | null,
      overIndex: null as number | null,
      // Which half of overIndex's own row the pointer is over — see
      // insertBeforeIndex()'s own comment for why this matters: without it,
      // hovering anywhere within a row's bounding box always meant "insert
      // before this row's original index", correct only for dragging
      // *up*. Dragging down past even a single adjacent row landed one
      // further than intended (a "swap with the very next track" drag
      // reliably overshot to the track after that).
      overHalf: null as 'before' | 'after' | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
  },
  beforeUnmount() {
    this.detachPointerListeners()
  },
  methods: {
    rowKey,
    dragOverPosition(index: number): 'before' | 'after' | null {
      return this.overIndex === index ? this.overHalf : null
    },
    onDragStart(index: number, event: PointerEvent) {
      this.dragIndex = index
      this.overIndex = index
      this.overHalf = 'before'
      window.addEventListener('pointermove', this.onPointerMove)
      window.addEventListener('pointerup', this.onPointerUp)
      window.addEventListener('pointercancel', this.onPointerUp)
      event.preventDefault()
    },
    onPointerMove(event: PointerEvent) {
      if (this.dragIndex === null) return
      const list = this.$refs.listEl as HTMLElement | undefined
      if (!list) return
      for (const row of Array.from(list.children)) {
        const rect = row.getBoundingClientRect()
        if (event.clientY < rect.top || event.clientY > rect.bottom) continue
        const index = Number((row as HTMLElement).dataset.index)
        if (!Number.isNaN(index)) {
          this.overIndex = index
          this.overHalf = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
        }
        break
      }
    },
    onPointerUp() {
      this.detachPointerListeners()
      if (this.dragIndex !== null && this.overIndex !== null && this.overHalf !== null) {
        // See QueueDrawer.vue's insertBeforeIndex()/dropIndex() for the
        // identical original-index -> post-removal-index conversion.
        const insertBefore = this.overHalf === 'after' ? this.overIndex + 1 : this.overIndex
        const to = insertBefore > this.dragIndex ? insertBefore - 1 : insertBefore
        if (to !== this.dragIndex) this.playbackStore.reorderQueue(this.dragIndex, to)
      }
      this.dragIndex = null
      this.overIndex = null
      this.overHalf = null
    },
    detachPointerListeners() {
      window.removeEventListener('pointermove', this.onPointerMove)
      window.removeEventListener('pointerup', this.onPointerUp)
      window.removeEventListener('pointercancel', this.onPointerUp)
    },
  },
}
</script>

<style scoped>
.mobile-queue__list {
  display: flex;
  flex-direction: column;
}
</style>
