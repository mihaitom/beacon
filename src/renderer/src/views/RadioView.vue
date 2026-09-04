<template>
  <v-container fluid>
    <!-- Hero treatment, same as AlbumsView.vue/ArtistsView.vue/SongsView.vue
     - use for their own top-level browse headers, in place of the plain
     - title-bar-plus-buttons row this used to be — Radio is exactly the
     - same kind of "top-level library screen" those are, and standing out
     - as the one that didn't get it read as an oversight more than a
     - deliberate difference. No cover/backdrop of its own (no single piece
     - of art represents "your radio stations" the way an album's own cover
     - does), so this is fallback-icon only, same as PlaylistsView.vue's
     - identical case. -->
    <detail-header v-if="heroHeader" fallback-icon="mdi-radio" :title="$t('radio.title')">
      <template v-if="libraryStore.radioStations.length" #meta>
        {{ libraryStore.radioStations.length }}
        {{ libraryStore.radioStations.length === 1 ? $t('radio.station1') : $t('radio.stationsN') }}
      </template>
      <!-- Wrapped, not two bare siblings — see AlbumsView.vue's identical
       - .detail-header__actions-row/comment for why. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <v-btn prepend-icon="mdi-plus" color="primary" rounded="pill" @click="openCreate">{{
            $t('radio.addStation')
          }}</v-btn>
          <v-btn
            v-if="discoverEnabled"
            prepend-icon="mdi-compass-outline"
            rounded="pill"
            variant="tonal"
            @click="openBrowse"
            >{{ $t('radio.discoverStations') }}</v-btn
          >
        </div>
      </template>
    </detail-header>

    <!-- heroHeader false only from MobileRadioView.vue — the backdrop/cover
     - hero above is sized for a desktop detail page (see its own 180px
     - cover, 280px min-height) and never renders anywhere else this narrow:
     - every other top-level browse screen swaps to its own Mobile* view
     - below the mobile breakpoint (see App.vue's `layout` computed) before
     - it would have to. Radio is the one screen reused as-is on mobile
     - (see MobileRadioView.vue's own comment), so instead of a shrunk-down
     - hero it gets the same flat title-row every other Mobile* view already
     - uses (MobilePlaylistsView.vue/MobileSongsView.vue's own `h1.page-
     - title`) — with "add station" as a single icon button beside it since
     - none of those have a header-level action of their own to match
     - against, and discoverEnabled is always false here anyway. -->
    <div v-else class="radio-view__flat-header">
      <h1 class="page-title radio-view__flat-title">{{ $t('radio.title') }}</h1>
      <v-btn
        icon="mdi-plus"
        color="primary"
        variant="tonal"
        :title="$t('radio.addStation')"
        @click="openCreate"
      />
    </div>

    <!-- Only worth offering once there's more than a handful to search
     - through — same threshold reasoning as SongsView.vue's own filter
     - field, just against a saved-station list that's usually much shorter
     - than a song library. Filters this view's own saved stations only;
     - the Discover dialog below has its own independent search against
     - Radio Browser's directory instead of this one. -->
    <sticky-filter v-if="libraryStore.radioStations.length > 8">
      <v-text-field
        v-model="filterQuery"
        :label="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        class="mb-4"
        style="max-width: 320px"
      />
    </sticky-filter>

    <!-- See PlaylistsView.vue's identical block: placeholders shaped like
     - the tiles, in the grid's own place, instead of a spinner that shifted
     - everything below it. -->
    <div v-if="showSkeletons" class="radio-view__grid mb-4">
      <tile-skeleton v-for="n in SKELETON_TILES" :key="n" :cover-size="72" />
    </div>

    <!-- A wrapping grid of RadioStationCard's own horizontal tiles, not the
     - plain single-column list this used to be, and not AlbumsView.vue/
     - ArtistsView.vue's own big-cover-on-top card either — see that
     - component's own comment for why it deliberately looks like neither.
     - Batching still applies exactly as before: CoverArt.vue's own
     - request-batching is what keeps a whole screen of these to one
     - favicon round trip rather than one per card (see
     - radioFaviconBatch.ts) — the layout didn't change that, only how each
     - station looks. -->
    <div v-if="filteredStations.length" class="radio-view__grid">
      <radio-station-card
        v-for="station in filteredStations"
        :key="station.id"
        :station="station"
        @play="play"
        @edit="openEdit"
        @delete="remove"
      />
    </div>

    <v-alert v-else-if="!showSkeletons" type="info" variant="tonal">
      {{
        debouncedQuery
          ? $t('radio.noStationsForQuery', { query: debouncedQuery })
          : $t('radio.noStationsYet')
      }}
    </v-alert>

    <v-dialog v-model="createDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('radio.createTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="formName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formHomePageUrl"
            :label="$t('radio.homePageUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="create">{{ $t('common.add') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="editDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('radio.editTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="formName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formHomePageUrl"
            :label="$t('radio.homePageUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="editDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="saveEdit">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-if="discoverEnabled" v-model="browseDialog" max-width="1300">
      <v-card>
        <v-card-title>{{ $t('radio.discoverTitle') }}</v-card-title>
        <v-card-text>
          <div class="radio-view__browse-row">
            <v-text-field
              v-model="browseQuery"
              :label="$t('radio.discoverSearchLabel')"
              :placeholder="$t('radio.discoverSearchPlaceholder')"
              variant="solo-filled"
              clearable
              autofocus
              hide-details
              prepend-inner-icon="mdi-magnify"
              class="radio-view__browse-search"
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
              class="radio-view__browse-country"
            />
          </div>
          <v-btn-toggle
            v-model="browseOrder"
            mandatory
            density="compact"
            variant="outlined"
            divided
            class="radio-view__browse-order"
          >
            <v-btn value="votes" size="small">{{ $t('radio.discoverTopVoted') }}</v-btn>
            <v-btn value="clickcount" size="small">{{ $t('radio.discoverMostPlayed') }}</v-btn>
          </v-btn-toggle>
          <v-progress-linear v-if="browseLoading" indeterminate class="radio-view__browse-status" />
          <v-alert
            v-else-if="browseError"
            type="error"
            variant="tonal"
            density="compact"
            class="radio-view__browse-status"
          >
            {{ $t('radio.discoverSearchFailed') }}
          </v-alert>
          <v-alert
            v-else-if="browseHasNoResults"
            type="info"
            variant="tonal"
            density="compact"
            class="radio-view__browse-status"
          >
            {{
              browseQuery.trim()
                ? $t('radio.discoverNoResults', { query: browseQuery.trim() })
                : $t('radio.discoverNoResultsFiltered')
            }}
          </v-alert>
          <!-- A real table, not a list: desktop-only surface (see
           - discoverEnabled — MobileRadioView.vue never renders this at
           - all), and there's enough per-station data worth a glance
           - (location, language, codec, popularity, health) that packing
           - it all into one subtitle line stopped being readable. Virtual
           - rather than plain so a broad, filterless "top 30" browse
           - doesn't have to paginate. -->
          <v-data-table-virtual
            v-if="browseResults.length"
            :headers="browseTableHeaders"
            :items="browseResults"
            item-value="stationuuid"
            height="420"
            density="compact"
            fixed-header
          >
            <template v-slot:[`item.favicon`]="{ item }">
              <!-- Play moved here (hover-reveal over a bigger favicon)
               - rather than its own button — the favicon is the thing a
               - person's eye already goes to first, and there's no reason
               - to make it two separate targets when one already implies
               - "this row, playing" the same way a track row's own cover
               - art does elsewhere in the app. -->
              <div
                class="radio-view__browse-favicon"
                :title="$t('radio.discoverPlay')"
                @click="playBrowsedStation(item)"
              >
                <cover-art
                  :radio-favicon="
                    item.homepage || item.favicon
                      ? faviconRequest(item.homepage, 48, item.favicon)
                      : null
                  "
                  :size="40"
                  rounded
                  fallback-icon="mdi-radio"
                />
                <div class="radio-view__browse-favicon-play">
                  <v-icon icon="mdi-play" size="20" color="white" />
                </div>
              </div>
            </template>
            <template v-slot:[`item.name`]="{ item }">
              <div class="radio-view__browse-name">
                <a
                  v-if="item.homepage"
                  :href="item.homepage"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="radio-view__browse-name-text radio-view__browse-name-link"
                  :title="item.name"
                  >{{ item.name }}</a
                >
                <span v-else class="radio-view__browse-name-text" :title="item.name">{{
                  item.name
                }}</span>
                <v-icon
                  :icon="item.lastcheckok ? 'mdi-circle' : 'mdi-circle-outline'"
                  :color="item.lastcheckok ? 'success' : undefined"
                  size="8"
                  class="radio-view__browse-status-dot"
                  :title="
                    item.lastcheckok ? $t('radio.discoverStreamOk') : $t('radio.discoverStreamDown')
                  "
                />
              </div>
            </template>
            <template v-slot:[`item.location`]="{ item }">{{ locationFor(item) }}</template>
            <template v-slot:[`item.languagecodes`]="{ item }">{{
              item.languagecodes.toUpperCase()
            }}</template>
            <template v-slot:[`item.codec`]="{ item }">{{ codecFor(item) }}</template>
            <template v-slot:[`item.votes`]="{ item }">{{ item.votes.toLocaleString() }}</template>
            <template v-slot:[`item.clickcount`]="{ item }">
              {{ item.clickcount.toLocaleString() }}
              <span
                v-if="item.clicktrend"
                :class="item.clicktrend > 0 ? 'text-success' : 'text-error'"
                >({{ item.clicktrend > 0 ? '+' : '' }}{{ item.clicktrend }})</span
              >
            </template>
            <template v-slot:[`item.actions`]="{ item }">
              <v-btn
                v-if="addedStationuuids.has(item.stationuuid)"
                icon="mdi-check"
                variant="text"
                size="small"
                disabled
              />
              <v-btn
                v-else
                icon="mdi-plus"
                variant="text"
                size="small"
                :loading="addingStationuuids.has(item.stationuuid)"
                :disabled="addingStationuuids.has(item.stationuuid)"
                @click="addBrowsedStation(item)"
              />
            </template>
          </v-data-table-virtual>
        </v-card-text>
        <v-card-actions>
          <a
            :href="radioBrowserHomepage"
            target="_blank"
            rel="noopener noreferrer"
            class="radio-view__browse-credit"
            >{{ $t('radio.discoverCredit') }}</a
          >
          <v-spacer />
          <v-btn variant="text" @click="browseDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { accountScopedKey } from '@/services/accountKey'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import {
  listRadioBrowserCountries,
  registerRadioBrowserClick,
  searchRadioBrowser,
  type RadioBrowserFilterOption,
  type RadioBrowserStation,
} from '@/services/connect/radioBrowser'
import CoverArt from '@/components/library/CoverArt.vue'
import DetailHeader from '@/components/library/DetailHeader.vue'
import RadioStationCard from '@/components/library/RadioStationCard.vue'
import TileSkeleton from '@/components/library/TileSkeleton.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import { matchesAllTerms } from '@/services/textSearch'
import type { RadioStation } from '@/types/library'

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

// Separate from browseDebounceTimer above — this one debounces filterQuery
// (this view's own saved-station search) rather than browseQuery (the
// Discover dialog's independent search against Radio Browser), same
// module-level-timer reasoning as that one's own comment.
let filterDebounceTimer: ReturnType<typeof setTimeout> | undefined

// Credited in the discover dialog's own footer — Radio Browser is what the
// whole feature is built on top of, not something to leave unattributed.
const RADIO_BROWSER_HOMEPAGE = 'https://www.radio-browser.info/'

// See PlaylistsView.vue's own SKELETON_TILES — same number, same reasoning.
const SKELETON_TILES = 8

export default {
  name: 'RadioView',
  components: { CoverArt, DetailHeader, RadioStationCard, TileSkeleton, StickyFilter },
  props: {
    // false only from MobileRadioView.vue — the discover table is a
    // desktop-only surface by design, not something trimmed down for a
    // narrow screen (see RadioView.vue's own comment on the table itself).
    discoverEnabled: { type: Boolean, default: true },
    // false only from MobileRadioView.vue — swaps the desktop hero header
    // for the flat title-row every other Mobile* view uses. See the
    // template's own v-else branch for why.
    heroHeader: { type: Boolean, default: true },
  },
  data() {
    return {
      SKELETON_TILES,
      createDialog: false,
      editDialog: false,
      editingId: null as string | null,
      formName: '',
      formStreamUrl: '',
      formHomePageUrl: '',
      filterQuery: '',
      // filteredStations reads this instead of filterQuery directly, so
      // filtering doesn't run synchronously on every keystroke — see the
      // identical pattern (and its rationale) in SongsView.vue/
      // PlaylistsView.vue. Also what the empty-state alert checks, to tell
      // "no stations saved at all" from "none of them match this search".
      debouncedQuery: '',
      browseDialog: false,
      browseQuery: '',
      // Loaded once here, not reset in openBrowse() — see this component's
      // own saveBrowseCountry()/loadSavedBrowseCountry() for why this one
      // filter persists across dialog opens (and app restarts) while the
      // query text and order toggle deliberately start fresh each time.
      browseCountry: loadSavedBrowseCountry() as string | null,
      browseOrder: 'votes' as 'votes' | 'clickcount',
      browseResults: [] as RadioBrowserStation[],
      browseLoading: false,
      browseError: false,
      // Populated once (loadBrowseFilterOptions()) and kept for the
      // component's whole lifetime — which countries exist in the
      // directory doesn't change between one dialog open and the next.
      countryOptions: [] as RadioBrowserFilterOption[],
      // Which of this dialog's own results have already been added, purely
      // for the add button to turn into a checkmark — reset each time the
      // dialog opens, not cross-referenced against libraryStore.radioStations
      // (Radio Browser results carry no id that overlaps a saved station's).
      addedStationuuids: new Set<string>(),
      // Which results have a saveRadioStation() call in flight right now —
      // see addBrowsedStation()'s own comment on why the add button needs
      // this on top of addedStationuuids.
      addingStationuuids: new Set<string>(),
      // Guards a slow search response landing after a newer query already
      // superseded it — same shape as SongWaveform.vue's fetchedSongId
      // guard, just a counter instead of an id since queries aren't unique.
      browseSeq: 0,
      // Set for the span of openBrowse()'s own reset-to-defaults — see its
      // own comment on why the browseQuery/browseOrder watchers below have
      // to check it.
      suppressBrowseReset: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    /** See the template — only while there is genuinely nothing to show
     * yet, since this flag is set by every library fetch, not just the
     * station list's own. */
    showSkeletons(): boolean {
      return this.libraryStore.loading && this.libraryStore.radioStations.length === 0
    },
    filteredStations(): RadioStation[] {
      const query = this.debouncedQuery
      if (!query.trim()) return this.libraryStore.radioStations
      return this.libraryStore.radioStations.filter((station: RadioStation) =>
        matchesAllTerms(query, station.name),
      )
    },
    browseHasNoResults(): boolean {
      return !this.browseLoading && !this.browseError && this.browseResults.length === 0
    },
    radioBrowserHomepage(): string {
      return RADIO_BROWSER_HOMEPAGE
    },
    // No column is individually sortable (see the table's own comment) —
    // the votes/most-played toggle above it is the one sort control, kept
    // singular so it can't disagree with a per-column click.
    browseTableHeaders() {
      return [
        { title: '', key: 'favicon', sortable: false, width: 64 },
        // Carries the homepage link and the health dot too (see that
        // slot's own template) — no separate columns for either.
        // Fixed rather than left to grow with content — a station name has
        // no length limit of its own, and one seen in the wild ran on for
        // several hundred characters, stretching this column across the
        // rest of the table and pushing every other one out past the
        // visible edge. `width` alone doesn't cap it — VDataTableColumn
        // only applies that as a table-layout: auto *hint* (the browser is
        // still free to grow the cell for a long unbreakable string of
        // content); `maxWidth` sets a real CSS max-width on the cell,
        // which is what actually stops it (see
        // radio-view__browse-name-text's own comment for the matching
        // ellipsis truncation inside).
        {
          title: this.$t('common.name'),
          key: 'name',
          sortable: false,
          width: 260,
          maxWidth: 260,
        },
        { title: this.$t('radio.discoverColumnLocation'), key: 'location', sortable: false },
        { title: this.$t('radio.discoverColumnLanguage'), key: 'languagecodes', sortable: false },
        { title: this.$t('radio.discoverColumnCodec'), key: 'codec', sortable: false },
        {
          title: this.$t('radio.discoverColumnVotes'),
          key: 'votes',
          sortable: false,
          align: 'end' as const,
        },
        {
          title: this.$t('radio.discoverColumnClicks'),
          key: 'clickcount',
          sortable: false,
          align: 'end' as const,
        },
        { title: '', key: 'actions', sortable: false, width: 48 },
      ]
    },
  },
  created() {
    this.libraryStore.fetchRadioStations()
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(filterDebounceTimer)
      filterDebounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
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
    faviconRequest(homePageUrl: string, minSize = 0, hint = ''): RadioFaviconRequest {
      return radioFaviconRequest(homePageUrl ?? '', minSize, hint ?? '')
    },
    play(station: RadioStation) {
      void usePlaybackStore().playRadioStation(station)
    },
    openCreate() {
      this.formName = ''
      this.formStreamUrl = ''
      this.formHomePageUrl = ''
      this.createDialog = true
    },
    async create() {
      if (!this.formName.trim() || !this.formStreamUrl.trim()) return
      await this.libraryStore.saveRadioStation(
        this.formName.trim(),
        this.formStreamUrl.trim(),
        this.formHomePageUrl.trim(),
      )
      this.createDialog = false
    },
    openEdit(station: RadioStation) {
      this.editingId = station.id
      this.formName = station.name
      this.formStreamUrl = station.streamUrl
      this.formHomePageUrl = station.homePageUrl ?? ''
      this.editDialog = true
    },
    async saveEdit() {
      if (!this.editingId || !this.formName.trim() || !this.formStreamUrl.trim()) return
      await this.libraryStore.updateRadioStation(
        this.editingId,
        this.formName.trim(),
        this.formStreamUrl.trim(),
        this.formHomePageUrl.trim(),
      )
      this.editDialog = false
    },
    async remove(station: RadioStation) {
      await this.libraryStore.deleteRadioStation(station.id)
    },
    openBrowse() {
      clearTimeout(browseDebounceTimer)
      // Reopening after a non-default query/order left over from the last
      // visit resets both below, and each is watched — without this guard,
      // the browseOrder watcher fired its own immediate runBrowseSearch()
      // and the (debounced, but still eventually firing) browseQuery one
      // queued a second, on top of the explicit call this method already
      // makes at the end. Three redundant requests to Radio Browser's
      // third-party API for what should be exactly one. Cleared once this
      // method's own synchronous reset has had its chance to reach both
      // watchers — see their own checks.
      this.suppressBrowseReset = true
      this.browseQuery = ''
      // browseCountry is deliberately left alone — see its own data()
      // comment for why that one filter survives across dialog opens.
      this.browseOrder = 'votes'
      this.browseResults = []
      this.browseError = false
      this.addedStationuuids = new Set()
      this.browseDialog = true
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
            console.error('[radio-view] Failed to load Radio Browser countries:', error)
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
        console.error('[radio-view] Radio Browser search failed:', error)
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
    async addBrowsedStation(result: RadioBrowserStation) {
      // addedStationuuids only gains this row once saveRadioStation()
      // actually resolves, so the button stays a plain (still-clickable)
      // plus icon for the whole round trip — a second click/tap before
      // the first save lands fired a second, concurrent save, creating a
      // duplicate saved station. This guard is what addingStationuuids
      // (see its own comment) exists for.
      if (this.addingStationuuids.has(result.stationuuid)) return
      this.addingStationuuids.add(result.stationuuid)
      try {
        await this.libraryStore.saveRadioStation(result.name, result.url, result.homepage)
        this.addedStationuuids.add(result.stationuuid)
        registerRadioBrowserClick(result.stationuuid)
      } finally {
        this.addingStationuuids.delete(result.stationuuid)
      }
    },
    // A one-off listen, deliberately not going through saveRadioStation —
    // this plays the same way song radio does (see playRadioStation()'s
    // own contract), with nothing written to the saved station list unless
    // the person also hits the add button.
    playBrowsedStation(result: RadioBrowserStation) {
      void usePlaybackStore().playRadioStation({
        id: result.stationuuid,
        name: result.name,
        streamUrl: result.url,
        homePageUrl: result.homepage || null,
        favicon: result.favicon || undefined,
      })
      registerRadioBrowserClick(result.stationuuid)
    },
  },
}
</script>

<style scoped>
/* Same wrapped-actions treatment as AlbumsView.vue's identical class/
 * comment — DetailHeader.vue's own .detail-header__actions only ever had
 * margin-top before (every prior single-button consumer didn't need more),
 * no gap/wrap for the two pills sitting side by side here. */
.detail-header__actions-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* heroHeader's flat mobile alternative to detail-header__actions-row above —
 * same title-plus-single-icon-button row MobilePlaylistDetailView.vue's own
 * header uses, not a Vuetify utility-class row. */
.radio-view__flat-header {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.radio-view__flat-title {
  flex: 1 1 auto;
}

.radio-view__grid {
  display: flex;
  flex-wrap: wrap;
  /* Tighter than AlbumsView.vue's own .album-grid/ArtistsView.vue's
   * .artist-grid (20px) — RadioStationCard.vue is a compact horizontal
   * tile, not a big square cover, and 20px between tiles that short read
   * as gappy rather than airy. */
  gap: 14px;
}

.radio-view__browse-row {
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
.radio-view__browse-search {
  flex: 2;
  min-width: 0;
}

.radio-view__browse-country {
  flex: 1;
  min-width: 0;
}

.radio-view__browse-status {
  margin-bottom: 8px;
}

.radio-view__browse-order {
  margin-bottom: 12px;
}

.radio-view__browse-credit {
  align-self: center;
  font-size: 0.8125rem;
  opacity: 0.7;
}

.radio-view__browse-favicon {
  position: relative;
  width: 40px;
  height: 40px;
  cursor: pointer;
}

/* Hidden until hover — see this slot's own template comment for why play
 * lives here instead of its own button. Square, no border-radius: the
 * favicon underneath (CoverArt.vue's `rounded` prop, despite the name) is
 * itself square-cornered here, and a rounded overlay on a square image
 * left visible corners peeking out from under it. */
.radio-view__browse-favicon-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.radio-view__browse-favicon:hover .radio-view__browse-favicon-play {
  opacity: 1;
}

.radio-view__browse-name {
  display: flex;
  align-items: center;
  /* Lets the text child below actually shrink and truncate instead of
   * forcing the flex row wider than the column — a flex item's default
   * min-width is auto (its content's own width), which single-handedly
   * defeats text-overflow: ellipsis without this. */
  min-width: 0;
}

/* A station name has no length limit Radio Browser enforces - one found
 * in the wild ran to five lines wrapped. Single line, clipped with an
 * ellipsis, full name in the title tooltip instead. */
.radio-view__browse-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.radio-view__browse-name-link {
  color: inherit;
  text-decoration: none;
}

.radio-view__browse-name-link:hover {
  text-decoration: underline;
}

.radio-view__browse-status-dot {
  margin-left: 6px;
  flex-shrink: 0;
}
</style>
