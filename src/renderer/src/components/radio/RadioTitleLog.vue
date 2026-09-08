<template>
  <div class="title-log" :class="`title-log--${variant}`">
    <!-- The scrolling happens one level in, not on the root. Both callers
       - put their own class on the root (NowPlayingView's
       - .now-playing__lyrics, the drawer's own slot rule), and that class
       - owns the root's height and overflow — the same arrangement
       - LyricsPanel.vue has for the same reason. A root that tried to be
       - the scroller too would be fighting whichever stylesheet loaded
       - last for both properties. -->
    <!-- The log's own head, and the only chrome this panel has. It carries
       - the search because that is where searching happens: the screen's
       - own toolbar sits at the far corner and is shared with the lyrics
       - switch, fullscreen and the visualizer, none of which is about this
       - list.
       -
       - Collapsed to a magnifier until it is wanted. A field standing open
       - permanently would spend a row of a panel that is 85cqh tall on a
       - question most readings of a log never ask, and it would draw the
       - eye to itself rather than to the title playing now, which is what
       - this panel is opened for. -->
    <div class="title-log__head">
      <!-- The field arrives the way a title does — same fall from above,
         - same 0.3s (see the transition-group's own entrance below). It is
         - the one other thing that appears at the top of this panel, so
         - borrowing that movement is what makes it read as part of the log
         - rather than as chrome dropped on top of it.
         -
         - The two states are stacked in one grid cell rather than laid
         - out side by side, so the field can arrive over the heading
         - instead of the row reflowing around both of them for a frame.
         -
         - It sits outside .title-log__scroll on purpose, so a title
         - arriving mid-search cannot push it down — the list moves under
         - it, the field stays where it was typed into. -->
      <transition name="title-log-search">
        <!-- v-text-field over a bare <input>: it brings the clear button,
           - the focus ring and the label wiring, and matches every other
           - search box in the app (`.library-search`). `hide-details`
           - because a message row under it would be a second line of
           - chrome for a control that cannot be invalid. -->
        <v-text-field
          v-if="searching"
          key="field"
          :model-value="query"
          class="title-log__search-field"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          clearable
          autofocus
          prepend-inner-icon="mdi-magnify"
          :loading="pending"
          :placeholder="$t('radio.titleLogFilterPlaceholder')"
          @update:model-value="$emit('update:query', $event ?? '')"
          @click:clear="closeSearch"
          @keydown.esc="closeSearch"
        />
      </transition>
      <!-- One element, not a heading and a button side by side: it shares
         - the grid cell with the field above and the two are mutually
         - exclusive, so only ever one of them is in it. -->
      <div v-if="!searching" class="title-log__head-idle">
        <h3 class="eyebrow-label panel-title title-log__head-title">
          {{ $t('radio.titleLog') }}
        </h3>
        <v-btn
          icon="mdi-magnify"
          size="small"
          variant="text"
          density="comfortable"
          color="primary"
          :title="$t('radio.titleLogFilter')"
          @click="searching = true"
        />
      </div>
    </div>
    <div ref="scroller" class="title-log__scroll" @scroll.passive="onScroll">
      <!-- A timeline rather than a plain list: what this shows is a
         - sequence of moments on one station, and the dots carry two
         - things a list had to spend a row or a colour on — where a day
         - starts, and which entry is the one playing right now.
         -
         - `density="compact"` with `side="end"` collapses the opposite
         - column to zero (Vuetify's own grid template), so the dot column
         - is the x-small dot's 22px and nothing else. That matters: the
         - drawer this lives in is 380px wide and the title line already
         - truncates. The wall-clock time stays *inside* the body, in its
         - own column, rather than in the opposite slot a wider layout
         - would use for it. -->
      <v-timeline
        v-if="entries.length"
        class="title-log__list"
        align="center"
        side="end"
        density="compact"
        truncate-line="both"
        line-thickness="1"
      >
        <!-- No `tag`, so this renders as a fragment and the items stay
           - direct children of the timeline's own grid - a wrapper element
           - here would take them out of it and the whole layout with them.
           -
           - `css` is what decides whether a change animates at all, and it
           - is off for most of them: a page of older entries arriving at
           - the bottom (see @scroll below) would otherwise fade thirty rows
           - in at once, and so would switching stations, which replaces the
           - list wholesale. Only a title genuinely arriving at the top gets
           - the entrance - see the `entries` watcher.
           -
           - No `appear`, deliberately: QueueDrawer.vue's own transition
           - group has the long version of why (Vue's move logic racing its
           - own initial render), and this list mounts inside a drawer that
           - starts closed, which is exactly that situation.
           -
           - `duration` is spelled out as a precaution rather than a fix:
           - Vue reads the transition off the element it puts the classes
           - on, and that element is a v-timeline-item, which Vuetify gives
           - `display: contents` and which therefore declares no transition
           - of its own (the entrance lives on its children - see the style
           - block). Chromium happens to finish the children's transition
           - even when the classes come off early, which is not something
           - worth depending on. -->
        <transition-group name="title-log" :duration="ENTER_MS" :css="animateInsert">
          <template v-for="row in rows" :key="row.key">
            <!-- A day heading is not an event, so it gets no dot — the line
               - runs past it. A dot here would read as "something played at
               - the start of Tuesday", which is not what it says. -->
            <v-timeline-item v-if="row.divider" :key="row.key" hide-dot>
              <span class="title-log__day">{{ row.divider }}</span>
            </v-timeline-item>
            <!-- The dot carries what the row itself has no room to say: the
             - one entry that is playing right now, and the lines that do
             - not read as a song at all. An ordinary song gets a plain
             - dot, so that the marked ones are the ones that stand out. -->
            <v-timeline-item
              v-else
              :key="row.key"
              size="x-small"
              :class="{ 'title-log__break': row.afterBreak }"
              :dot-color="row.newest ? 'primary' : 'secondary'"
              :fill-dot="row.newest"
              :icon="dotIcon(row)"
              icon-color="background"
            >
              <!-- The whole card is the search target, not the title inside
               - it: a row this size is easier to hit than the text on it,
               - and on a phone that is the difference between a tap and a
               - careful tap. Only a row that reads as a song gets one -
               - handing a news headline to the library search returns
               - nothing and invites the click anyway - so the card is a
               - real <button> there and a plain div for everything else,
               - rather than a div that pretends. -->
              <component
                :is="split(row.entry!.title) ? 'button' : 'div'"
                class="title-log__item"
                :class="{
                  'title-log__item--now': row.newest,
                  'title-log__item--searchable': !!split(row.entry!.title),
                }"
                :type="split(row.entry!.title) ? 'button' : undefined"
                :title="split(row.entry!.title) ? $t('radio.titleLogSearch') : undefined"
                @click="split(row.entry!.title) && search(split(row.entry!.title)!.track)"
              >
                <span class="title-log__time">{{ formatTime(row.entry!.at) }}</span>
                <span v-if="split(row.entry!.title)" class="title-log__text">
                  <span class="title-log__track">{{ split(row.entry!.title)!.track }}</span>
                  <span class="title-log__artist">{{ split(row.entry!.title)!.artist }}</span>
                </span>
                <span v-else class="title-log__text">
                  <span class="title-log__plain">{{ row.entry!.title }}</span>
                </span>
              </component>
            </v-timeline-item>
          </template>
        </transition-group>
      </v-timeline>
      <p v-else class="title-log__empty">
        {{ query ? $t('radio.titleLogFilterEmpty', { query }) : $t('radio.titleLogEmpty') }}
      </p>
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { isMobileWebNow } from '@/composables/useIsMobileWeb'
import type { RadioTitleEntry } from '@/services/connect/radioMetadata'

/** Splits an "Artist - Track" title on the first " - ", the separator ICY
 * titles conventionally use. Spaces around the dash are required: plenty
 * of legitimate single-line titles are hyphenated words ("ARD-Infosamstag",
 * sampled live 2026-09-05) and would otherwise be torn in half. */
const SEPARATOR = ' - '

/** One rendered line: either a title, or the date heading that introduces
 * the ones below it. */
interface LogRow {
  key: string
  entry?: RadioTitleEntry
  divider?: string
  /** The entry that is playing right now — matched against `currentAt`,
   * never inferred from being first (see that prop). Marked here rather
   * than left to a positional CSS selector for a second reason too: a date
   * heading is a sibling <li>, so neither :first-child nor :first-of-type
   * (which counts by tag, not by class) still picks out the first *entry*
   * once one appears above it — caught by
   * RadioTitleLog.layout.browser.test.ts. */
  newest?: boolean
  /** Not readable as artist and track — usually a programme name, a news
   * item or the station's own slogan. Marked on the timeline dot rather
   * than in the row, which has nothing to spare. */
  plain?: boolean
  /** Nothing was logged for a long while before this entry: the station was
   * off, or something else was playing. Drawn as a gap in the line, so the
   * log reads as the sittings it actually was rather than as one unbroken
   * evening. */
  afterBreak?: boolean
}

/** How long a new title's entrance runs. Named here as well as in the CSS
 * because the transition group has to be told (see its `duration` in the
 * template) - the two have to say the same thing. */
const ENTER_MS = 300

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a silence has to be before the log shows it as a break.
 *
 * A station changes title every three or four minutes, and the longest
 * single thing one sends under one title - a news block, a symphony
 * movement - stays well inside this. Twenty minutes with nothing logged
 * therefore means nobody was listening to this station: it was off, or
 * another one was playing. Erring long on purpose; a break drawn where
 * there was none is a lie about the evening, while a missing one only
 * costs a bit of white space. */
const LISTENING_BREAK_SECONDS = 20 * 60

/** How close to the bottom counts as "about to run out", in pixels. Around
 * a screenful of rows on a phone, so the next page is usually already
 * there by the time the reader arrives at what it holds. */
const NEAR_END_PX = 600

/** Midnight local time for `date`, as a number — comparing these is how two
 * timestamps are told to be on the same calendar day in the *reader's* own
 * timezone, which is the one that decides what "yesterday" means. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export default {
  name: 'RadioTitleLog',
  props: {
    entries: {
      type: Array as PropType<RadioTitleEntry[]>,
      default: () => [],
    },
    /** Which surface this is sitting on, named the same way LyricsPanel.vue
     * names it since the two swap places: `compact` is the drawer's own
     * panel, `immersive` is Now Playing's blurred artwork. Only the
     * timeline's own line and dots differ — see their rules in the style
     * block, and why a ground the app does not control changes what they
     * can be made of. */
    variant: {
      type: String as PropType<'compact' | 'immersive'>,
      default: 'compact',
    },
    /** Whether anything older than the oldest entry shown is still to be
     * had. False both while a log is complete and while none is playing,
     * and in both cases scrolling to the bottom asks for nothing. */
    hasMore: { type: Boolean, default: false },
    /** What `entries` is currently the result of, empty when it is simply
     * the log. Named `query` rather than `search` because this component
     * already has a search() of its own, which is the other kind entirely:
     * looking a track up in the user's library. Held by the caller rather than here because the search runs
     * against the backend (see the radio-metadata store's search()) and this
     * component only ever renders the entries it is handed — the same
     * arrangement `entries`/`load-more` already has for paging. */
    query: { type: String, default: '' },
    /** A search request is out. Rendered on the field itself, so an
     * as-yet-unanswered search does not read as "nothing found". */
    pending: { type: Boolean, default: false },
    /** The `at` of the entry that is playing right now, or null when
     * nothing is.
     *
     * Passed in rather than taken to be the first row: that only holds
     * while the list *is* the log. A search answers with matches from all
     * over the station's evening, and its topmost row is simply the newest
     * match — marking it as "on air" would put the play icon, the amber
     * dot and the lit card on a track that finished hours ago. */
    currentAt: { type: Number as PropType<number | null>, default: null },
  },
  emits: ['load-more', 'update:query'],
  data() {
    return {
      // Whether the *next* render is allowed to animate - see the watcher
      // below, and the transition group in the template.
      animateInsert: false,
      // Whether the search field is showing. Local, unlike the query
      // itself: an open-but-empty field is this panel's own business, and
      // nothing outside it can act on the difference.
      searching: this.query !== '',
    }
  },
  watch: {
    /** Arms the entrance for one render, and only for the one change that
     * should have it: a title the station has just started playing,
     * arriving at the top of the list.
     *
     * Everything else that changes this list would animate badly. Scrolling
     * to the end appends a page of thirty older entries at once, which as
     * an entrance is a wall of movement about something the reader asked
     * for and is already looking at. Switching stations replaces the list
     * wholesale, and a hundred rows fading in reads as the panel breaking
     * rather than as a new station. Both are told apart from a genuine
     * arrival by shape alone: exactly one row more than before, and what
     * used to be the first row is now the second.
     *
     * Comparing by the same key the rows are rendered with, not by object
     * identity - these come from the store as fresh objects on every poll.
     */
    entries(next: RadioTitleEntry[], previous: RadioTitleEntry[]) {
      const key = (entry: RadioTitleEntry | undefined): string | null =>
        entry ? `${entry.at}-${entry.title}` : null
      this.animateInsert =
        previous.length > 0 &&
        next.length === previous.length + 1 &&
        key(next[0]) !== key(previous[0]) &&
        key(next[1]) === key(previous[0])
    },
  },
  computed: {
    ENTER_MS: () => ENTER_MS,
    /** The entries with a date heading wherever the day changes going down
     * the list.
     *
     * Needed because a row only carries a time of day, and this log
     * genuinely outlives one: it survives switching stations and stopping
     * playback, and the session behind it stays alive for as long as the
     * app is open (connect/core/session.py touches it on every request).
     * A station playing across midnight therefore produces two rows that
     * both read "23:50" with nothing to tell them apart — and since the
     * repeat guard is a 30-minute window, the very same track heard on two
     * evenings really does appear twice.
     *
     * Today gets no heading: "now" is the context a reader already
     * assumes, and labelling it would put a line above every log including
     * the overwhelming majority that never leave the day they started in.
     * Anything else is labelled, the top row included — a log whose newest
     * entry is itself from yesterday must not be read as today's. */
    rows(): LogRow[] {
      const today = startOfDay(new Date())
      const out: LogRow[] = []
      let lastDay: number | null = null
      let previous: RadioTitleEntry | null = null
      for (const entry of this.entries) {
        const day = startOfDay(new Date(entry.at * 1000))
        let dayChanged = false
        if (day !== lastDay) {
          if (day !== today) out.push({ key: `day-${day}`, divider: this.dayLabel(day) })
          dayChanged = lastDay !== null
          lastDay = day
        }
        out.push({
          key: `${entry.at}-${entry.title}`,
          entry,
          newest: this.currentAt !== null && entry.at === this.currentAt,
          // Whether this reads as a song at all - the same question the
          // row body asks to decide on a search button, asked once here so
          // the dot beside it can say the same thing.
          plain: !this.split(entry.title),
          // The list runs newest first, so the entry above this one is the
          // later of the two and the silence is the distance down to here.
          // Not marked where a date heading has just been written: that
          // already separates the two sittings, and a gap under it as well
          // reads as two breaks for one night's sleep.
          // Never in a filtered list: the gap between two matches is the
          // music between them, not a pause in the listening, and marking
          // every one of them would draw a broken line through a search
          // that simply skipped a few hours of songs.
          afterBreak:
            !this.query &&
            !dayChanged &&
            previous !== null &&
            previous.at - entry.at > LISTENING_BREAK_SECONDS,
        })
        previous = entry
      }
      return out
    },
  },
  methods: {
    /** Asks for the next page as the end of the list comes into reach,
     * rather than at the moment it is hit: a log read on a phone is
     * flicked through, and a request that only starts once the last row is
     * on screen arrives after the scroll has already stopped there.
     *
     * NEAR_END_PX is deliberately generous for that reason - roughly a
     * screenful of rows ahead. Fires on every scroll event without
     * throttling of its own: the store's own loadOlder() is a
     * no-op while a page is in flight and once the log is complete, which
     * is the same guard a throttle here would need and one that cannot
     * drift out of step with the request it guards. */
    onScroll(): void {
      if (!this.hasMore) return
      const el = this.$refs.scroller as HTMLElement | undefined
      if (!el) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_END_PX) {
        this.$emit('load-more')
      }
    },
    /** mdi-play for what is playing now, a plain line of text for a title
     * that does not split into artist and track, and nothing for the songs
     * in between — an icon on every row would be texture rather than
     * information.
     *
     * The text glyph is deliberately neutral. A microphone stood here
     * first, and it claimed more than split() knows: what is actually
     * being marked is "no ' - ' in this title", which is not the same
     * question as "is this speech". It is wrong in both directions — the
     * station's own slogan ("Deutschlandfunk - Alles von Relevanz",
     * sampled live) splits like a song and gets no mark, and a station
     * that sends a bare track title with no artist would get a microphone
     * on real music. A line of text says what we have: text that is not
     * shaped like a song, whatever it turns out to be. */
    dotIcon(row: LogRow): string | undefined {
      if (row.newest) return 'mdi-play'
      if (row.plain) return 'mdi-text-short'
      return undefined
    },
    /** Puts the field away and drops the search with it — the two are one
     * gesture. Leaving the query in force behind a closed field would show
     * a filtered log with nothing on screen saying why. */
    closeSearch(): void {
      this.searching = false
      if (this.query) this.$emit('update:query', '')
    },
    dayLabel(day: number): string {
      if (day === startOfDay(new Date()) - DAY_MS) return this.$t('radio.titleLogYesterday')
      return new Date(day).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
      })
    },
    /** artist/track, or null for a title that isn't shaped like a song at
     * all — a programme name, a news item, the station's own jingle text.
     *
     * Deliberately only a *display* distinction, never a filter: a station
     * sends all of those through the very same field a song comes through,
     * and one of them ("Deutschlandfunk - Alles von Relevanz", sampled
     * live) carries the exact separator a song does. There is no rule that
     * keeps every song without also keeping headlines, so everything is
     * shown and only the presentation differs. */
    split(title: string): { artist: string; track: string } | null {
      const at = title.indexOf(SEPARATOR)
      if (at <= 0) return null
      const artist = title.slice(0, at).trim()
      const track = title.slice(at + SEPARATOR.length).trim()
      return artist && track ? { artist, track } : null
    },
    /** Looks the track up in the user's own library — on each layout, the
     * screen that layout actually uses for that. The desktop search page
     * does render inside the mobile shell, which is how a tap on the phone
     * used to land on a view built for a window; the phone has its own
     * library screen (MobileLibraryView.vue) and that is where a search
     * belongs there.
     *
     * The track title alone, deliberately, not "artist track": an ICY
     * artist field routinely carries things a library never matches on
     * ("WizTheMc, bees & honey", "X feat. Y"), and a combined query that
     * misses returns an empty page, which reads as "you don't have it".
     * The looser query returns the song plus some neighbours, which is the
     * far better way to be wrong — and the artist is right there in the
     * row to pick by. */
    search(track: string): void {
      this.$router.push({
        name: isMobileWebNow() ? 'm-library' : 'search',
        query: { q: track },
      })
    },
    formatTime(at: number): string {
      return new Date(at * 1000).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    },
  },
}
</script>

