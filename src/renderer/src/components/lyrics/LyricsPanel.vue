<template>
  <div class="lyrics-panel" :class="`lyrics-panel--${variant}`">
    <div v-if="lyricsStore.loading" class="lyrics-panel__skeleton">
      <!-- Bones only in the compact drawer, where they sit on the app's
       - normal solid surface — over the immersive view's blurred-photo
       - backdrop they never looked right no matter how they were styled,
       - so fullscreen just shows nothing until the real lyrics land. -->
      <template v-if="variant === 'compact'">
        <v-skeleton-loader
          v-for="(width, index) in skeletonWidths"
          :key="index"
          type="text"
          :width="width"
          height="24"
          class="mb-4"
        />
      </template>
    </div>

    <div
      v-else-if="lyricsStore.error || lyricsStore.lines.length === 0"
      class="lyrics-panel__empty"
    >
      <span class="text-medium-emphasis">{{ $t('lyrics.notFound') }}</span>
    </div>

    <div v-else-if="!lyricsStore.synced" class="lyrics-panel__scroll lyrics-panel__scroll--plain">
      <p class="lyrics-panel__line lyrics-panel__line--plain">{{ plainText }}</p>
    </div>

    <div
      v-else
      ref="scrollEl"
      class="lyrics-panel__scroll"
      :class="{ 'lyrics-panel__scroll--calibrating': calibrating }"
      @wheel="onManualScroll"
      @touchmove="onManualScroll"
    >
      <!-- Padding elements so the first/last real line can still scroll to
       - dead-center — without these, scrollIntoView({block: 'center'}) can't
       - move a line near either end of the list past the container's own
       - edge. -->
      <div class="lyrics-panel__pad" />
      <div
        v-for="(line, index) in lyricsStore.lines"
        :key="index"
        ref="lineRefs"
        class="lyrics-panel__line lyrics-panel__line--clickable"
        :class="{
          'lyrics-panel__line--active': index === activeIndex,
          'lyrics-panel__line--past': index < activeIndex,
        }"
        :title="calibrating ? $t('lyrics.calibrateHere') : $t('lyrics.seekHere')"
        @click="onLineClick(line)"
      >
        {{ line.text || '♪' }}
      </div>
      <div class="lyrics-panel__pad" />
    </div>

    <!-- Shown whenever there's a result to act on — including "not found",
     - where picking a different match is the most useful thing to offer. -->
    <div v-if="!lyricsStore.loading" class="lyrics-panel__toolbar">
      <div v-if="calibrating" class="lyrics-panel__calibrate-hint">
        {{ $t('lyrics.calibrateHint') }}
      </div>

      <!-- The matched lyrics are often a slightly different edit/version
       - than this exact audio file — this is the escape hatch for "close
       - but consistently early/late", not something most songs need. -->
      <div v-if="lyricsStore.synced" class="lyrics-panel__sync">
        <v-btn
          icon="mdi-target"
          size="x-small"
          variant="text"
          density="compact"
          :color="calibrating ? 'primary' : undefined"
          :title="$t('lyrics.calibrate')"
          @click="calibrating = !calibrating"
        />
        <v-divider vertical class="mx-1" />
        <v-btn
          icon="mdi-rewind"
          size="x-small"
          variant="text"
          density="compact"
          :title="$t('lyrics.syncEarlier')"
          @click="lyricsStore.adjustOffset(-0.1)"
        />
        <span
          class="lyrics-panel__sync-label"
          :class="{ 'lyrics-panel__sync-label--resettable': lyricsStore.offset !== 0 }"
          :title="lyricsStore.offset !== 0 ? $t('lyrics.syncReset') : undefined"
          @click="lyricsStore.offset !== 0 && lyricsStore.adjustOffset(-lyricsStore.offset)"
        >
          {{ offsetLabel }}
        </span>
        <v-btn
          icon="mdi-fast-forward"
          size="x-small"
          variant="text"
          density="compact"
          :title="$t('lyrics.syncLater')"
          @click="lyricsStore.adjustOffset(0.1)"
        />
      </div>

      <div class="lyrics-panel__meta">
        <span v-if="sourceLabel" class="lyrics-panel__source">{{
          $t('lyrics.source', { source: sourceLabel })
        }}</span>
        <!-- The auto-matched lyrics can be for the wrong edit of a song
         - entirely (not just mistimed) — this is the escape hatch for that,
         - also the main way to find lyrics at all when nothing auto-matched. -->
        <v-menu
          :close-on-content-click="false"
          location="top right"
          :offset="[12, 0]"
          @update:model-value="onPickerToggle"
        >
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              size="x-small"
              variant="text"
              density="compact"
              prepend-icon="mdi-format-list-bulleted"
              class="lyrics-panel__pick-btn"
            >
              {{ $t('lyrics.pickMatch') }}
            </v-btn>
          </template>
          <v-list density="compact" class="lyrics-panel__candidates">
            <v-list-item v-if="lyricsStore.candidatesLoading" disabled>
              <v-progress-circular indeterminate size="18" width="2" />
            </v-list-item>
            <v-list-item v-else-if="!hasCandidates" disabled>
              <v-list-item-title class="text-medium-emphasis text-body-2">
                {{ $t('lyrics.noCandidates') }}
              </v-list-item-title>
            </v-list-item>
            <template v-else>
              <template v-for="group in candidateGroups" :key="group.source">
                <v-list-subheader>{{ group.source }}</v-list-subheader>
                <v-list-item
                  v-for="candidate in group.results"
                  :key="candidate.id"
                  :active="isCurrentCandidate(group.source, candidate)"
                  active-color="primary"
                  class="lyrics-panel__candidate"
                  :class="{
                    'lyrics-panel__candidate--current': isCurrentCandidate(group.source, candidate),
                  }"
                  @click="onSelectCandidate(group.source, candidate)"
                >
                  <template #prepend>
                    <v-icon
                      :icon="syncIcon(candidate)"
                      size="x-small"
                      :title="syncLabel(candidate)"
                    />
                  </template>
                  <v-list-item-title>{{ candidate.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ candidate.artist }}</v-list-item-subtitle>
                  <template #append>
                    <div class="lyrics-panel__candidate-meta">
                      <v-icon
                        v-if="isCurrentCandidate(group.source, candidate)"
                        icon="mdi-check-circle"
                        size="x-small"
                        color="primary"
                        :title="$t('lyrics.currentMatch')"
                      />
                      <!-- A duration far off the actual song's own length
                       - is a strong "wrong edit" signal (radio cut vs.
                       - album version, live take, ...) — flagged in red so
                       - it's visible without doing the subtraction by eye. -->
                      <span
                        v-if="candidate.duration != null"
                        class="lyrics-panel__candidate-duration"
                        :class="{
                          'lyrics-panel__candidate-duration--mismatch':
                            isDurationMismatch(candidate),
                        }"
                      >
                        {{ formatDuration(candidate.duration) }}
                      </span>
                      <span class="lyrics-panel__candidate-score"
                        >{{ matchPercent(candidate) }}%</span
                      >
                    </div>
                  </template>
                </v-list-item>
              </template>
            </template>
          </v-list>
        </v-menu>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { FILE_SOURCE, useLyricsStore } from '@/stores/lyrics'
