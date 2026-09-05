<template>
  <!-- Cards read better in a column than stretched across a very wide
   - dialog, so this is narrower than the table it replaced. Fullscreen on
   - a phone: a centred dialog with margins would leave the list barely
   - taller than its own search row. -->
  <v-dialog v-model="open" max-width="820" :fullscreen="compact" scrollable>
    <v-card :class="compact ? 'discover-card-shell--mobile' : 'beacon-dialog'">
      <!-- Fullscreen on a phone puts the title where an app bar goes, so
       - it carries the close button too; the bottom Close stays for the
       - windowed desktop dialog, where a lone X in a corner reads as
       - stray chrome. -->
      <v-card-title class="discover-title">
        <span>{{ $t('radio.discoverTitle') }}</span>
        <v-btn
          v-if="compact"
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :title="$t('common.close')"
          @click="open = false"
        />
      </v-card-title>
      <v-card-text>
        <div class="discover-filters" :class="{ 'discover-filters--compact': compact }">
          <v-text-field
            v-model="browseQuery"
            :label="$t('radio.discoverSearchLabel')"
            :placeholder="$t('radio.discoverSearchPlaceholder')"
            variant="solo-filled"
            clearable
            autofocus
            hide-details
            prepend-inner-icon="mdi-magnify"
            class="discover-filters__search"
          />
          <!-- v-autocomplete, not v-select — Radio Browser's own country
           - list runs to roughly 250 entries (every country it has even
           - one station for), which is a lot to scroll through to find
           - one; this adds the type-to-filter box a plain v-select has
           - no room for. Single-select: multi-select here didn't earn
           - its own complexity — one country already narrows the list
           - down enough, and the chip row it needed just ate the space
           - the search box next to it wants. -->
          <v-autocomplete
            v-model="browseCountry"
            :items="countryOptions"
            item-title="name"
            item-value="code"
            :label="$t('radio.discoverCountryLabel')"
            :placeholder="$t('radio.discoverAnyCountry')"
            variant="solo-filled"
            hide-details
            clearable
            class="discover-filters__country"
          />
        </div>
        <segmented-control
          :model-value="browseOrder"
          :options="browseOrderOptions"
          :label="$t('radio.discoverTitle')"
          class="discover-order"
          @update:model-value="browseOrder = $event as 'clickcount' | 'votes'"
        />
        <v-progress-linear v-if="browseLoading" indeterminate class="discover-status" />
        <v-alert
          v-else-if="browseError"
          type="error"
          variant="tonal"
          density="compact"
          class="discover-status"
        >
          {{ $t('radio.discoverSearchFailed') }}
        </v-alert>
        <v-alert
          v-else-if="browseHasNoResults"
          type="info"
          variant="tonal"
          density="compact"
          class="discover-status"
        >
          {{
            browseQuery.trim()
              ? $t('radio.discoverNoResults', { query: browseQuery.trim() })
              : $t('radio.discoverNoResultsFiltered')
          }}
        </v-alert>
        <!-- A list of result cards rather than a data table. The table
         - carried more per-station data than a subtitle line could
         - (location, language, codec, popularity, health) but only ever
         - fitted a wide window, which is why this dialog was switched
         - off on phones entirely. The same facts read fine as one card
         - per station, at any width, with an icon standing in for each
         - column heading that no longer exists.
         -
         - Plain, not virtual: Radio Browser is asked for 30 results (see
         - searchRadioBrowser's own default), which is nothing to render
         - at once — the virtual table was solving a problem this list
         - does not have. -->
        <div v-if="browseResults.length" class="discover-results">
          <article
            v-for="item in browseResults"
            :key="item.stationuuid"
            class="discover-card"
            :class="{ 'discover-card--compact': compact }"
          >
            <!-- Play lives on the logo rather than in a button of its
             - own: the logo is what the eye goes to first, and one
             - target that means "this station, playing" beats two, the
             - same way a track row's cover art behaves elsewhere. -->
            <div
              class="discover-card__art"
              role="button"
              tabindex="0"
              :title="$t('radio.discoverPlay')"
              :aria-label="$t('radio.discoverPlay')"
              @click="playBrowsedStation(item)"
              @keydown.enter.prevent="playBrowsedStation(item)"
              @keydown.space.prevent="playBrowsedStation(item)"
            >
              <cover-art
                :radio-favicon="
                  item.homepage || item.favicon
                    ? faviconRequest(item.homepage, 48, item.favicon)
                    : null
                "
                :size="48"
                rounded
                fallback-icon="mdi-radio"
              />
              <div class="discover-card__play">
                <v-icon icon="mdi-play" size="22" color="white" />
              </div>
            </div>

            <div class="discover-card__body">
              <div class="discover-card__name-row">
                <a
                  v-if="item.homepage"
                  :href="item.homepage"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="discover-card__name discover-card__name--link"
                  :title="item.name"
                  >{{ item.name }}</a
                >
                <span v-else class="discover-card__name" :title="item.name">{{ item.name }}</span>
                <v-icon
                  :icon="item.lastcheckok ? 'mdi-circle' : 'mdi-circle-outline'"
                  :color="item.lastcheckok ? 'success' : undefined"
                  size="8"
                  class="discover-card__health"
                  :title="
                    item.lastcheckok ? $t('radio.discoverStreamOk') : $t('radio.discoverStreamDown')
                  "
                />
              </div>
              <!-- Whatever Radio Browser actually knows about this
               - station; a submitter is free to leave any of it blank,
               - and an empty separator between two missing facts reads
               - worse than a shorter line. -->
              <p v-if="metaFor(item)" class="discover-card__meta">{{ metaFor(item) }}</p>
            </div>

            <!-- The two numbers the sort toggle above orders by. The
             - icons are what the column headings used to say, so the
             - figures still mean something without them. -->
            <div class="discover-card__stats">
              <span class="discover-card__stat" :title="$t('radio.discoverColumnVotes')">
                <v-icon icon="mdi-thumb-up-outline" size="13" />
                {{ item.votes.toLocaleString() }}
              </span>
              <span class="discover-card__stat" :title="$t('radio.discoverColumnClicks')">
                <v-icon icon="mdi-play-circle-outline" size="13" />
                {{ item.clickcount.toLocaleString() }}
                <span
                  v-if="item.clicktrend"
                  :class="item.clicktrend > 0 ? 'text-success' : 'text-error'"
                  >({{ item.clicktrend > 0 ? '+' : '' }}{{ item.clicktrend }})</span
                >
              </span>
            </div>

            <v-btn
              v-if="addedStationuuids.has(item.stationuuid)"
              icon="mdi-check"
              variant="text"
              size="small"
              class="discover-card__add"
              disabled
            />
            <v-btn
              v-else
              icon="mdi-plus"
              variant="text"
              size="small"
              class="discover-card__add"
              :title="$t('radio.addStation')"
              :loading="addingStationuuids.has(item.stationuuid)"
              :disabled="addingStationuuids.has(item.stationuuid)"
              @click="addBrowsedStation(item)"
            />
          </article>
        </div>
      </v-card-text>
      <v-card-actions>
        <a
          :href="radioBrowserHomepage"
          target="_blank"
          rel="noopener noreferrer"
          class="discover-credit"
          >{{ $t('radio.discoverCredit') }}</a
        >
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
// The "Discover stations" dialog, shared by the desktop Radio page and the
// phone's own (views/RadioView.vue and views/mobile/MobileRadioView.vue).
// It is the one part of Radio the two genuinely have in common: a search
// against the Radio Browser directory, a country filter, a sort toggle and
// a list of result cards, all of which read the same on either. Everything
// around it — how saved stations are listed, how one is added by hand,
// what the header looks like — is what each page does its own way, which
// is why those pages are separate and this is not.
//
// Owns its own search state rather than taking it as props: a query, a
// pending request and which results have already been added are this
// dialog's business from opening to closing, and no page has anything to
// say about them.
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { rememberRadioBrowserStation } from '@/services/radioBrowserLinks'
import {
  listRadioBrowserCountries,
  searchRadioBrowser,
  type RadioBrowserFilterOption,
  type RadioBrowserStation,
} from '@/services/connect/radioBrowser'
import { accountScopedKey } from '@/services/accountKey'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'

// Same account+device scoping as services/streamQuality.ts's own settings —
// this is exactly that kind of device-local preference, so a second
// account on the same computer gets its own independent selection rather
// than silently inheriting whichever country the first one picked.
const BROWSE_COUNTRY_STORAGE_KEY = 'beacon.radioDiscoverCountry'

function loadSavedBrowseCountry(): string {
  try {
    const raw = localStorage.getItem(accountScopedKey(BROWSE_COUNTRY_STORAGE_KEY))
    const parsed: unknown = raw ? JSON.parse(raw) : ''
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    // Unreadable/corrupt storage - starting from "no filter" is never wrong,
    // just possibly not what was picked last time.
    return ''
  }
}

function saveBrowseCountry(code: string | null): void {
  try {
    // The autocomplete's own clear button sets the model to null rather
    // than '' (Vuetify's single-select convention) — normalized to '' here
    // so a stored value is always a plain string, matching what
    // loadSavedBrowseCountry() above hands back.
    localStorage.setItem(accountScopedKey(BROWSE_COUNTRY_STORAGE_KEY), JSON.stringify(code ?? ''))
  } catch {
    // Storage full/unavailable — the selection still applies for this
    // session, it just won't be remembered next time. Not worth a dialog.
  }
}

// Debounces browseQuery below — module-level like SongsView.vue's own
// debounceTimer, since a component instance only ever has one search box
// live at a time and this avoids a stray timer surviving past the
// component that armed it (see that file's identical reasoning). The
// country/order controls below don't need debouncing — a single discrete
// pick, unlike a burst of keystrokes — but still clear this on their own
// change, so a still-pending text search never overwrites a filter change
// that came right after it.
let browseDebounceTimer: ReturnType<typeof setTimeout> | undefined

// Credited in this dialog's own footer — Radio Browser is what the whole
// feature is built on top of, not something to leave unattributed.
const RADIO_BROWSER_HOMEPAGE = 'https://www.radio-browser.info/'

// Which ranking the dialog opens with. Plays, not votes: a vote is a thing
// somebody had to go and cast, so the vote ranking rewards whoever has been
// in the directory longest and had a community around them, while the play
// count is simply what people actually listened to - the more honest answer
// to "what is popular here". Both orderings stay one tap apart, and Beacon
// contributes to this one itself: it reports a listen back to the directory
// every time you play a station you found through it.
const DEFAULT_BROWSE_ORDER: 'votes' | 'clickcount' = 'clickcount'

export default {
  name: 'RadioDiscoverDialog',
  components: { CoverArt, SegmentedControl },
  props: {
    modelValue: { type: Boolean, default: false },
    /** Rendered inside the phone shell — fullscreen, with the close button
     * in the title where an app bar would be, and cards laid out in two
     * rows instead of one. Passed by whichever page is showing this rather
     * than measured here: a narrow desktop window is a narrow desktop
     * window, the same as everywhere else in the app. */
    compact: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      browseQuery: '',
      // Loaded once here, not reset on open — see this component's own
      // saveBrowseCountry()/loadSavedBrowseCountry() for why this one
      // filter persists across dialog opens (and app restarts) while the
      // query text and order toggle deliberately start fresh each time.
      browseCountry: loadSavedBrowseCountry() as string | null,
      browseOrder: DEFAULT_BROWSE_ORDER as 'votes' | 'clickcount',
      browseResults: [] as RadioBrowserStation[],
      browseLoading: false,
      browseError: false,
      // Populated once and kept for this component's whole lifetime —
      // which countries exist in the directory doesn't change between one
      // dialog open and the next.
      countryOptions: [] as RadioBrowserFilterOption[],
      // Which of this dialog's own results have already been added, purely
      // for the add button to turn into a checkmark — reset each time the
      // dialog opens, not cross-referenced against
      // libraryStore.radioStations (Radio Browser results carry no id that
      // overlaps a saved station's).
      addedStationuuids: new Set<string>(),
      // Which results have a saveRadioStation() call in flight right now —
      // see addBrowsedStation()'s own comment on why the add button needs
      // this on top of addedStationuuids.
      addingStationuuids: new Set<string>(),
      // Guards a slow search response landing after a newer query already
      // superseded it — a counter rather than an id, since queries aren't
      // unique.
      browseSeq: 0,
      // Set for the span of the reset-to-defaults below — see the
      // browseQuery/browseOrder watchers' own checks.
      suppressBrowseReset: false,
    }
  },
  computed: {
    open: {
      get(): boolean {
        return this.modelValue
      },
      set(value: boolean) {
        this.$emit('update:modelValue', value)
      },
    },
    // Most played first, because it is what the dialog opens on
    // (DEFAULT_BROWSE_ORDER) - a segmented control whose lit half is the
    // second one reads as "something was changed here" rather than as the
    // starting point.
    browseOrderOptions() {
      return [
        { title: this.$t('radio.discoverMostPlayed'), value: 'clickcount' },
        { title: this.$t('radio.discoverTopVoted'), value: 'votes' },
      ]
    },
    libraryStore() {
      return useLibraryStore()
    },
    browseHasNoResults(): boolean {
      return !this.browseLoading && !this.browseError && this.browseResults.length === 0
    },
    radioBrowserHomepage(): string {
      return RADIO_BROWSER_HOMEPAGE
    },
  },
  watch: {
    // immediate, so being mounted already open works the same as being
    // opened afterwards. Both pages start it closed and flip it, but a
    // component that only works when toggled is a trap for the next caller
    // — and for a test that renders it open.
    modelValue: {
      immediate: true,
      handler(opened: boolean) {
        if (opened) this.onOpened()
      },
    },
    browseQuery() {
      if (this.suppressBrowseReset) return
      clearTimeout(browseDebounceTimer)
      browseDebounceTimer = setTimeout(() => this.runBrowseSearch(), 400)
    },
    browseCountry() {
      saveBrowseCountry(this.browseCountry)
      clearTimeout(browseDebounceTimer)
      void this.runBrowseSearch()
    },
    browseOrder() {
      if (this.suppressBrowseReset) return
      clearTimeout(browseDebounceTimer)
      void this.runBrowseSearch()
    },
  },
  methods: {
    onOpened() {
      clearTimeout(browseDebounceTimer)
      // Reopening after a non-default query/order left over from the last
      // visit resets both below, and each is watched — without this guard,
      // the browseOrder watcher fired its own immediate runBrowseSearch()
      // and the (debounced, but still eventually firing) browseQuery one
      // queued a second, on top of the explicit call this method already
      // makes at the end. Three redundant requests to Radio Browser's
      // third-party API for what should be exactly one.
      this.suppressBrowseReset = true
      this.browseQuery = ''
      // browseCountry is deliberately left alone — see its own data()
      // comment for why that one filter survives across dialog opens.
      this.browseOrder = DEFAULT_BROWSE_ORDER
      this.browseResults = []
      this.browseError = false
      this.addedStationuuids = new Set()
      this.loadBrowseFilterOptions()
      // Not through the debounced watcher above — opening the dialog is
      // its own deliberate action, not a keystroke to wait out, and this
      // is what shows the initial "top stations" list (empty query,
      // default filters — see searchRadioBrowser()'s own docstring for why
      // that's a real, intended call) rather than a blank dialog until the
      // person types something.
      void this.runBrowseSearch()
      void this.$nextTick(() => {
        this.suppressBrowseReset = false
      })
    },
    faviconRequest(homePageUrl: string, minSize = 0, hint = ''): RadioFaviconRequest {
      return radioFaviconRequest(homePageUrl ?? '', minSize, hint ?? '')
    },
    loadBrowseFilterOptions() {
      // Already loaded from a previous time this dialog was opened this
      // session — which countries exist doesn't change often enough to be
      // worth asking again.
      if (this.countryOptions.length === 0) {
        listRadioBrowserCountries()
          .then((countries) => {
            this.countryOptions = countries
          })
          .catch((error) => {
            console.error('[radio-discover] Failed to load Radio Browser countries:', error)
          })
      }
    },
    async runBrowseSearch() {
      this.browseLoading = true
      this.browseError = false
      const seq = ++this.browseSeq
      let results: RadioBrowserStation[] = []
      let failed = false
      try {
        results = await searchRadioBrowser({
          name: this.browseQuery.trim(),
          countrycodes: this.browseCountry ? [this.browseCountry] : [],
          order: this.browseOrder,
        })
      } catch (error) {
        console.error('[radio-discover] Radio Browser search failed:', error)
        failed = true
      }
      // A newer query already superseded this one while it was in flight —
      // its own results/error, not this stale response, are what belongs
      // on screen now.
      if (seq !== this.browseSeq) return
      this.browseResults = results
      this.browseError = failed
      this.browseLoading = false
    },
    // e.g. "Germany · Bavaria" — omits either half Radio Browser didn't
    // have for this station rather than showing an empty "·".
    locationFor(result: RadioBrowserStation): string {
      return [result.country, result.state].filter(Boolean).join(' · ')
    },
    // e.g. "MP3, 128 kbps" — bitrate is 0/null for some lossless or
    // never-checked streams, not worth appending in that case.
    codecFor(result: RadioBrowserStation): string {
      if (!result.codec) return ''
      return result.bitrate ? `${result.codec}, ${result.bitrate} kbps` : result.codec
    },
    /** The one secondary line under a station's name — what the table this
     * replaced used to spread across a location, a language and a codec
     * column. Each part is a field a submitter was free to leave blank, so
     * they are filtered before joining rather than separated by an empty
     * gap. */
    metaFor(result: RadioBrowserStation): string {
      return [this.locationFor(result), result.languagecodes.toUpperCase(), this.codecFor(result)]
        .filter(Boolean)
        .join(' · ')
    },
    async addBrowsedStation(result: RadioBrowserStation) {
      // addedStationuuids only gains this row once saveRadioStation()
      // actually resolves, so the button stays a plain (still-clickable)
      // plus icon for the whole round trip — a second click/tap before the
      // first save lands fired a second, concurrent save, creating a
      // duplicate saved station. This guard is what addingStationuuids
      // (see its own comment) exists for.
      if (this.addingStationuuids.has(result.stationuuid)) return
      this.addingStationuuids.add(result.stationuuid)
      try {
        await this.libraryStore.saveRadioStation(result.name, result.url, result.homepage)
        this.addedStationuuids.add(result.stationuuid)
        // Remembered, not reported: to Radio Browser a click means someone
        // listened, and adding a station to a list is not listening yet.
        // The link is what lets every later play of it be reported instead
        // — see services/radioBrowserLinks.ts.
        rememberRadioBrowserStation(result.url, result.stationuuid)
      } finally {
        this.addingStationuuids.delete(result.stationuuid)
      }
    },
    // A one-off listen, deliberately not going through saveRadioStation —
    // this plays the same way song radio does (see playRadioStation()'s own
    // contract), with nothing written to the saved station list unless the
    // person also hits the add button.
    playBrowsedStation(result: RadioBrowserStation) {
      // Recorded before playing, so playRadioStation() finds the link and
      // reports this listen the same way it reports one of a saved
      // station — one place doing the reporting rather than two.
      rememberRadioBrowserStation(result.url, result.stationuuid)
      void usePlaybackStore().playRadioStation({
        id: result.stationuuid,
        name: result.name,
        streamUrl: result.url,
        homePageUrl: result.homepage || null,
        favicon: result.favicon || undefined,
      })
    },
  },
}
</script>

