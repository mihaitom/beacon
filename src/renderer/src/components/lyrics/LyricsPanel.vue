<template>
  <div
    class="lyrics-panel"
    :class="[`lyrics-panel--${variant}`, { 'lyrics-panel--mobile': mobile }]"
  >
    <!-- One line of text for both of the states that have no lyrics to
     - show: looking for them, and not having found any.
     -
     - This used to be a column of skeleton bones while loading, which was
     - the wrong promise to make here. A skeleton stands in for content
     - whose shape is known and whose arrival is expected — neither holds
     - for lyrics: how many lines there are is unknown until they arrive,
     - and "this song has none" is a normal outcome rather than a failure
     - (see stores/lyrics.ts, which caches exactly that answer). Six bars of
     - pretend text collapsing into "no lyrics found" said the opposite.
     - There is no layout argument for them either, the way there is on a
     - shelf of cards: this panel is a fixed box, and both states fill it
     - identically. The immersive variant had already dropped the bones for
     - looking wrong over its blurred backdrop, which left the two variants
     - disagreeing; a line of text works in both. -->
    <lyrics-lines
      v-model:autoscroll-paused="autoscrollPaused"
      :lines="source.lyrics.lines"
      :synced="source.lyrics.synced"
      :position="source.position - source.lyrics.offset"
      :status="source.lyrics.status"
      :variant="variant"
      :calibrating="calibrating"
      :song-key="source.lyrics.songKey"
      :interactive="source.capabilities.lyricsTools"
      @line-click="onLineClick"
    />

    <!-- A party guest has no tools, but keeps the one control that is theirs:
     * handing the list back after scrolling it by hand. Floated where the
     * guest always showed it. -->
    <v-btn
      v-if="!source.capabilities.lyricsTools && autoscrollPaused"
      icon="mdi-format-vertical-align-center"
      size="small"
      variant="text"
      color="primary"
      class="lyrics-panel__resume-float"
      :title="$t('lyrics.resumeAutoscroll')"
      @click="resumeAutoscroll"
    />

    <!-- The host's tools. Not rendered at all for a guest, so none of this
     - markup or behaviour reaches the guest page. -->
    <div
      v-if="source.capabilities.lyricsTools && !source.lyrics.loading"
      class="lyrics-panel__toolbar"
    >
      <div v-if="calibrating" class="lyrics-panel__calibrate-hint">
        {{ $t('lyrics.calibrateHint') }}
      </div>

      <!-- The matched lyrics are often a slightly different edit/version
       - than this exact audio file — this is the escape hatch for "close
       - but consistently early/late", not something most songs need. -->
      <div v-if="source.lyrics.synced" class="lyrics-panel__sync">
        <!-- Only while autoscroll is off, which is exactly when it means
         - anything: scrolling by hand hands the list to the reader and
         - keeps it there (see onManualScroll), and this is how it goes
         - back to following the song. -->
        <v-btn
          v-if="autoscrollPaused && !calibrating"
          icon="mdi-format-vertical-align-center"
          :size="mobile ? 'small' : 'x-small'"
          variant="text"
          :density="mobile ? 'comfortable' : 'compact'"
          color="primary"
          class="lyrics-panel__resume-btn"
          :title="$t('lyrics.resumeAutoscroll')"
          @click="resumeAutoscroll"
        />
        <v-btn
          icon="mdi-target"
          :size="mobile ? 'small' : 'x-small'"
          variant="text"
          :density="mobile ? 'comfortable' : 'compact'"
          :color="calibrating ? 'primary' : undefined"
          :title="$t('lyrics.calibrate')"
          @click="calibrating = !calibrating"
        />
        <v-divider vertical />
        <v-btn
          icon="mdi-rewind"
          :size="mobile ? 'small' : 'x-small'"
          variant="text"
          :density="mobile ? 'comfortable' : 'compact'"
          :title="$t('lyrics.syncEarlier')"
          @click="source.setLyricsOffset(source.lyrics.offset - 0.1)"
        />
        <span
          class="lyrics-panel__sync-label"
          :class="{ 'lyrics-panel__sync-label--resettable': source.lyrics.offset !== 0 }"
          :title="source.lyrics.offset !== 0 ? $t('lyrics.syncReset') : undefined"
          @click="source.lyrics.offset !== 0 && source.resetLyricsOffset(source.lyrics.offset)"
        >
          {{ offsetLabel }}
        </span>
        <v-btn
          icon="mdi-fast-forward"
          :size="mobile ? 'small' : 'x-small'"
          variant="text"
          :density="mobile ? 'comfortable' : 'compact'"
          :title="$t('lyrics.syncLater')"
          @click="source.setLyricsOffset(source.lyrics.offset + 0.1)"
        />
      </div>

      <div class="lyrics-panel__meta">
        <!-- Source and, under it, whoever the sheet names as having written
         - the song. Those credits arrive as the first few lyric lines,
         - timed milliseconds apart (see parseLrc.ts's splitOffCredits) —
         - unreadable there, so they are shown here for as long as the song
         - plays rather than thrown away. -->
        <div class="lyrics-panel__attribution">
          <a
            v-if="source.lyrics.sourceUrl"
            :href="source.lyrics.sourceUrl"
            target="_blank"
            rel="noopener"
            class="lyrics-panel__source lyrics-panel__source--link"
            :title="$t('library.viewOnService', { service: source.lyrics.sourceLabel })"
            >{{ $t('lyrics.source', { source: source.lyrics.sourceLabel }) }}</a
          >
          <span v-else-if="source.lyrics.sourceLabel" class="lyrics-panel__source">{{
            $t('lyrics.source', { source: source.lyrics.sourceLabel })
          }}</span>
          <span
            v-for="credit in source.lyrics.credits"
            :key="credit"
            class="lyrics-panel__credit"
            >{{ credit }}</span
          >
        </div>
        <!-- The auto-matched lyrics can be for the wrong edit of a song
         - entirely (not just mistimed) — this is the escape hatch for that,
         - also the main way to find lyrics at all when nothing auto-matched.
         - A dropdown menu works fine with a mouse, but on a phone a floating
         - panel anchored to a small toolbar button is fiddly to hit and
         - easy to close by mis-touching; a bottom sheet gives the same list
         - full-width, thumb-reachable real estate instead. -->
        <!-- close-on-content-click stays false so scrolling and mis-taps
         - inside the list don't dismiss it; the one thing that *should*
         - close it is a pick, which closePicker() below does through this
         - v-model. -->
        <v-menu
          v-if="!mobile"
          v-model="desktopPickerOpen"
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
          <lyrics-candidate-list @select="closePicker" />
        </v-menu>
        <v-btn
          v-else
          size="small"
          variant="text"
          density="comfortable"
          prepend-icon="mdi-format-list-bulleted"
          class="lyrics-panel__pick-btn"
          @click="openMobilePicker"
        >
          {{ $t('lyrics.pickMatch') }}
        </v-btn>
      </div>
    </div>

    <!-- @update:model-value handles *closing* (backdrop click, swipe-down —
     - v-bottom-sheet emits that itself on its own state changes) but never
     - fires for openMobilePicker()'s own opening below, which sets
     - mobilePickerOpen from the outside rather than through an interaction
     - this component initiates — see that method's own comment. -->
    <v-bottom-sheet v-if="mobile" v-model="mobilePickerOpen" @update:model-value="onPickerToggle">
      <v-card class="lyrics-panel__mobile-sheet">
        <div class="lyrics-panel__mobile-sheet-header">
          <span class="text-body-large">{{ $t('lyrics.pickMatch') }}</span>
        </div>
        <lyrics-candidate-list @select="closePicker" />
      </v-card>
    </v-bottom-sheet>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { LyricLine } from '@/services/lyrics/parseLrc'
import LyricsCandidateList from '@/components/lyrics/LyricsCandidateList.vue'
import LyricsLines from '@/components/lyrics/LyricsLines.vue'
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'

export default {
  name: 'LyricsPanel',
  components: { LyricsCandidateList, LyricsLines },
  mixins: [nowPlayingSourceMixin],
  props: {
    variant: {
      type: String as PropType<'compact' | 'immersive'>,
      default: 'compact',
    },
    // Swaps the toolbar to bigger touch targets and the match picker from
    // a v-menu dropdown to a full-width v-bottom-sheet — a floating panel
    // anchored to a small button is fine with a mouse but fiddly to hit
    // (and easy to dismiss by mis-touching) on a phone. Named for the
    // input method, not the layout — deliberately independent of `variant`,
    // since compact/immersive is about which host renders this panel, not
    // whether that host is being touched or clicked.
    mobile: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      // Shared with LyricsLines (v-model): scrolling by hand there pauses
      // it, the resume button and calibration here hand it back.
      autoscrollPaused: false,
      // Armed by the target button — while true, the *next* line click
      // calibrates the offset instead of seeking (see onLineClick below).
      calibrating: false,
      mobilePickerOpen: false,
      desktopPickerOpen: false,
    }
  },
  computed: {
    // Spelled out as "later"/"earlier" rather than a +/- sign — the sign
    // requires remembering which direction it maps to (does + mean the
    // lyrics or the audio moves?); the word doesn't.
    offsetLabel() {
      const offset = this.source.lyrics.offset
      if (offset === 0) return this.$t('lyrics.sync')
      const seconds = Math.abs(offset).toFixed(1)
      return offset > 0
        ? this.$t('lyrics.laterBy', { seconds })
        : this.$t('lyrics.earlierBy', { seconds })
    },
  },
  watch: {
    // A new song: calibration and the held match candidates belong to
    // the old one. LyricsLines resets its own scroll.
    'source.lyrics.songKey'() {
      this.calibrating = false
      this.source.clearLyricsCandidates()
    },
    // Freeze autoscroll for the duration of calibration — the list
    // creeping along while the user is trying to click a specific line
    // would make it a moving target. Snaps back to wherever playback
    // actually is once calibration ends, whether that's from a completed
    // click (onLineClick) or the button being toggled back off.
    calibrating(active: boolean) {
      this.autoscrollPaused = active
    },
  },
  methods: {
    /** Hands the list back to playback (LyricsLines jumps to the line
     * that is playing). */
    resumeAutoscroll() {
      this.autoscrollPaused = false
    },
    // Offset-adjusted the same way activeIndex is — seeking to the line's
    // raw time would land slightly before/after it whenever a manual sync
    // correction is dialed in, undoing the point of adjusting it.
    onLineClick(line: LyricLine) {
      if (this.calibrating) {
        // Solve for the offset that makes *this* line the active one right
        // now: activeIndex compares (position - offset) against line.time,
        // so the offset that makes those equal is their difference at this
        // exact instant.
        this.source.setLyricsOffset(this.source.position - line.time)
        this.calibrating = false
        return
      }
      this.source.seek(line.time + this.source.lyrics.offset)
    },
    // Candidates are fetched on open (not eagerly) — same reasoning as
    // ensureLoaded() itself not being eager: don't hit three third-party
    // search APIs for a picker nobody opened.
    //
    // Closing deliberately keeps them: picking the right sheet usually
    // takes a few tries, and loadCandidates() hands the held list straight
    // back, so every open after the first is instant. The song-change
    // watcher above is what drops them.
    onPickerToggle(open: boolean) {
      if (open) this.source.loadLyricsCandidates()
    },
    // v-bottom-sheet only emits update:model-value for state changes it
    // initiates itself (backdrop click, swipe-down) — setting its v-model
    // from the outside, like this button click does, changes the prop but
    // never fires that event, so onPickerToggle(true) (and therefore
    // loadCandidates()) never ran; the sheet opened empty every time,
    // showing "no candidates" regardless of what was actually available.
    // Called directly here instead of relying on the event for opening.
    openMobilePicker() {
      this.mobilePickerOpen = true
      this.onPickerToggle(true)
    },
    // Both presentations at once rather than branching on `mobile`: only
    // one of the two is ever mounted, so clearing both is the cheaper
    // statement of "the picker is done".
    //
    // No onPickerToggle(false) alongside it — neither container emits
    // update:model-value for a change made from out here (see the bottom
    // sheet's own comment above), and there is nothing left to clear
    // anyway: selecting a candidate empties the list itself.
    closePicker() {
      this.mobilePickerOpen = false
      this.desktopPickerOpen = false
    },
  },
}
</script>

