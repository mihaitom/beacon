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
    @mouseenter="drawersStore.cancelQueueDrawerAutoClose()"
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
        <!-- New rows animate in and removed ones animate out via Vue's own
         - native enter/leave transitions (.queue-move-enter-*/-leave-*
         - below) — no custom JS needed for either: a genuinely new v-for
         - key gets -enter-from/-active for free, a genuinely removed one
         - gets -leave-to/-active the same way. :style below only adds a
         - per-row transition-delay so several simultaneously-new rows
         - (Song Radio's whole mix, say) stagger in one after another
         - instead of all snapping in at once — see revealDelayStyle()'s
         - own comment. An earlier version instead hid/revealed rows via a
         - hand-timed setTimeout-per-row class toggle, built specifically
         - to make an enter-like fade replay even for rows Vue itself
         - wouldn't have treated as entering at all — that turned out to
         - fight .queue-move-move (below) for control of the same
         - properties on rows that were simultaneously repositioning
         - (reported live 2026-08-25 as a Play Next "zuckt nur rum"), and
         - needed its own increasingly fiddly floor/delay math to avoid a
         - same-tick hide-then-reveal that gave the browser nothing to
         - animate from. Letting Vue's own, already-correct enter/leave
         - lifecycle own the property changes sidesteps both problems
         - directly instead of re-solving them by hand. -->
        <!-- No `appear`, deliberately — see below for why, and for what
         - this costs. -->
        <!-- `appear` used to be bound to queueRevealSeq > 0, so a peek that's
         - *also* the drawer's first-ever open (DefaultLayout.vue doesn't
         - mount this component at all until the drawer first opens — see its
         - own v-if comment) still animated its rows in, instead of a plain
         - TransitionGroup silently skipping its own initial render (which
         - would have left exactly the "Song Radio from a closed drawer
         - doesn't animate at all" hole this was built to close).
         -
         - Turned off for good 2026-08-26: that first-ever `appear` render is
         - specifically what raced against Vue's own TransitionGroup move
         - logic (applyTranslation() in @vue/runtime-dom, still present
         - unpatched as of 3.5.41 stable and 3.6.0-rc.5 — no guard anywhere
         - in it against an element still mid-enter when the list re-renders
         - a second time) — confirmed live: .queue-move-move sitting on a row
         - at the same instant as .queue-move-enter-from/-active, which
         - snapped it back to its enter-from offset and restarted the whole
         - transition, non-deterministically landing the row up to 50px off
         - from the rest of the list until a several-hundred-ms self-
         - correction kicked in. The exact second-render trigger was never
         - pinned down (tried forcing an unrelated prop write at several
         - points in the transition lifecycle — nextTick, double-rAF,
         - @before-enter — none of it reproduced the class collision in
         - isolation, and Vue's own renderTriggered dev hook came up empty on
         - both this component and QueueRow.vue when the bug still fired
         - without the fix below, meaning the culprit render lives inside
         - TransitionGroup's own component instance, not anything reachable
         - from here). Given that, the fix is to stop giving it a second
         - render to race against for this one case, not to keep chasing
         - the exact trigger. Every later reveal (queueNext/addToQueue/a
         - fresh replace once the drawer's already mounted) still animates
         - normally through the plain, non-appear enter path below — this
         - only costs the very first reveal of a session its slide-in; rows
         - just appear already in place instead. -->
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
            :style="revealDelayStyle(song)"
            :class="{ 'queue-row--clearing': clearingRows.has(index) }"
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
import { useDrawersStore } from '@/stores/drawers'
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
// VNavigationDrawer.css, transition-duration: 0.2s) — folded into
// revealDelayStyle()'s own transition-delay so a reveal that's actually
// opening the drawer from closed only starts sliding in once the drawer
// itself has finished sliding into place, instead of visibly overlapping
// it. Clearing doesn't need this: the drawer's already open by the time
// you can click the clear button at all.
const REVEAL_BASE_DELAY_MS = 200
// Per-row stagger for several simultaneously-new/-clearing rows (Song
// Radio's whole mix, "Play Next" on more than one selected song, ...) —
// revealDelayStyle() bakes this into each row's own transition-delay,
// declaratively, so Vue's native enter transition (see the template's own
// comment) does the actual staggered animating; onClearQueue() still
// drives its own per-row setTimeout with it instead, for the reason its
// own comment on queue-row--clearing goes into. Capped at this many rows
// so a long queue's animation still wraps up quickly rather than fanning
// out for seconds; rows beyond the cap all share the same timing instead
// of growing further, which reads fine since anything past ~30 rows is
// scrolled out of view either way.
const ROW_STAGGER_MS = 30
const ROW_STAGGER_MAX_ROWS = 30
// .queue-move-enter-active's own CSS transition duration (below) —
// revealDelayStyle()'s own comment on why this needs to be known here too,
// not just declared in CSS.
const ROW_ENTER_TRANSITION_MS = 300
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
      // Set by startReveal() once per queueRevealSeq bump, to clear
      // playbackStore.queueRevealSongs back out once the whole staggered
      // reveal has actually finished — see startReveal()'s own comment for
      // why that cleanup has to happen at all.
      revealCleanupTimer: null as ReturnType<typeof setTimeout> | null,
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
    drawersStore() {
      return useDrawersStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    virtualizeQueue(): boolean {
      return this.playbackStore.queue.length > QUEUE_VIRTUALIZE_THRESHOLD
    },
    // Maps each song playbackStore.queueRevealSongs names to the
    // transition-delay (in ms) revealDelayStyle() should give its row, so
    // several simultaneously-new rows stagger in one after another instead
    // of all sliding in at once — position is this song's own rank *within
    // the reveal batch specifically*, not its index in the whole queue, so
    // a Play Next that inserts two songs in the middle of an otherwise
    // untouched queue still staggers those two relative to each other
    // starting from 0, rather than picking up wherever their queue index
    // happens to land. Recomputed from scratch on every queueRevealSeq
    // bump purely by virtue of being a computed over reactive state — no
    // separate "did this change" bookkeeping needed.
    revealDelayMap(): Map<Song, number> {
      const revealSet = new Set(this.drawersStore.queueRevealSongs)
      const baseDelay = this.drawersStore.queueRevealNeedsOpenDelay ? REVEAL_BASE_DELAY_MS : 0
      const map = new Map<Song, number>()
      let position = 0
      for (const song of this.playbackStore.queue) {
        if (!revealSet.has(song)) continue
        const capped = Math.min(position, ROW_STAGGER_MAX_ROWS)
        map.set(song, baseDelay + capped * ROW_STAGGER_MS)
        position++
      }
      return map
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
    'drawersStore.queueRevealSeq': {
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
    //
    // immediate: true — the same reason queueRevealSeq's own watcher above
    // needs it: DefaultLayout.vue never mounts this component until it
    // sees queueDrawerOpen go true (see that watcher's comment), so on the
    // very first ever open, `modelValue` is already `true` from this
    // component's first tick of existing at all — there's no false→true
    // *change* within its own lifetime for a plain (non-immediate) watcher
    // to see, so it silently never fired and the very first open never
    // scrolled anywhere. Every later close/reopen already had a real
    // instance around to watch the transition on, which is why this only
    // ever showed up as "the current track isn't centered when the drawer
    // opens" rather than every single time.
    modelValue: {
      handler(open: boolean) {
        if (!open) return
        this.$nextTick(() => this.scrollToCurrent())
      },
      immediate: true,
    },
  },
  beforeUnmount() {
    if (this.revealCleanupTimer) clearTimeout(this.revealCleanupTimer)
    if (this.clearingTimer) clearTimeout(this.clearingTimer)
    this.clearingRowTimers.forEach(clearTimeout)
  },
  methods: {
    queueRowKey,
    // revealDelayMap's own per-row lookup, as the :style the template
    // actually binds — undefined (not a 0ms delay) for any row that isn't
    // part of the current reveal at all, so untouched rows never pick up
    // an inline transition-delay that could then linger and affect some
    // completely unrelated later transition on that same element (a
    // drag-reorder's own .queue-move-move, say).
    revealDelayStyle(song: Song) {
      const delay = this.revealDelayMap.get(song)
      return delay === undefined ? undefined : { transitionDelay: `${delay}ms` }
    },
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
    // Whichever rows playbackStore.queueRevealSongs names get their own
    // enter transition entirely for free from Vue's native TransitionGroup
    // (see the template's own comment) — a genuinely new v-for key
    // automatically gets .queue-move-enter-from/-active applied and
    // removed on exactly the right frames, no manual hide/reveal timing
    // needed at all. revealDelayMap (a computed, driven by the same
    // queueRevealSongs) supplies each new row's own stagger via
    // revealDelayStyle()'s inline transition-delay, so this method itself
    // only has two jobs left: re-centering the scroll position for a
    // full-queue replacement, and cleaning queueRevealSongs back out once
    // the reveal it's driving has actually finished playing.
    //
    // queueRevealSongs is handed down by peekQueueDrawer() rather than
    // worked out here from "whichever rows aren't in queueRowKeys yet" —
    // see that action's own comment in playback.ts for why inferring it
    // from what this component has already rendered can't work. Note that
    // it names the rows to *stagger*, not the rows Vue treats as entering:
    // that part is purely queueRowKey() identity, and the two can drift
    // apart for any caller that reaches peekQueueDrawer() a tick later
    // than its own queue mutation — the rows would already be on screen by
    // then, entering un-staggered on the mutation instead. That's why
    // every caller peeks synchronously with the mutation (see
    // playSongList()'s `peek` argument), and why this method only has the
    // scroll and the cleanup left to do.
    startReveal() {
      const queue = this.playbackStore.queue
      const isFullQueueReveal = this.drawersStore.queueRevealSongs.length === queue.length
      // A full-queue replacement leaves .queue-scroll's own scrollTop
      // wherever it happened to be for the *previous* queue, which the new
      // one may not even be tall enough to still justify — scrollToCurrent()
      // (see the modelValue watcher's own comment) re-centers it on the
      // current track instead of leaving it to whatever the browser
      // otherwise does with a now-invalid scroll offset (typically an
      // instant, untransitioned clamp), reported live 2026-08-25 as a
      // jump/jitter right as the drawer opens on a regenerated queue that
      // had been scrolled down. Not needed for a partial reveal
      // (addToQueue()/queueNext()): those never remove anything, so the
      // scrollable height only ever grows and the existing scroll offset
      // stays perfectly valid.
      if (isFullQueueReveal) {
        this.$nextTick(() => this.scrollToCurrent())
      }
      // queueRevealSongs has to be cleared back out once its reveal is
      // done, or every one of these songs keeps carrying its own stale
      // transition-delay (via revealDelayStyle(), still bound in the
      // template) into whatever unrelated transition touches that same
      // row next — a drag-reorder's own .queue-move-move, most visibly,
      // would then start noticeably late for a row that was "new" several
      // actions ago. maxDelay covers the longest stagger any row in this
      // particular batch actually got; ROW_ENTER_TRANSITION_MS covers the
      // transition's own duration on top of that (see the CSS comment on
      // .queue-move-enter-active for why that number specifically); +50ms
      // is just headroom against timer jitter, same margin onClearQueue()
      // gives its own equivalent cleanup below.
      if (this.revealCleanupTimer) clearTimeout(this.revealCleanupTimer)
      const maxDelay = Math.max(0, ...this.revealDelayMap.values())
      this.revealCleanupTimer = setTimeout(
        () => {
          this.drawersStore.queueRevealSongs = []
        },
        maxDelay + ROW_ENTER_TRANSITION_MS + 50,
      )
    },
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

/* The entrance every genuinely-new row gets from Vue itself — reads as
 * sliding in from the right, the same direction/language a freshly
 * (re)generated queue (Song Radio, playSongList) already used, so a "Play
 * Next" inserting into the middle of an existing queue is now just that
 * same entrance scoped to the one or two rows it actually adds.
 * revealDelayStyle() only adds a per-row transition-delay on top; the
 * duration here is mirrored as ROW_ENTER_TRANSITION_MS in the script above,
 * which startReveal()'s cleanup timer needs in order to know when the last
 * row's entrance has actually finished. */
.queue-move-enter-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.queue-move-enter-from {
  opacity: 0;
  transform: translateX(50px);
}

.queue-move-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
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
</style>