import type { LyricLine } from '@/services/lyrics/parseLrc'
import type { LyricSearchResult } from '@/services/connect/types'

// How long to leave autoscroll paused after the user manually scrolls/
// touches the list, before snapping back to whatever line is actually
// active by then (not waiting for the *next* line change, which could be
// many seconds away for a long gap between lines).
const MANUAL_SCROLL_PAUSE_MS = 4000

const SKELETON_WIDTHS = ['70%', '45%', '85%', '55%', '65%', '40%']

// A candidate whose duration is off by more than this is almost certainly
// a different edit of the song (radio cut, live take, ...) rather than a
// timing quirk — flagged in the picker, see isDurationMismatch() below.
const DURATION_MISMATCH_THRESHOLD_S = 5

export default {
  name: 'LyricsPanel',
  props: {
    variant: {
      type: String as PropType<'compact' | 'immersive'>,
      default: 'compact',
    },
  },
  data() {
    return {
      autoscrollPaused: false,
      resumeTimer: null as ReturnType<typeof setTimeout> | null,
      // First placement after a song's lyrics (re)load jumps instantly
      // instead of animating up from wherever the scroll happened to be.
      skipNextScrollAnimation: true,
      // Armed by the target button — while true, the *next* line click
      // calibrates the offset instead of seeking (see onLineClick below).
      calibrating: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    lyricsStore() {
      return useLyricsStore()
    },
    skeletonWidths() {
      return SKELETON_WIDTHS
    },
    plainText() {
      return this.lyricsStore.lines.map((line) => line.text).join('\n')
    },
    // Index of the last line whose (offset-adjusted) timestamp has passed —
    // lines are always time-sorted ascending (see services/lyrics/
    // parseLrc.ts), so this is "how far into the list has playback gotten."
    activeIndex() {
      if (!this.lyricsStore.synced) return -1
      const position = this.playbackStore.localPosition - this.lyricsStore.offset
      const lines = this.lyricsStore.lines
      let index = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.time > position) break
        index = i
      }
      return index
    },
    // Spelled out as "later"/"earlier" rather than a +/- sign — the sign
    // requires remembering which direction it maps to (does + mean the
    // lyrics or the audio moves?); the word doesn't.
    offsetLabel() {
      const offset = this.lyricsStore.offset
      if (offset === 0) return this.$t('lyrics.sync')
      const seconds = Math.abs(offset).toFixed(1)
      return offset > 0
        ? this.$t('lyrics.laterBy', { seconds })
        : this.$t('lyrics.earlierBy', { seconds })
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    sourceLabel() {
      const source = this.lyricsStore.source
      if (!source) return null
      return source === FILE_SOURCE ? this.$t('lyrics.sourceFile') : source
    },
    // Grouped as an array (not the raw Record from the store) so the
    // template can v-for it directly and empty-result sources don't need
    // filtering out inline.
    candidateGroups() {
      const candidates = this.lyricsStore.candidates
      if (!candidates) return []
      return Object.entries(candidates)
        .map(([source, results]) => ({ source, results }))
        .filter((group) => group.results.length > 0)
    },
    hasCandidates() {
      return this.candidateGroups.length > 0
    },
  },
  watch: {
    // A new song's lyrics replacing the old ones — reset scroll to the top
    // immediately (this component instance persists across song changes,
    // its scroll position doesn't reset on its own) and let the next
    // activeIndex placement below jump instantly rather than animate.
    'lyricsStore.songId'() {
      this.skipNextScrollAnimation = true
      this.calibrating = false
      this.lyricsStore.clearCandidates()
      const el = this.$refs.scrollEl as HTMLElement | undefined
      if (el) el.scrollTop = 0
    },
    // immediate: true — without it, this only ever fired on a *change*, so
    // mounting straight into an already-loaded, mid-song position (opening
    // this view partway through a track, now the common case since
    // NowPlayingView.vue's own currentSong watcher preloads lyrics
    // regardless of whether this panel is even open yet) left the scroll
    // wherever it started until the *next* line boundary genuinely changed
    // activeIndex — visibly sitting at the top for however long that took
    // instead of opening already at the right place.
    activeIndex: {
      immediate: true,
      handler(newIndex: number, oldIndex: number | undefined) {
        if (newIndex < 0 || newIndex === oldIndex) return
        this.$nextTick(() => this.scrollToActive())
      },
    },
    // Freeze autoscroll for the duration of calibration — the list
    // creeping along while the user is trying to click a specific line
    // would make it a moving target. Snaps back to wherever playback
    // actually is once calibration ends, whether that's from a completed
    // click (onLineClick) or the button being toggled back off.
    calibrating(active: boolean) {
      if (this.resumeTimer) clearTimeout(this.resumeTimer)
      this.autoscrollPaused = active
      if (!active) {
        this.skipNextScrollAnimation = true
        this.$nextTick(() => this.scrollToActive())
      }
    },
  },
  beforeUnmount() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
  },
  methods: {
    scrollToActive() {
      if (this.autoscrollPaused) return
      const el = (this.$refs.lineRefs as HTMLElement[] | undefined)?.[this.activeIndex]
      el?.scrollIntoView({
        behavior: this.skipNextScrollAnimation ? 'auto' : 'smooth',
        block: 'center',
      })
      this.skipNextScrollAnimation = false
    },
    onManualScroll() {
      this.autoscrollPaused = true
      if (this.resumeTimer) clearTimeout(this.resumeTimer)
      // While calibrating, the pause above should hold until calibration
      // itself ends (see the `calibrating` watcher) — not resume on its
      // own timer mid-attempt.
      if (this.calibrating) return
      this.resumeTimer = setTimeout(() => {
        this.autoscrollPaused = false
        this.skipNextScrollAnimation = true
        this.scrollToActive()
      }, MANUAL_SCROLL_PAUSE_MS)
    },
    // Offset-adjusted the same way activeIndex is — seeking to the line's
    // raw time would land slightly before/after it whenever a manual sync
    // correction is dialed in, undoing the point of adjusting it.
    onLineClick(line: LyricLine) {
      if (this.calibrating) {
        // Solve for the offset that makes *this* line the active one right
        // now: activeIndex compares (localPosition - offset) against
        // line.time, so the offset that makes those equal is their
        // difference at this exact instant.
        this.lyricsStore.setOffset(this.playbackStore.localPosition - line.time)
        this.calibrating = false
        return
      }
      void this.playbackStore.seek(line.time + this.lyricsStore.offset)
    },
    // Candidates are fetched on open (not eagerly) — same reasoning as
    // ensureLoaded() itself not being eager: don't hit three third-party
    // search APIs for a picker nobody opened.
    onPickerToggle(open: boolean) {
      if (open && this.currentSong) void this.lyricsStore.loadCandidates(this.currentSong)
      else this.lyricsStore.clearCandidates()
    },
    onSelectCandidate(source: string, candidate: LyricSearchResult) {
      if (this.currentSong) {
        void this.lyricsStore.selectCandidate(this.currentSong, source, candidate.id)
      }
    },
    // `score` is a distance (0 = identical, larger = worse — see
    // connect/routes/lyrics.py's own MATCH_THRESHOLD comparison), not
    // already a percentage. Clamped since /search, unlike /auto, doesn't
    // discard bad matches, so a candidate can score well past 1.
    matchPercent(candidate: LyricSearchResult): number {
      return Math.round(Math.max(0, Math.min(1, 1 - candidate.score)) * 100)
    },
    formatDuration(seconds: number): string {
      const total = Math.round(seconds)
      const minutes = Math.floor(total / 60)
      const secs = total % 60
      return `${minutes}:${String(secs).padStart(2, '0')}`
    },
    isDurationMismatch(candidate: LyricSearchResult): boolean {
      const songDuration = this.currentSong?.duration
      if (candidate.duration == null || songDuration == null) return false
      return Math.abs(candidate.duration - songDuration) > DURATION_MISMATCH_THRESHOLD_S
    },
    // isSync is a real tri-state, not a boolean — NetEase's search API
    // gives no signal either way (see connect/lyrics/netease.py), which is
    // a different thing to tell the user than "confirmed plain text".
    syncIcon(candidate: LyricSearchResult): string {
      if (candidate.isSync == null) return 'mdi-help-circle-outline'
      return candidate.isSync ? 'mdi-timer-sync-outline' : 'mdi-text-long'
    },
    syncLabel(candidate: LyricSearchResult): string {
      if (candidate.isSync == null) return this.$t('lyrics.syncUnknown')
      return candidate.isSync ? this.$t('lyrics.synced') : this.$t('lyrics.unsynced')
    },
    isCurrentCandidate(source: string, candidate: LyricSearchResult): boolean {
      return this.lyricsStore.source === source && this.lyricsStore.remoteId === candidate.id
    },
  },
}
</script>

