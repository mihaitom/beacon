<template>
  <v-container fluid>
    <div class="radio-view__header">
      <h1 class="page-title">{{ $t('radio.title') }}</h1>
      <v-spacer />
      <v-btn
        v-if="discoverEnabled"
        prepend-icon="mdi-compass-outline"
        variant="text"
        @click="openBrowse"
        >{{ $t('radio.discoverStations') }}</v-btn
      >
      <v-btn prepend-icon="mdi-plus" variant="tonal" @click="openCreate">{{
        $t('radio.addStation')
      }}</v-btn>
    </div>

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <v-list v-if="libraryStore.radioStations.length" class="beacon-list">
      <v-list-item
        v-for="station in libraryStore.radioStations"
        :key="station.id"
        :title="station.name"
        :subtitle="station.streamUrl"
        @click="play(station)"
      >
        <template #prepend>
          <!-- CoverArt.vue's imageUrl prop already does exactly what a
           - station favicon needs: try the given URL, fall back to
           - fallback-icon on load failure, and — the actual reason to use
           - it here rather than a hand-rolled <img>+<v-icon> pair — always
           - render the *same* v-avatar-wrapped markup either way. A bare
           - <img> vs a bare <v-icon> directly in VListItem's prepend slot
           - used to get different spacing before the title text, since
           - VListItem sizes that slot differently depending on what kind
           - of content it recognizes inside it. -->
          <cover-art
            :image-url="station.homePageUrl ? faviconUrl(station.homePageUrl, 32) : null"
            :size="24"
            rounded
            fallback-icon="mdi-radio"
            class="mr-3"
          />
        </template>
        <template #append>
          <v-btn icon="mdi-play" variant="text" @click.stop="play(station)" />
          <v-btn icon="mdi-pencil-outline" variant="text" @click.stop="openEdit(station)" />
          <v-btn icon="mdi-delete-outline" variant="text" @click.stop="remove(station)" />
        </template>
      </v-list-item>
    </v-list>

    <v-alert v-else-if="!libraryStore.loading" type="info" variant="tonal">
      {{ $t('radio.noStationsYet') }}
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
              density="compact"
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
                  :image-url="item.homepage ? faviconUrl(item.homepage, 48, item.favicon) : null"
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
import { useAuthStore } from '@/stores/auth'
import { accountScopedKey } from '@/services/accountKey'
import { radioFaviconUrl } from '@/services/connect/radio'
import {
  listRadioBrowserCountries,
  registerRadioBrowserClick,
  searchRadioBrowser,
  type RadioBrowserFilterOption,
  type RadioBrowserStation,
} from '@/services/connect/radioBrowser'
import CoverArt from '@/components/library/CoverArt.vue'
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

// Credited in the discover dialog's own footer — Radio Browser is what the
// whole feature is built on top of, not something to leave unattributed.
const RADIO_BROWSER_HOMEPAGE = 'https://www.radio-browser.info/'

export default {
  name: 'RadioView',
  components: { CoverArt },
  props: {
    // false only from MobileRadioView.vue — the discover table is a
    // desktop-only surface by design, not something trimmed down for a
    // narrow screen (see RadioView.vue's own comment on the table itself).
    discoverEnabled: { type: Boolean, default: true },
  },
  data() {
    return {
      createDialog: false,
      editDialog: false,
      editingId: null as string | null,
      formName: '',
      formStreamUrl: '',
      formHomePageUrl: '',
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
      // Guards a slow search response landing after a newer query already
      // superseded it — same shape as SongWaveform.vue's fetchedSongId
      // guard, just a counter instead of an id since queries aren't unique.
      browseSeq: 0,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
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
    browseQuery() {
      clearTimeout(browseDebounceTimer)
      browseDebounceTimer = setTimeout(() => this.runBrowseSearch(), 400)
    },
    browseCountry() {
      saveBrowseCountry(this.browseCountry)
      clearTimeout(browseDebounceTimer)
      void this.runBrowseSearch()
    },
    browseOrder() {
      clearTimeout(browseDebounceTimer)
      void this.runBrowseSearch()
    },
  },
  methods: {
    faviconUrl(homePageUrl: string, minSize = 0, hint = ''): string {
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, minSize, hint)
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
      await this.libraryStore.saveRadioStation(result.name, result.url, result.homepage)
      this.addedStationuuids.add(result.stationuuid)
      registerRadioBrowserClick(result.stationuuid)
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
.radio-view__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.radio-view__browse-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

/* The search field gets most of the row; the country select only needs
 * enough width for a country name. */
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
