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
    @mouseenter="playbackStore.cancelQueueDrawerAutoClose()"
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
            v-if="playbackStore.queue.length"
            icon="mdi-playlist-plus"
            variant="text"
            size="small"
            :title="$t('queue.saveAsPlaylist')"
            @click="openCreatePlaylistDialog"
          />
          <v-btn
            v-if="playbackStore.queue.length > 1"
            icon="mdi-notification-clear-all"
            variant="text"
            size="small"
            :disabled="clearing"
            :title="$t('queue.clear')"
            @click="onClearQueue"
          />
        </template>
      </v-toolbar>

      <!-- Pre-seeds the new playlist with the queue exactly as currently
       - shown here (same order, already-played songs included) — same
       - "create new playlist" dialog shape as SongTable.vue's own, just
       - seeded from the whole queue instead of a song selection. -->
      <v-dialog v-model="createPlaylistDialog" max-width="400">
        <v-card>
          <v-card-title>{{ $t('playlists.createTitle') }}</v-card-title>
          <v-card-text>
            <v-text-field
              v-model="createPlaylistName"
              :label="$t('common.name')"
              variant="solo-filled"
              autofocus
              clearable
              @keyup.enter="confirmCreatePlaylist"
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="createPlaylistDialog = false">{{
              $t('common.cancel')
            }}</v-btn>
            <v-btn color="primary" @click="confirmCreatePlaylist">{{ $t('common.create') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

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
        <!-- No :key/appear-driven remount here — an earlier version forced
         - one (bumping a :key on this whole TransitionGroup) specifically
         - to make Vue's own enter transition replay for a reveal even on
         - rows it had already mounted before. That meant genuinely
         - destroying and recreating every row's component instance on
         - every single peek, which for a real queue-sized list is real
         - Vue/DOM work — work that ate into the very time budget the
         - animation itself needed, so on a big queue the fade sometimes
         - never visibly played at all, just jumped straight to its end
         - state. revealingRows (below) replaces that with a manually-timed
         - class toggle instead, the same approach onClearQueue() already
         - uses for its own fade-out — completely decoupled from mount/
         - unmount, so the DOM stays put and the animation actually has its
         - own time instead of competing with component creation for it. -->
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
            :data-queue-index="index"
            :class="{
              'queue-row--reveal-pending': revealingRows.has(index),
              'queue-row--clearing': clearingRows.has(index),
            }"
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
          ref="virtualScroll"
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
import { useLibraryStore } from '@/stores/library'
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

// v-navigation-drawer's own open transition (Vuetify's
// VNavigationDrawer.css, transition-duration: 0.2s) — the reveal's base
// delay, so rows only start fading in once the drawer itself has actually
// finished sliding into place instead of visibly overlapping it. Clearing
// doesn't need this: the drawer's already open by the time you can click
// the clear button at all.
const REVEAL_BASE_DELAY_MS = 200
// Per-row stagger, shared by the reveal and the clear — both driven by
// their own individually-timed setTimeout per row (startReveal(),
// onClearQueue()) rather than a single synchronous class toggle across
// every row with only a differing CSS transition-delay meant to stagger
// them, which turned out not to actually stagger visually, just apply the
// end state to everything together. Capped at this many rows so a long
// queue's animation still wraps up quickly rather than fanning out for
// seconds; rows beyond the cap all share the same timing instead of
// growing further, which reads fine since anything past ~30 rows is
// scrolled out of view either way.
const ROW_STAGGER_MS = 30
const ROW_STAGGER_MAX_ROWS = 30
// queue-row--clearing's own CSS transition duration (below) — onClearQueue()
// uses this to work out how long its whole staggered fade-out takes.
const CLEARING_FADE_MS = 250

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
      // Indices startReveal() has hidden pending their own staggered
      // reveal — the template's queue-row--reveal-pending class binding
      // reads this directly, same pattern as clearingRows below. Starts
      // holding *every* row's index (see startReveal()'s own comment),
      // each one individually removed on its own timer.
      revealingRows: new Set() as Set<number>,
      revealRowTimers: [] as ReturnType<typeof setTimeout>[],
      // True for the duration of a clear-queue animation — see
      // onClearQueue(). Only gates the clear button's own :disabled below;
      // the actual fade-out is driven per-row by clearingRows.
      clearing: false,
      // Indices onClearQueue() has (individually, via its own setTimeout
      // per row) told to start fading — the template's
      // queue-row--clearing class binding reads this directly rather than
      // a single shared boolean, since each row's fade genuinely starts at
      // its own moment. The currently-playing row's index never gets
      // added: clearQueue() keeps it, so animating it away too would be
      // lying about what's about to happen.
      clearingRows: new Set() as Set<number>,
      clearingTimer: null as ReturnType<typeof setTimeout> | null,
      clearingRowTimers: [] as ReturnType<typeof setTimeout>[],
      createPlaylistDialog: false,
      createPlaylistName: '',
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    virtualizeQueue(): boolean {
      return this.playbackStore.queue.length > QUEUE_VIRTUALIZE_THRESHOLD
    },
  },
  watch: {
    // Bumped only by playbackStore.peekQueueDrawer() — see its own
    // comment. A `temporary` drawer keeps its content mounted while
    // closed/already open, so a plain manual toggle wouldn't otherwise
    // give any signal that "now's the moment to reveal", and shouldn't:
    // re-showing an unchanged queue needs no fanfare. `immediate: true` —
    // covers this component's own very first mount, when that mount was
    // *caused* by a peek (DefaultLayout.vue only ever mounts this once it
    // sees queueDrawerOpen go true): queueRevealSeq has already bumped by
    // then, before this watcher even exists to see it change, so without
    // `immediate` that first reveal would silently do nothing. `seq === 0`
    // skips the resulting call on a plain first *manual* open, where
    // queueRevealSeq is still sitting at its untouched initial value.
    'playbackStore.queueRevealSeq': {
      handler(seq: number) {
        if (seq === 0) return
        this.startReveal()
      },
      immediate: true,
    },
    // Unlike the reveal above, this fires for *every* open — manual toggle
    // included, not just a peekQueueDrawer() one — since knowing where you
    // currently are in a long queue is useful regardless of why the
    // drawer's open. $nextTick: the row/virtual-scroll content for a
    // freshly (re)opened drawer isn't actually laid out yet on this same
    // tick, so scrolling immediately would measure against stale/empty
    // layout.
    modelValue(open: boolean) {
      if (!open) return
      this.$nextTick(() => this.scrollToCurrent())
    },
  },
  beforeUnmount() {
    this.revealRowTimers.forEach(clearTimeout)
    if (this.clearingTimer) clearTimeout(this.clearingTimer)
    this.clearingRowTimers.forEach(clearTimeout)
  },
  methods: {
    queueRowKey,
    // See the modelValue watcher's own comment for when this runs.
    scrollToCurrent() {
      const index = this.playbackStore.currentIndex
      if (index < 0) return
      if (this.virtualizeQueue) {
        const virtualScroll = this.$refs.virtualScroll as
          { scrollToIndex: (i: number) => void } | undefined
        virtualScroll?.scrollToIndex(index)
        return
      }
      document.querySelector(`[data-queue-index="${index}"]`)?.scrollIntoView({ block: 'center' })
    },
    // The first row that's entirely scrolled *out* of view right now
    // (fully below the container's own bottom edge), found via
    // getBoundingClientRect rather than assumed to be currentIndex: the
    // drawer only scrolls there when it *opens* (see scrollToCurrent()),
    // nothing pins the view back to it afterward, so the user may well
    // have scrolled off to browse a completely different part of the
    // queue by the time they click clear. onClearQueue()'s bottom-to-top
    // sweep anchors here (everything from this row down fades instantly,
    // everything above it staggers) rather than on the last row that's
    // still visible — a row only half-cropped by the container's own
    // bottom edge would otherwise land in that instant, no-stagger group
    // right alongside the genuinely off-screen rows below it, which
    // visibly jerks (a row you can still partly see just vanishing, no
    // stagger buildup at all) in a way a row that was never visible to
    // begin with doesn't. Anchoring one row later means that half-cropped
    // row gets folded into the stagger instead, as its very first step.
    // Falls back to the row count itself if nothing's below the fold at
    // all (the last row in the queue is still at least partly visible) —
    // every row then staggers, none skip straight to instant.
    findVisibleAnchorIndex(): number {
      const container = document.querySelector('.queue-scroll')
      if (!container) return 0
      const containerRect = container.getBoundingClientRect()
      const rows = container.querySelectorAll<HTMLElement>('[data-queue-index]')
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        if (rect.top >= containerRect.bottom) {
          return Number(row.dataset.queueIndex)
        }
      }
      return rows.length
    },
    // Hides every row, then reveals each one on its own staggered
    // setTimeout, first-to-last — see the TransitionGroup's own template
    // comment for why this is a manually-timed class toggle rather than
    // Vue's native enter transition (which is what an earlier version of
    // this relied on, forcing a full remount to get it to replay). Runs
    // for *every* queueRevealSeq bump, even a single-song addToQueue() on
    // an otherwise-unchanged queue — re-revealing rows that were already
    // visible is a deliberate tradeoff for "look what's in the queue now"
    // staying simple and consistent, not something worth special-casing.
    startReveal() {
      this.revealRowTimers.forEach(clearTimeout)
      this.revealRowTimers = []
      const queue = this.playbackStore.queue
      this.revealingRows = new Set(queue.map((_song, index) => index))
      queue.forEach((_song, index) => {
        const capped = Math.min(index, ROW_STAGGER_MAX_ROWS)
        const delay = REVEAL_BASE_DELAY_MS + capped * ROW_STAGGER_MS
        this.revealRowTimers.push(
          setTimeout(() => {
            this.revealingRows.delete(index)
          }, delay),
        )
      })
    },
    // Fades every row but the currently-playing one out, bottom-to-top,
    // before actually clearing the queue — NOT last-array-index-first like
    // an earlier version of this did. That staggered by absolute array
    // position regardless of scroll position, so on a long queue (say 100
    // songs from a quick-play action) most of the "first" fades happened
    // off-screen below whatever was actually scrolled into view, reading
    // as "a delay before anything happens" followed by a clump.
    // findVisibleAnchorIndex() finds the bottom-most row actually still in
    // view instead (not literally the queue's own last row, and not
    // currentIndex either — scrollToCurrent() only scrolls there when the
    // drawer *opens*, nothing pins the view back to it afterward, so the
    // user may well have scrolled off to browse a completely different
    // part of the queue by the time they click clear). Rows at or below
    // that anchor fade together with no delay at all — they're already at
    // or past the bottom of what's visible, there's nothing to stagger for
    // an audience that can't see them — and the sweep only actually paces
    // itself moving upward past the anchor, through the rows that are
    // actually on screen.
    // Each row's fade is kicked off by its own setTimeout (added to
    // clearingRows, which the template's queue-row--clearing class binding
    // reads directly) rather than a single class toggle across every row
    // with only a differing transition-delay meant to stagger them — that
    // turned out to just fade everything together in one synchronous
    // patch instead of actually staggering, since every row's :class/
    // :style changed in the very same Vue update regardless of each one's
    // own delay value. Individually-timed callbacks sidestep that
    // entirely. Deliberately doesn't touch the store until the whole
    // thing's done: the outer v-if="playbackStore.queue.length" above
    // would otherwise tear down this whole TransitionGroup (and every
    // row's fade-out with it) the instant the queue actually emptied.
    openCreatePlaylistDialog() {
      this.createPlaylistName = ''
      this.createPlaylistDialog = true
    },
    async confirmCreatePlaylist() {
      if (!this.createPlaylistName.trim()) return
      try {
        await this.libraryStore.createPlaylist(
          this.createPlaylistName,
          this.playbackStore.queue.map((song) => song.id),
        )
        this.createPlaylistDialog = false
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.createTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[queue-drawer] Failed to create playlist:', error)
      }
    },
    onClearQueue() {
      if (this.clearing || this.playbackStore.queue.length <= 1) return
      if (this.virtualizeQueue) {
        // No per-row transition to play in the virtualized path — see
        // QUEUE_VIRTUALIZE_THRESHOLD's own template comment.
        this.playbackStore.clearQueue()
        return
      }
      const queue = this.playbackStore.queue
      const currentIndex = this.playbackStore.currentIndex
      const anchorIndex = this.findVisibleAnchorIndex()
      this.clearing = true
      this.clearingRows = new Set()
      this.clearingRowTimers.forEach(clearTimeout)
      this.clearingRowTimers = []

      queue.forEach((_song, index) => {
        if (index === currentIndex) return
        const distanceAboveAnchor = index >= anchorIndex ? 0 : anchorIndex - index
        const delay = Math.min(distanceAboveAnchor, ROW_STAGGER_MAX_ROWS) * ROW_STAGGER_MS
        this.clearingRowTimers.push(
          setTimeout(() => {
            this.clearingRows.add(index)
          }, delay),
        )
      })

      if (this.clearingTimer) clearTimeout(this.clearingTimer)
      const totalMs = ROW_STAGGER_MAX_ROWS * ROW_STAGGER_MS + CLEARING_FADE_MS + 100
      this.clearingTimer = setTimeout(() => {
        this.playbackStore.clearQueue()
        this.clearing = false
        this.clearingRows = new Set()
      }, totalMs)
    },
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

/* onClearQueue()'s own fade-out — a manually-toggled class (added to one
 * row at a time by its own setTimeout, see that method's own comment on
 * why not transition-delay), not TransitionGroup's usual leave mechanism
 * (removing rows from the queue immediately would tear down the whole
 * list before they get a chance to animate). opacity only, deliberately
 * not also a transform like queue-move-leave-to/-active above does —
 * .queue-move-move (right above) already owns `transform` for every row
 * in this list on every TransitionGroup update, staggered setTimeout or
 * not; animating it here too meant competing with that rule for the same
 * property, which read as the fade-out's own start lagging behind when it
 * actually kicked in. */
.queue-row--clearing {
  transition: opacity 0.25s ease;
  opacity: 0;
}

/* startReveal()'s own fade-in — same manually-toggled-class approach as
 * queue-row--clearing above, in reverse (rows start hidden, then this gets
 * removed on each one's own staggered timer instead of added). No
 * transition declared here on purpose: QueueRow.vue's own base .queue-row
 * rule already has `transition: opacity 0.15s ease` unconditionally (it's
 * what animates queue-row--dragging's opacity too), so this only needs to
 * set the value being transitioned *to*. */
.queue-row--reveal-pending {
  opacity: 0;
}
</style>