<style scoped>
.lyrics-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* The active line's transform: scale() (see .lyrics-panel__line below)
   * renders past its own layout box without affecting layout — contain it
   * to the panel itself so it doesn't visually bleed into whatever sits
   * next to it (the artwork column in NowPlayingView's split layout, the
   * toolbar above it in the drawer). */
  overflow: hidden;
}

.lyrics-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  /* Signals "more content above/below" without a hard cutoff, and works
   * regardless of what's behind the panel (solid surface in the compact
   * drawer, blurred album art in the immersive view) — an alpha mask, not
   * a background-color overlay, is what makes that background-agnostic. */
  mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
}

.lyrics-panel__scroll::-webkit-scrollbar {
  display: none;
}

/* Unlike the synced view — where autoscroll itself signals "you can
 * follow along" and a hidden scrollbar reads as deliberate polish —
 * unsynced lyrics have nothing driving the view, so a visible (if
 * subtle) scrollbar is what makes "you can freely scroll this" obvious
 * rather than something you have to discover by accident. */
.lyrics-panel__scroll--plain {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar {
  display: block;
  width: 6px;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar-song {
  background: transparent;
}

.lyrics-panel__scroll--plain::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.lyrics-panel__pad {
  /* Half the panel's own height — lets scrollIntoView({block: 'center'})
   * actually center the first/last real line instead of stopping short at
   * the scroll container's hard edge. */
  height: 50%;
  flex-shrink: 0;
}

.lyrics-panel__line {
  padding: 8px 0;
  font-weight: 600;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.55);
  text-align: center;
  margin: 0 auto;
  /* scale(), not font-size — font-size changes the line's own layout box,
   * which reflows/shifts every line below it as soon as one becomes
   * active (worse yet on a wrapped multi-line entry, where the box grows
   * taller too). A transform only changes the rendered pixels, not layout,
   * so neighbors never move. Scaling from the center (not an edge) means
   * the growth is symmetric — each variant's max-width below reserves
   * exactly enough margin on both sides that even a line filling the
   * entire box can't scale past the panel's own edge. */
  transform-origin: center;
  transform: scale(1);
  transition:
    color 0.25s ease,
    opacity 0.25s ease,
    transform 0.25s ease,
    text-shadow 0.25s ease;
}

.lyrics-panel__line--clickable {
  cursor: pointer;
}

.lyrics-panel__line--clickable:hover:not(.lyrics-panel__line--active) {
  color: rgba(255, 255, 255, 0.85);
}

.lyrics-panel__line--past {
  opacity: 0.55;
}

.lyrics-panel__line--active {
  color: #fdf6ec;
  opacity: 1;
  text-shadow: 0 0 24px rgba(245, 169, 78, 0.45);
}

.lyrics-panel__line--plain {
  white-space: pre-line;
  color: rgba(255, 255, 255, 0.55);
  font-weight: 400;
  line-height: 1.7;
}

.lyrics-panel__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}