<style scoped>
.lyrics-panel {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* The active line's transform: scale() (see LyricsLines.vue's .lyrics-panel__line)
   * renders past its own layout box without affecting layout — contain it
   * to the panel itself so it doesn't visually bleed into whatever sits
   * next to it (the artwork column in NowPlayingView's split layout, the
   * toolbar above it in the drawer). */
  overflow: hidden;
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
  /* Enough room that the icons read as separate controls rather than one
   * run-together strip — they sit at compact density, which leaves them
   * almost touching at the 2px this used to have. */
  gap: 6px;
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

/* Where the guest's one control sits, with no toolbar to hold it: the
 * bottom-right corner of the panel, as the guest page always showed it. */
.lyrics-panel__resume-float {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 1;
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

.lyrics-panel__source--link {
  text-decoration: none;
}

.lyrics-panel__source--link:hover {
  color: rgba(255, 255, 255, 0.7);
  text-decoration: underline;
}

/* Source and credits stack, so a song with three of them doesn't push the
 * picker button off the row. */
.lyrics-panel__attribution {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
  /* Explicit, not inherited: the panel centres its lyric lines, and
   * without this the source line drifted to the middle over credits that
   * are far wider than it is. */
  text-align: left;
}

/* Quieter than the source line above it: an attribution worth keeping, not
 * something competing with the lyrics themselves. */
.lyrics-panel__credit {
  overflow: hidden;
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.3);
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

/* .lyrics-panel__source has min-width: 0 (deliberately shrinkable, see its
 * own rule) while .lyrics-panel__pick-btn is flex-shrink: 0 (never
 * shrinks) — on mobile's narrower toolbar, now with a wider touch-sized
 * button (see the mobile prop's own comment), that left nothing for the
 * source label to shrink *into* short of disappearing outright at 0 width.
 * Wrapping it to its own row instead keeps it readable rather than
 * fighting the button for a single line neither fits on. */
.lyrics-panel--mobile .lyrics-panel__meta {
  flex-wrap: wrap;
}

.lyrics-panel__mobile-sheet {
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.lyrics-panel__mobile-sheet-header {
  padding: 16px 16px 4px;
  flex-shrink: 0;
}
</style>