<style scoped>
.discover-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

/* The search field gets most of the row; the country select only needs
 * enough width for a country name. Both are left at Vuetify's default
 * density on purpose — the two sit side by side in one row, and a
 * `density="compact"` on only one of them made it visibly the shorter box
 * of the pair, with its own label and value crowded together at the top
 * while the field beside it had them properly spaced. */
.discover-filters__search {
  flex: 2;
  min-width: 0;
}

.discover-filters__country {
  flex: 1;
  min-width: 0;
}

/* Side by side needs roughly 480px between them before the country name
 * stops fitting; below that they stack rather than both becoming too
 * narrow to read what is typed in them. */
/* Stacked on the phone: the filter row is a search field, a country
 * picker and a sort control, which do not sit side by side in that width. */
.discover-filters--compact {
  flex-direction: column;
}

.discover-status {
  margin-bottom: 8px;
}

.discover-order {
  margin-bottom: 12px;
}

/* The app's own chrome blue, which the phone already wears on its app bar,
 * tab bar and mini player (--beacon-chrome). A fullscreen dialog *is* the
 * screen there, so the default dialog surface read as a lighter panel
 * floating over nothing. Left alone on the desktop, where the dialog is a
 * window over the page and matches every other dialog in the app. */
.discover-card-shell--mobile {
  background: var(--beacon-chrome);
}