.lyrics-panel__skeleton {
  padding: 4px 0;
}

/* Vuetify's default bone color/shimmer is tuned for a solid surface
 * background — over the immersive view's blurred-photo backdrop it reads
 * too bright/busy. Flatten it to the same translucent-white language used
 * for inactive lines and the edge mask elsewhere in this panel. */
.lyrics-panel__skeleton :deep(.v-skeleton-loader__bone) {
  background: rgba(255, 255, 255, 0.08);
}

.lyrics-panel__skeleton :deep(.v-skeleton-loader__bone::after) {
  display: none;
}

/* Compact (docked drawer) — centered, modest scale. max-width 85% is
 * derived from the active scale below (1.15): a line filling the full
 * box would grow to 1.15× on each side, i.e. 0.075 of the box's own
 * width past its edge — capping the box at 1/1.15 ≈ 87% of the panel
 * leaves enough margin either side to absorb that with room to spare. */
.lyrics-panel--compact .lyrics-panel__line {
  font-size: 1rem;
  padding: 8px 20px;
  max-width: 85%;
}

.lyrics-panel--compact .lyrics-panel__line--active {
  transform: scale(1.15);
}

/* Immersive (fullscreen Now Playing) — centered, much larger. Same
 * headroom math as compact above, for a 1.25× active scale: capped at
 * 1/1.25 = 80% of the panel, kept at 78% for a small safety margin.
 *
 * cqw/cqh, not a fixed rem — this renders inside NowPlayingView.vue's
 * .now-playing__stage (a container-type: size host, see its own comment),
 * the same measurement basis the artwork/title there already scale
 * against. A fixed size here read proportionally huge on a small window
 * and small on a large one, exactly the bug the title had before it got
 * the same treatment. cqw is scaled down from .now-playing__lyrics' own
 * ~38cqw box width (container query units measure against the *stage*,
 * not this narrower column, so the multiplier has to account for that
 * gap) rather than assuming the full stage width. */