<style scoped>
/* Fills whatever box it is put in; .title-log__scroll inside does the
 * scrolling. `overflow-y: auto` on the root alone did nothing in either
 * place this is used, for two different reasons. NowPlayingView's
 * .now-playing__lyrics is a fixed 85cqh with `overflow: hidden` and lands
 * on this very element, so it both fixed the height and clipped what the
 * root would have scrolled — a thousand-entry log showed one screenful and
 * no way to reach the rest. In the drawer it is a flex child, whose
 * default `min-height: auto` refuses to shrink below its content, so the
 * box never gets smaller than what is in it and `auto` never has anything
 * to scroll. */
.title-log {
  display: flex;
  flex-direction: column;
  /* Measured against this box, not the window: the same component sits in
   * a 380px drawer and in Now Playing's much wider half, and only its own
   * width decides which of the two it has to fit. */
  container-type: inline-size;
}

/* The head sits above the scroller rather than inside it, so it stays put
 * while the log runs under it. `flex-shrink: 0` for the same reason the
 * lyrics panel's own toolbar has it: the scroller below is the flexible
 * part, and without this a long log squeezes the chrome instead of
 * scrolling.
 *
 * The horizontal padding matches .title-log__list's own left inset (10px)
 * plus the timeline gutter, so the magnifier lines up over the column of
 * times rather than floating between the two. No bottom padding: the
 * scroller's mask fades the first rows in right under it, and a gap there
 * would read as the head being detached from the list it belongs to. */
