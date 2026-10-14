<template>
  <v-container fluid class="mobile-queue">
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('queue.title') }}</h1>
      <v-btn
        v-if="playbackStore.queue.length > 1"
        icon="mdi-notification-clear-all"
        variant="text"
        size="small"
        :title="$t('queue.clear')"
        @click="playbackStore.clearQueue()"
      />
    </div>

    <!-- Virtualized, riding the shell's scrolling pane: every mounted row
     - carries a cover with its own observer and an animated skeleton, and
     - a few hundred of those at once froze WebKit - scrolling and taps
     - stalled until the visible covers had loaded (iPad and iPhone, a
     - 300-song playlist). -->
    <div v-if="playbackStore.queue.length" ref="listEl" class="mobile-queue__list">
      <v-virtual-scroll renderless :items="playbackStore.queue" :item-height="MOBILE_ROW_HEIGHT">
        <template #default="{ item: song, index }">
          <mobile-queue-row
            :key="rowKey(song)"
            :song="song"
            :index="index"
            :is-current="index === playbackStore.currentIndex"
            :audible="index === playbackStore.currentIndex && !playbackStore.radioStation"
            :drag-over-position="dragIndex !== index ? dragOverPosition(index) : null"
            :dragging="dragIndex === index"
            :locked-next="index === playbackStore.lockedNextIndex"
            @play="onRowPlay(index)"
            @remove="playbackStore.removeFromQueue(index)"
            @drag-start="onDragStart(index, $event)"
            @menu="openActions(index)"
          />
        </template>
      </v-virtual-scroll>
    </div>

    <v-alert v-else type="info" variant="tonal">{{ $t('queue.empty') }}</v-alert>

    <!-- Closes by itself if the song leaves the queue while it is open. -->
    <mobile-song-action-sheet
      :model-value="actionsOpen && actionsIndex >= 0"
      :song="actionsSong"
      :queue-index="actionsIndex"
      @update:model-value="actionsOpen = $event"
    />
  </v-container>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import MobileQueueRow from '@/components/mobile/MobileQueueRow.vue'
import MobileSongActionSheet from '@/components/mobile/MobileSongActionSheet.vue'
import { MOBILE_ROW_HEIGHT } from '@/components/mobile/rowMetrics'
import { EdgeScroller, scrollParent } from '@/services/edgeScroll'
import { markRaw } from 'vue'
import type { Song } from '@/types/library'

// Only reached when a drag ends without the browser synthesising any click
// at all (released outside the list) — long enough to outlast a touch
// click, which trails its pointerup by a frame or two rather than
// following it in the same task.
const CLICK_SUPPRESSION_MS = 500