.lyrics-panel--immersive .lyrics-panel__line {
  font-size: clamp(1.1rem, min(2.2cqw, 3.5cqh), 1.9rem);
  padding: 12px 32px;
  max-width: 78%;
}

.lyrics-panel--immersive .lyrics-panel__line--active {
  transform: scale(1.25);
}

.lyrics-panel--immersive .lyrics-panel__line--plain {
  font-size: clamp(0.95rem, min(1.8cqw, 2.8cqh), 1.5rem);
  max-width: 640px;
  margin: 0 auto;
}

/* Armed by the target button in .lyrics-panel__sync below — the next
 * line click calibrates instead of seeking, so both the cursor and the
 * hover glow borrow the active-line's own amber "beacon" language to
 * signal "clicking now does something different." */
.lyrics-panel__scroll--calibrating {
  cursor: crosshair;
}

.lyrics-panel__scroll--calibrating .lyrics-panel__line--clickable:hover {
  color: #fdf6ec;
  text-shadow: 0 0 16px rgba(245, 169, 78, 0.5);
}

.lyrics-panel__calibrate-hint {
  text-align: center;
  font-size: 0.7rem;
  color: rgba(245, 169, 78, 0.85);
  padding: 2px 12px 0;
  flex-shrink: 0;
}

.lyrics-panel__sync {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 0 2px;
  flex-shrink: 0;
}