/* Windowed on the desktop, where the shared .beacon-dialog caps it and
 * scrolls the results inside that cap; the phone keeps the full screen,
 * where the dialog *is* the page. */

.discover-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.discover-credit {
  align-self: center;
  font-size: 0.8125rem;
  opacity: 0.7;
}

/* One row per station, laid out on a grid so the parts can rearrange
 * themselves at a narrow width instead of the whole thing needing a
 * horizontal scrollbar the way the table did. */
/* No height of its own and no scrolling of its own: the dialog is
 * `scrollable`, which makes its v-card-text the one scroll region. A
 * second one nested inside it capped the list at just over half the
 * screen while the dialog itself was full height — which is exactly what
 * "half of it is cut off" looks like on a phone. */
.discover-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.discover-card {
  display: grid;
  grid-template-areas: 'art body stats add';
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(255, 255, 255, 0.02);
}

.discover-card__art {
  grid-area: art;
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  cursor: pointer;
}

/* Hidden until hover — see the template's own comment for why play lives
 * on the logo instead of its own button. Square, no border-radius: the
 * favicon underneath (CoverArt.vue's `rounded` prop, despite the name) is
 * itself square-cornered here, and a rounded overlay on a square image
 * left visible corners peeking out from under it. */
.discover-card__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.discover-card__art:hover .discover-card__play,
.discover-card__art:focus-visible .discover-card__play {
  opacity: 1;
}