/* One cell, two states stacked in it: the field arrives over the heading
 * rather than beside it, and neither can push the other sideways on the
 * way past. Both children are placed in the same grid area below. */
.title-log__head {
  display: grid;
  flex-shrink: 0;
  grid-template-columns: 1fr;
  align-items: center;
  min-height: 38px;
  padding: 2px 8px 0 10px;
}

.title-log__head > * {
  grid-area: 1 / 1;
  min-width: 0;
}

.title-log__head-idle {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* The same fall from above a new title gets, and the same 0.3s — see the
 * transition-group's entrance further down, which this deliberately
 * mirrors. Only entering: on the way out the row is being replaced by the
 * other state (mode="out-in"), and a leave animation there would hold an
 * empty row open before the replacement drops in. */
.title-log-search-enter-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.title-log-search-enter-from {
  opacity: 0;
  transform: translateY(-14px);
}

@media (prefers-reduced-motion: reduce) {
  .title-log-search-enter-active {
    transition: none;
  }
}

/* .panel-title brings its own trailing hairline and a 10px bottom margin,
 * which is right between two groups of fields in a dialog and wrong here,
 * where the head is one row of a panel that is already tight for height. */
.title-log__head-title {
  flex: 1 1 auto;
  margin-bottom: 0;
}

/* Fills the row the heading gives up, so the field is as wide as the log
 * is rather than a box floating in the corner. */
.title-log__search-field {
  flex: 1 1 auto;
}

/* Vuetify's own `solo-filled` fill is built to stand out from a page; on
 * the blurred artwork it reads as a slab of grey. Toned down to the same
 * faint white the panel's own surfaces use, and rounded to the 8px step
 * the style guide keeps for a small element inside a surface. :deep(),
 * since this is the field's inner control. */
.title-log__search-field :deep(.v-field) {
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}

/* 16px is a floor, not a taste: a phone browser zooms the page in when a
 * focused input's text is smaller than that, and it does not zoom back out
 * when the field is closed again — the log is then left oversized until the
 * reader pinches it back themselves. The rest of this panel is smaller than
 * 16px and stays that way; only the control that takes focus has to clear
 * the bar. */
.title-log__search-field :deep(input) {
  font-size: 16px;
}

.title-log__search-field :deep(.v-field:hover) {
  background: rgba(255, 255, 255, 0.09);
}

/* No min-height: 0 needed on this one, unusually: a flex item whose own
 * overflow is not `visible` already has an automatic minimum size of zero,
 * which is exactly what makes it shrink and scroll. Left off rather than
 * added defensively — measured both ways in the layout test next door. */
.title-log__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  /* The log runs off both ends of its box, and a hard cut there reads as
   * the last row having been sliced in half rather than as more of them
   * being up or down there. Faded out instead, the same way
   * LyricsPanel.vue's scroller does it and for the same reason: an alpha
   * mask rather than a gradient overlay, because this component sits both
   * on the drawer's solid surface and on Now Playing's blurred artwork,
   * and only a mask is indifferent to what is behind it.
   *
   * A pixel depth, not the percentage lyrics use: what has to disappear
   * gently here is a card of a known height (roughly 46px), not a line of
   * text in a box whose height is the whole point. A percentage would fade
   * a third of a short drawer and a single row of a tall one.
   *
   * What keeps the two ends of the log out of that zone is a matching
   * inset of the same depth — content that comes to rest inside the fade
   * renders permanently half-transparent, and the newest entry, the one
   * this log is usually opened for, is exactly the one sitting there.
   * That inset lives on the *contents* (.title-log__list and the empty
   * line) rather than as padding here, because Blink drops a scroll
   * container's own bottom padding once its content overflows: the top
   * end came out right and the last row still ended flush against the
   * bottom edge. Padding on a child is ordinary content and counts.
   * Both ends are pinned by RadioTitleLog.layout.browser.test.ts. */
  --title-log-fade: 24px;
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black var(--title-log-fade),
    black calc(100% - var(--title-log-fade)),
    transparent 100%
  );
}

