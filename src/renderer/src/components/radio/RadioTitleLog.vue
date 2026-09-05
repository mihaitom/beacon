<template>
  <div class="title-log">
    <!-- The scrolling happens one level in, not on the root. Both callers
       - put their own class on the root (NowPlayingView's
       - .now-playing__lyrics, the drawer's own slot rule), and that class
       - owns the root's height and overflow — the same arrangement
       - LyricsPanel.vue has for the same reason. A root that tried to be
       - the scroller too would be fighting whichever stylesheet loaded
       - last for both properties. -->
    <div class="title-log__scroll">
      <ol v-if="entries.length" class="title-log__list">
        <template v-for="row in rows" :key="row.key">
          <li v-if="row.divider" class="title-log__day">{{ row.divider }}</li>
          <li v-else class="title-log__item" :class="{ 'title-log__item--now': row.newest }">
            <span class="title-log__time">{{ formatTime(row.entry!.at) }}</span>
            <!-- Only a row that reads as a song is worth searching for:
             - handing a news headline to the library search returns nothing
             - and invites the click anyway. -->
            <button
              v-if="split(row.entry!.title)"
              type="button"
              class="title-log__text title-log__text--searchable"
              :title="$t('radio.titleLogSearch')"
              @click="search(split(row.entry!.title)!.track)"
            >
              <span class="title-log__track">{{ split(row.entry!.title)!.track }}</span>
              <span class="title-log__artist">{{ split(row.entry!.title)!.artist }}</span>
            </button>
            <span v-else class="title-log__text">
              <span class="title-log__plain">{{ row.entry!.title }}</span>
            </span>
          </li>
        </template>
      </ol>
      <p v-else class="title-log__empty">{{ $t('radio.titleLogEmpty') }}</p>
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
  /** The newest entry, i.e. what is playing right now. Marked here rather
   * than left to a positional CSS selector: a date heading is a sibling
   * <li>, so neither :first-child nor :first-of-type (which counts by tag,
   * not by class) still picks out the first *entry* once one appears above
   * it — caught by RadioTitleLog.layout.browser.test.ts. */
  newest?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

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
  },
  computed: {
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
      let seenEntry = false
      for (const entry of this.entries) {
        const day = startOfDay(new Date(entry.at * 1000))
        if (day !== lastDay) {
          if (day !== today) out.push({ key: `day-${day}`, divider: this.dayLabel(day) })
          lastDay = day
        }
        out.push({ key: `${entry.at}-${entry.title}`, entry, newest: !seenEntry })
        seenEntry = true
      }
      return out
    },
  },
  methods: {
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
}

/* No min-height: 0 needed on this one, unusually: a flex item whose own
 * overflow is not `visible` already has an automatic minimum size of zero,
 * which is exactly what makes it shrink and scroll. Left off rather than
 * added defensively — measured both ways in the layout test next door. */
.title-log__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0;
}

.title-log__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Sticks to the row it labels rather than floating: the heading only ever
 * appears where a day actually changed, so it has to read as a break in the
 * list, not as another entry. */
.title-log__day {
  padding: 12px 16px 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.55;
}

.title-log__item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 8px 16px;
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

/* A button, so it is reachable by keyboard and reads as an action - but
 * stripped back to the plain row it sits in rather than looking like one. */
.title-log__text--searchable {
  appearance: none;
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.title-log__text--searchable:hover .title-log__track,
.title-log__text--searchable:focus-visible .title-log__track {
  text-decoration: underline;
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
  padding: 12px 16px;
  font-size: 0.875rem;
  opacity: 0.6;
}
</style>