.lyrics-panel__sync-label {
  min-width: 3.5em;
  text-align: center;
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.45);
  padding-inline: 8px;
}

.lyrics-panel__sync-label--resettable {
  cursor: pointer;
}

.lyrics-panel__sync-label--resettable:hover {
  color: rgba(255, 255, 255, 0.75);
}

.lyrics-panel__toolbar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.lyrics-panel__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 12px 4px;
}

.lyrics-panel__source {
  min-width: 0;
  overflow: hidden;
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.4);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Pushed to the far side regardless of whether .lyrics-panel__source is
 * present (nothing loaded yet has no source to show, but still offers
 * the picker). */
.lyrics-panel__pick-btn {
  /* No custom font-size here anymore — v-btn's own x-small/compact sizing
   * already picks a proportional min-height/padding for its *own* default
   * font-size; overriding just the font-size (smaller, in this case)
   * without touching those left the fixed-height button box shorter than
   * the label needed, so the text visibly spilled outside it. height: auto
   * lets it grow to fit its content regardless. */
  flex-shrink: 0;
  height: auto !important;
  margin-left: auto;
  color: rgba(255, 255, 255, 0.55);
}

.lyrics-panel__candidates {
  min-width: 260px;
  max-height: 320px;
  overflow-y: auto;
}

/* Vuetify's own :active tint is subtle enough to miss in a dense list —
 * the checkmark (see template) plus a bolder title makes "this is what's
 * currently loaded" unambiguous at a glance. */
.lyrics-panel__candidate--current :deep(.v-list-item-title) {
  font-weight: 600;
}

.lyrics-panel__candidate-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.lyrics-panel__candidate-score,
.lyrics-panel__candidate-duration {
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.45);
  margin-left: 1em;
}

.lyrics-panel__candidate-duration--mismatch {
  color: rgb(var(--v-theme-error));
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-panel__line {
    transition: none;
  }

  .lyrics-panel__scroll {
    scroll-behavior: auto;
  }
}
</style>