/* Vuetify's own timeline padding is built for cards on a page, not for a
 * 380px drawer: the row gap alone is more than one of these rows is tall.
 * Pulled in to what a log wants, in one place rather than per element.
 * :deep(), because everything under this is another component's markup. */
.title-log__list {
  /* The left inset is the line's own margin from the panel edge. Neither
   * caller brings one (the drawer slot and NowPlayingView's own class both
   * only size the box), and without it the dots sit against the drawer's
   * border as if they had been cut off by it. Top and bottom are the
   * scroller's fade depth: this is where the first and last entry come to
   * rest, and they have to come to rest below the mask, not inside it. */
  padding: var(--title-log-fade) 12px var(--title-log-fade) 10px;
  /* Vuetify pins a vertical timeline to `height: 100%` — the height of the
   * scrollport here, which a log of any length runs straight out of. Its
   * rows then render outside its own box, and everything the box carries
   * at its bottom edge (the fade inset above) sits in the middle of the
   * content instead of after it: the last entry ended flush against the
   * scroller's bottom, inside the mask. Sized to its rows instead. An
   * unlayered rule is all it takes — Vuetify ships its CSS in a cascade
   * layer, which loses to this however specific it is. */
  height: auto;
  --v-timeline-line-inset: 0px;
  /* Vuetify spaces its rows 24px apart (its own $timeline-item-padding),
   * which is right for a handful of milestones and wrong for a log that
   * runs to hundreds: it costs roughly a third of every screenful. Set on
   * the grid itself, since that is where the row gap lives. */
  row-gap: 10px;
}