// A drag listens on its handle as well as on window (see onDragStart), and
// an event that still bubbles reaches both.
const handledPointerEvents = new WeakSet<Event>()
function firstSighting(event: Event): boolean {
  if (handledPointerEvents.has(event)) return false
  handledPointerEvents.add(event)
  return true
}

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
  components: { MobileQueueRow, MobileSongActionSheet },
  data() {
    return {
      MOBILE_ROW_HEIGHT,
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
      // Timer id of the armed click suppression below, so a second drag
      // doesn't leave the first one's timeout running.
      clickSuppressionTimer: null as ReturnType<typeof setTimeout> | null,
      // The list rides the shell's scrolling pane, so that is what a drag
      // near the top or bottom scrolls. Raw, so a frame of scrolling never
      // re-renders anything.
      edgeScroller: null as EdgeScroller | null,
      // Where the finger last was: a finger held still at the edge keeps
      // scrolling, and the row under it changes without a pointermove.
      dragY: 0,
      // The handle the drag started on - see onDragStart.
      dragHandle: null as EventTarget | null,
      actionsOpen: false,
      // The song object, not its index or id: the queue moves on under an
      // open sheet, and can hold the same song twice (see rowKey).
      actionsSong: null as Song | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    actionsIndex(): number {
      return this.actionsSong ? this.playbackStore.queue.indexOf(this.actionsSong) : -1
    },
  },
  beforeUnmount() {
    this.edgeScroller?.stop()
    this.detachPointerListeners()
    this.disarmClickSuppression()
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
      this.dragY = event.clientY
      this.edgeScroller ??= markRaw(
        new EdgeScroller({
          container: () => scrollParent(this.$refs.listEl as HTMLElement),
          onScroll: () => this.trackRowUnder(this.dragY),
        }),
      )
      this.edgeScroller.start()
      // The handle as well as window: scrolled far enough, the virtual list
      // drops the dragged row, and WebKit keeps sending a touch's pointer
      // events to the node it started on even once it is detached - where
      // they no longer bubble to window.
      this.dragHandle = event.currentTarget ? markRaw(event.currentTarget) : null
      for (const target of [window, this.dragHandle]) {
        target?.addEventListener('pointermove', this.onPointerMove as EventListener)
        target?.addEventListener('pointerup', this.onPointerUp)
        target?.addEventListener('pointercancel', this.onPointerUp)
      }
      event.preventDefault()
    },
    onPointerMove(event: PointerEvent) {
      if (this.dragIndex === null || !firstSighting(event)) return
      this.dragY = event.clientY
      this.edgeScroller?.update(event.clientY)
      this.trackRowUnder(event.clientY)
    },
    trackRowUnder(y: number) {
      const list = this.$refs.listEl as HTMLElement | undefined
      if (!list) return
      // Rows only: the virtual scroller's spacers sit between them too.
      for (const row of Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-index]'))) {
        const rect = row.getBoundingClientRect()
        if (y < rect.top || y > rect.bottom) continue
        const index = Number(row.dataset.index)
        if (!Number.isNaN(index)) {
          this.overIndex = index
          this.overHalf = y > rect.top + rect.height / 2 ? 'after' : 'before'
        }
        break
      }
    },
    onPointerUp(event?: Event) {
      if (event && !firstSighting(event)) return
      this.edgeScroller?.stop()
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
      this.armClickSuppression()
    },
    /** Swallows the click the browser synthesises out of the pointer
     * sequence that just finished the drag. It lands on whatever the press
     * started on — the dragged row's own handle — and a queue row's click
     * plays it, so reordering the queue changed the track; with a station
     * playing it also ended the station, since playAtIndex() leaves radio
     * (see the playback store).
     *
     * Caught in the capture phase rather than flagged for the row handler
     * to skip: a mouse synthesises that click in the same task as
     * pointerup, but touch does not, so a flag cleared on the next task was
     * already back down by the time the click arrived — which is exactly
     * the phone-only half of this bug. The listener is what expires now,
     * not the window of time it covers, so the timeout below is only a
     * fallback for the drag that ends without any click at all (released
     * outside the list). */
    armClickSuppression() {
      const list = this.$refs.listEl as HTMLElement | undefined
      if (!list) return
      this.disarmClickSuppression()
      list.addEventListener('click', this.swallowClick, true)
      this.clickSuppressionTimer = setTimeout(this.disarmClickSuppression, CLICK_SUPPRESSION_MS)
    },
    swallowClick(event: Event) {
      event.stopPropagation()
      this.disarmClickSuppression()
    },
    disarmClickSuppression() {
      const list = this.$refs.listEl as HTMLElement | undefined
      list?.removeEventListener('click', this.swallowClick, true)
      if (this.clickSuppressionTimer !== null) clearTimeout(this.clickSuppressionTimer)
      this.clickSuppressionTimer = null
    },
    openActions(index: number) {
      if (this.dragIndex !== null) return
      this.actionsSong = this.playbackStore.queue[index] ?? null
      this.actionsOpen = true
    },
    onRowPlay(index: number) {
      void this.playbackStore.playAtIndex(index)
    },
    detachPointerListeners() {
      for (const target of [window, this.dragHandle]) {
        target?.removeEventListener('pointermove', this.onPointerMove as EventListener)
        target?.removeEventListener('pointerup', this.onPointerUp)
        target?.removeEventListener('pointercancel', this.onPointerUp)
      }
      this.dragHandle = null
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