.discover-card__art:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

/* Touch has no hover to reveal anything with, so the overlay sits at a
 * permanent low opacity there instead of being invisible until a tap that
 * has already started playing something. */
@media (hover: none) {
  .discover-card__play {
    opacity: 0.35;
  }
}

.discover-card__body {
  grid-area: body;
  min-width: 0;
}

.discover-card__name-row {
  display: flex;
  align-items: center;
  /* Lets the name actually shrink and truncate instead of forcing the row
   * wider than its column — a flex item's default min-width is auto (its
   * content's own width), which single-handedly defeats text-overflow. */
  min-width: 0;
}

/* A station name has no length limit Radio Browser enforces — one found in
 * the wild ran to five lines wrapped. Single line, clipped with an
 * ellipsis, full name in the title tooltip instead. */
.discover-card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-weight: 600;
  font-size: 0.9rem;
}

.discover-card__name--link {
  color: inherit;
  text-decoration: none;
}

.discover-card__name--link:hover {
  text-decoration: underline;
}

.discover-card__health {
  margin-left: 6px;
  flex-shrink: 0;
}

.discover-card__meta {
  margin-top: 2px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-card__stats {
  grid-area: stats;
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
  white-space: nowrap;
}

.discover-card__stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.discover-card__add {
  grid-area: add;
}

/* Narrow: the two figures drop under the name rather than competing with
 * it for the same line, and the logo spans both rows so the text block
 * keeps its full width. The add button stays on the first line, where a
 * thumb expects it. */
/* Two rows on the phone, with the artwork spanning both: the stats line
 * (country, language, codec, popularity) has nowhere to go beside the name
 * at that width. */
.discover-card--compact {
  grid-template-areas:
    'art body add'
    'art stats stats';
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 4px 12px;
}

.discover-card--compact .discover-card__art {
  align-self: center;
}

.discover-card--compact .discover-card__stats {
  gap: 12px;
}
</style>