/* Vuetify justifies the body to the start of its column, which sizes it to
 * its own content — with a card per entry that reads as a ragged right
 * edge down the whole log. Stretched instead, so every card ends on the
 * same line. */
.title-log__list :deep(.v-timeline-item__body) {
  justify-self: stretch;
  width: 100%;
  padding-inline-start: 12px;
  padding-block: 0;
  min-width: 0;
}

/* Vuetify does not take the dot's size from CSS: VTimelineItem measures
 * the rendered dot once, on mount, and writes the result into
 * --v-timeline-dot-size as an inline style — which every line segment then
 * positions itself from (`dot-size / 2`). This log mounts inside a
 * navigation drawer that starts closed, where a hidden element measures
 * zero, so the line was drawn for a 0px dot: a stripe down the far left,
 * beside the dots rather than through them, next to the one the segments
 * of the following rows drew. Two lines, and neither meeting a dot.
 *
 * Stated here instead, and `!important` because an inline style is what it
 * has to beat. The dot is then sized from the same value, so the two can
 * no longer disagree whatever the drawer was doing at mount.
 *
 * The border is what makes Vuetify's dot a ring around a smaller coloured
 * centre; at this size that would leave a speck, so the ring goes and the
 * dot is the colour. */
.title-log__list :deep(.v-timeline-item) {
  --v-timeline-dot-size: 26px !important;
  --v-timeline-dot-border-size: 0px;
}

/* The newest entry's dot, a size up. Keyed off the `fill-dot` Vuetify
 * itself puts on that divider — which comes from LogRow.newest, the same
 * flag the row body reads — rather than off :first-child, which stops
 * meaning "the newest entry" the moment a date heading takes the first
 * <li> slot above it. The item is what carries the size variable, hence
 * :has(); the two rules below select the divider directly. */
.title-log__list :deep(.v-timeline-item:has(.v-timeline-divider--fill-dot)) {
  --v-timeline-dot-size: 30px !important;
}

.title-log__list :deep(.v-timeline-divider__dot) {
  height: var(--v-timeline-dot-size);
  width: var(--v-timeline-dot-size);
}

/* Amber rather than the cool secondary, and dimmed by mixing it into the
 * page rather than by an alpha: the app tints its rows with a translucent
 * amber (--beacon-hover), but a *translucent dot* lets the line show
 * straight through itself, which is exactly what it is there to hide.
 * Vuetify runs each line segment to the divider's vertical centre, which
 * is the dot's centre, not its edge - measured in the browser, the line
 * carries on 13px underneath a 26px dot. Mixed, it is the same dark amber
 * and stays opaque. The immersive rules further down change the hue for
 * the same reason they keep the opacity: this half is not a preference. */
.title-log__list :deep(.v-timeline-divider__inner-dot) {
  height: 100%;
  width: 100%;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 45%, rgb(var(--v-theme-background)));
}

/* The one dot that is meant to catch the eye keeps the full signal amber
 * — see docs/styleguide.md: amber marks one thing, it does not decorate a
 * whole column of them. */
.title-log__list :deep(.v-timeline-divider--fill-dot .v-timeline-divider__inner-dot) {
  background: rgb(var(--v-theme-primary));
}

/* An icon has to fit a dot built for none: Vuetify sizes it off its own
 * default dot, which is twice this. */
.title-log__list :deep(.v-timeline-divider__dot .v-icon) {
  font-size: 15px;
  height: 15px;
  width: 15px;
}

.title-log__list :deep(.v-timeline-divider--fill-dot .v-timeline-divider__dot .v-icon) {
  font-size: 17px;
  height: 17px;
  width: 17px;
}

/* Vuetify's default gap is built for cards; these are titles, dozens of
 * them, read as a column. Small enough to keep a screenful worth reading,
 * large enough that two rows never look like one four-line entry.
 *
 * The colour is not cosmetic. Each segment is drawn `item-padding / 2`
 * (12px) past its own row into the gap, which is Vuetify's own arithmetic
 * for its 24px row gap; against the 10px gap this log uses, the segment
 * coming down from one row and the one going up from the next overlap by
 * 14px. Vuetify draws them in a translucent border colour, so that
 * overlap was a visibly brighter stretch in the middle of every gap - the
 * line looking as though it had been drawn twice, which is exactly what
 * was happening. An opaque colour renders the overlap identically to the
 * rest, and this is the app's own amber hairline rather than Vuetify's
 * grey. */
.title-log__list :deep(.v-timeline-divider__after),
.title-log__list :deep(.v-timeline-divider__before) {
  min-height: 4px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, rgb(var(--v-theme-background)));
}

/* Now Playing does not give this log a panel to sit on: it goes straight
 * onto the blurred artwork, under a scrim tinted with the colour pulled
 * out of the station's own logo (NowPlayingView's ambientStyle). Two
 * things break there at once. The line and the ordinary dots above are
 * *mixed into* --v-theme-background, a flat dark that is simply not what
 * is behind them any more, so they read as dark smudges over a picture
 * rather than as a hairline and its dots. And a warm logo tints that whole
 * wash amber, which is the one colour the timeline was built out of - the
 * line disappeared into the room it was drawn in, and the dot marking what
 * plays now stopped being a mark because everything around it was already
 * amber.
 *
 * So the hue goes neutral here and the amber is spent on the one dot it is
 * meant to mark (docs/styleguide.md: amber marks one thing). Only the hue:
 * these stay *opaque*, mixed the same way, a couple of steps brighter
 * because the ground they sit on is a picture rather than a flat panel.
 * Alpha is not available to this component whatever it is drawn on, and
 * the first attempt at these rules used it and broke both of the things
 * the mixes above exist for - a translucent dot shows the line running
 * underneath it, and two translucent segments overlap by 14px in every row
 * gap (Vuetify's own arithmetic against this log's tighter row-gap) and
 * add up into a brighter stretch there. Both were measured in the browser
 * and both are pinned by the tests, for this variant as well as the other.
 *
 * The cards are deliberately left alone - opaque, with their own hairline.
 * They are the readable surface this log is for, and the collision was
 * never theirs. */
.title-log--immersive :deep(.v-timeline-divider__after),
.title-log--immersive :deep(.v-timeline-divider__before) {
  background: color-mix(in srgb, #fff 30%, rgb(var(--v-theme-background)));
}

.title-log--immersive :deep(.v-timeline-divider__inner-dot) {
  background: color-mix(in srgb, #fff 52%, rgb(var(--v-theme-background)));
}

/* Restated rather than left to win on specificity: the rule above is one
 * class shorter than the base amber rule for this dot, so the amber would
 * survive here by an accident of counting. What is meant is that this dot
 * keeps its amber on both grounds, and it should say so. */
.title-log--immersive :deep(.v-timeline-divider--fill-dot .v-timeline-divider__inner-dot) {
  background: rgb(var(--v-theme-primary));
}

/* A gap in the line where nobody was listening — see
 * LISTENING_BREAK_SECONDS. The line stops at the entry above and starts
 * again at this one, which is what a pause in an evening looks like.
 *
 * On the two children rather than on the item that carries the class:
 * `.v-timeline-item` is `display: contents`, so it generates no box at all
 * and a margin on it is silently ignored — the divider and the body are
 * the real grid items, and both have to move for the row to move. */
.title-log__list :deep(.title-log__break .v-timeline-divider),
.title-log__list :deep(.title-log__break .v-timeline-item__body) {
  margin-top: 22px;
}

/* The entrance a newly played title gets.
 *
 * Handed down to the row's two children rather than set on the row itself,
 * because the row cannot be animated at all: Vuetify gives
 * .v-timeline-item `display: contents`, and an element with that generates
 * no box - opacity and transform on it do nothing, and its
 * getBoundingClientRect() is all zeros. That last part is also why there is
 * no move transition here, however much this list would like one:
 * TransitionGroup's FLIP measures exactly that rectangle, reads no
 * movement, and never applies a move class. So the rows below take their
 * new position at once and only the arriving one is animated. Getting them
 * to slide would mean giving the items real boxes, which means rebuilding
 * the timeline's own two-column layout by hand - far more than this is
 * worth.
 *
 * 0.3s is the app's "something arrived" speed, shared with the queue's own
 * rows (docs/styleguide.md's motion table); ENTER_MS in the script says the
 * same number to Vue. Downwards, from behind the panel's top edge, because
 * that is where the entry comes from: the newest is the topmost, and the
 * fade mask above is what it emerges out of. */
.title-log-enter-active :deep(.v-timeline-divider),
.title-log-enter-active :deep(.v-timeline-item__body) {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.title-log-enter-from :deep(.v-timeline-divider),
.title-log-enter-from :deep(.v-timeline-item__body) {
  opacity: 0;
  transform: translateY(-14px);
}

/* Someone who has asked for less movement gets the new row, just not the
 * journey - the same answer every other animation in this app gives
 * (docs/styleguide.md). */
@media (prefers-reduced-motion: reduce) {
  .title-log-enter-active :deep(.v-timeline-divider),
  .title-log-enter-active :deep(.v-timeline-item__body) {
    transition: none;
  }
}

/* Not an event on the line but a break in it — see the template. Sits
 * where a dot would be, without one, so the heading starts at the same
 * left edge as the rows it introduces. */
.title-log__day {
  display: block;
  padding: 10px 0 2px;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.55;
}

/* A card per entry, matching the station cards in the Discover dialog
 * next door (same 12px radius, hairline and 2% fill) rather than a second
 * shape for the same kind of thing. `align-items: baseline` so the clock
 * sits on the title's own baseline, not on the top edge of a two-line
 * card. */
.title-log__item {
  display: flex;
  /* Centred, not on the title's baseline: the clock reads as belonging to
   * the whole card, and a two-line entry left it clinging to the top. */
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  /* The card is a <button> for a song row (see the template), so it has a
   * browser default look to undo. Width and text-align are what a button
   * otherwise gets wrong inside a stretched grid cell. */
  width: 100%;
  text-align: start;
  font: inherit;
  color: inherit;
  appearance: none;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  /* Opaque, unlike the 2% white fill a panel elsewhere in the app carries:
   * the timeline's line runs behind these cards, and a translucent one
   * shows it straight through the middle of every entry. `surface` is what
   * docs/styleguide.md names for a card. */
  background: rgb(var(--v-theme-surface));
}

/* What is playing now carries the amber the dot beside it does, so the two
 * read as one mark rather than as a coloured dot next to a plain card. */
.title-log__item--searchable {
  cursor: pointer;
}

/* The whole card lights up rather than the title underlining itself: the
 * card is the target now, and an underline mid-row reads as a link inside
 * it rather than as the row being live. Mixed, not laid over with an
 * alpha, for the same reason as the card's own fill - the timeline's line
 * runs behind it. */
.title-log__item--searchable:hover,
.title-log__item--searchable:focus-visible {
  border-color: rgba(var(--v-theme-primary), 0.3);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, rgb(var(--v-theme-surface)));
}

.title-log__item--now.title-log__item--searchable:hover,
.title-log__item--now.title-log__item--searchable:focus-visible {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
}

.title-log__item--now {
  border-color: rgba(var(--v-theme-primary), 0.35);
  /* Mixed rather than layered for the same reason as the card above: an
   * amber laid over the surface with an alpha would be a window onto the
   * line behind it. */
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 7%, rgb(var(--v-theme-surface)));
}

/* The newest entry is what is playing right now — worth telling apart from
 * the log below it without a separate "now playing" heading eating a row.
 * Flagged in the data (see LogRow.newest) rather than selected by position,
 * since a date heading can sit above it. */
.title-log__item--now .title-log__track {
  color: rgb(var(--v-theme-primary));
}

.title-log__time {
  flex: 0 0 auto;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.title-log__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  text-align: start;
}

.title-log__track {
  font-size: 0.875rem;
  line-height: 1.3;
}

.title-log__artist {
  font-size: 0.8125rem;
  line-height: 1.3;
  opacity: 0.7;
}

/* Not a song: one line, no artist/track split to imply a structure the
 * text does not have. */
.title-log__plain {
  font-size: 0.8125rem;
  line-height: 1.35;
  opacity: 0.85;
}

.title-log__empty {
  margin: 0;
  /* The same inset the list carries, for the same reason: this line sits
   * at the top of the box, which is where the mask is still fading in. */
  padding: var(--title-log-fade) 16px 12px;
  font-size: 0.875rem;
  opacity: 0.6;
}

/* The drawer, at 380px. Everything gives up a couple of pixels rather than
 * one thing giving up many: the gap between cards, their own padding, the
 * timeline gutter and the space either side of the clock. Below this the
 * two-line card is what has to keep working, and it is what the rest is
 * spent on. */
@container (max-width: 420px) {
  /* The right side gives up its pixels here, not the left: the inset that
   * keeps the dots off the panel edge is exactly what a narrow drawer
   * needs most. */
  .title-log__list {
    padding-right: 8px;
    row-gap: 6px;
  }

  .title-log__list :deep(.v-timeline-item__body) {
    padding-inline-start: 9px;
  }

  .title-log__item {
    gap: 8px;
    padding: 6px 8px;
  }

  .title-log__day {
    padding: 8px 0 0;
  }
}
</style>
