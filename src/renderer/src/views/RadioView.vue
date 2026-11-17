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
    <detail-header :title="$t('radio.title')" stored-fanart>
      <template v-if="libraryStore.radioStations.length" #meta>
        {{ $n(libraryStore.radioStations.length) }}
        {{ libraryStore.radioStations.length === 1 ? $t('radio.station1') : $t('radio.stationsN') }}
      </template>
      <!-- Wrapped, not two bare siblings — see AlbumsView.vue's identical
       - .detail-header__actions-row/comment for why. -->
      <template #actions>
        <div class="detail-header__actions-row">
          <!-- Only for an account the server actually lets save one (see
             - services/capabilities.ts's internetRadioManagement); Discover
             - beside it stays either way, since playing a station it finds
             - needs no such right. -->
          <v-btn
            v-if="authStore.capabilities.internetRadioManagement"
            prepend-icon="mdi-plus"
            color="primary"
            rounded="pill"
            @click="openCreate"
            >{{ $t('radio.addStation') }}</v-btn
          >
          <v-btn
            prepend-icon="mdi-compass-outline"
            rounded="pill"
            color="primary"
            @click="openBrowse"
            >{{ $t('radio.discoverStations') }}</v-btn
          >
        </div>
      </template>
    </detail-header>

    <!-- Filters this view's own saved stations only; the Discover dialog
     - below has its own independent search against Radio Browser's
     - directory instead of this one. -->
    <sticky-filter v-if="libraryStore.radioStations.length">
      <div class="library-filter">
        <v-text-field
          v-model="filterQuery"
          :placeholder="$t('search.label')"
          :aria-label="$t('search.label')"
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          density="compact"
          rounded="pill"
          flat
          clearable
          hide-details
          class="library-search"
        />
        <v-btn-toggle
          v-if="tags.length"
          :model-value="activeTag"
          mandatory
          class="beacon-view-toggle beacon-view-toggle--text"
          :aria-label="$t('radio.segments')"
          @update:model-value="tag = $event"
        >
          <v-btn :value="ALL_STATIONS">{{ $t('playlists.segmentAll') }}</v-btn>
          <v-btn v-for="item in tags" :key="item" :value="item">{{ item }}</v-btn>
        </v-btn-toggle>
        <div class="library-controls">
          <v-btn-toggle
            :model-value="listView ? 'list' : 'grid'"
            mandatory
            class="beacon-view-toggle"
            :aria-label="$t('library.layout')"
            @update:model-value="setListView($event === 'list')"
          >
            <v-btn value="grid" icon="mdi-view-grid-outline" :title="$t('library.layoutGrid')" />
            <v-btn value="list" icon="mdi-view-list" :title="$t('library.layoutList')" />
          </v-btn-toggle>
          <library-sort-select
            :model-value="sort.key"
            :items="sortItems"
            :direction="sort.direction"
            @update:model-value="pickSort"
            @toggle-direction="toggleDirection"
          />
        </div>
      </div>
    </sticky-filter>

    <!-- See PlaylistsView.vue's identical block: placeholders shaped like
     - the list, in its own place, instead of a spinner that shifted
     - everything below it. -->
    <div v-if="showSkeletons && listView" class="beacon-panel beacon-panel--flush radio-view__list">
      <row-skeleton v-for="n in SKELETON_ROWS" :key="n" :cover-size="88" />
    </div>
    <div v-else-if="showSkeletons" class="radio-view__grid">
      <v-skeleton-loader
        v-for="n in SKELETON_ROWS"
        :key="n"
        type="image"
        class="radio-view__skeleton"
      />
    </div>

    <!-- CoverArt.vue's request batching keeps a whole screen of logos to one
     - round trip (see radioFaviconBatch.ts), and the cards' extras arrive in
     - one request for the whole list too (stores/radioStationInfo.ts). -->
    <template v-if="!showSkeletons">
      <template v-for="section in sections" :key="section.key">
        <h2 v-if="section.title" class="section-title">{{ section.title }}</h2>
        <div :class="containerClass">
          <radio-station-card
            v-for="station in section.stations"
            :key="station.id"
            :station="station"
            :row="listView"
            @play="play"
            @edit="openEdit"
            @delete="remove"
          />
        </div>
      </template>

      <empty-state
        v-if="!sections.length"
        :icon="debouncedQuery ? 'mdi-magnify-close' : 'mdi-radio-off'"
        :title="
          debouncedQuery
            ? $t('radio.noStationsForQuery', { query: debouncedQuery })
            : $t('radio.noStationsYet')
        "
      />
    </template>

    <v-dialog v-model="createDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('radio.createTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="formName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            class="radio-form__field"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="radio-form__field"
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
            class="radio-form__field"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="radio-form__field"
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

    <!-- Shared with the phone's own Radio page — see
     - components/radio/RadioDiscoverDialog.vue for why this one piece is
     - shared while the two pages are not. -->
    <radio-discover-dialog v-model="browseDialog" />
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import DetailHeader from '@/components/library/DetailHeader.vue'
import RadioDiscoverDialog from '@/components/radio/RadioDiscoverDialog.vue'
import RadioStationCard from '@/components/library/RadioStationCard.vue'
import LibrarySortSelect from '@/components/library/LibrarySortSelect.vue'
import RowSkeleton from '@/components/library/RowSkeleton.vue'
import { useRadioStationInfoStore } from '@/stores/radioStationInfo'
import StickyFilter from '@/components/StickyFilter.vue'
import { matchesAllTerms } from '@/services/textSearch'
import { readBooleanPreference, writeBooleanPreference } from '@/services/booleanPreference'
import {
  RADIO_SORT_KEYS,
  commonTags,
  defaultRadioDirection,
  hasTag,
  heardSections,
  loadRadioSort,
  saveRadioSort,
  sortStations,
  type RadioSort,
  type RadioSortKey,
} from '@/services/library/radioBrowse'
import type { RadioStation } from '@/types/library'

// Debounces filterQuery, this view's own saved-station search —
// module-level like SongsView.vue's own, since a component instance only
// ever has one search box live at a time and this avoids a stray timer
// surviving past the component that armed it.
let filterDebounceTimer: ReturnType<typeof setTimeout> | undefined

// See PlaylistsView.vue's own SKELETON_TILES — same number, same reasoning.
const SKELETON_ROWS = 5

const LIST_VIEW_KEY = 'beacon.radioListView'
// The tag toggle's "everything" entry; a real tag is never empty.
const ALL_STATIONS = ''
const SORT_LABELS = {
  heard: 'radio.sortHeard',
  name: 'library.albumSort.name',
  country: 'radio.sortCountry',
  bitrate: 'radio.sortBitrate',
} as const

interface StationSection {
  key: string
  title: string
  stations: RadioStation[]
}

export default {
  name: 'RadioView',
  components: {
    EmptyState,
    DetailHeader,
    RadioDiscoverDialog,
    RadioStationCard,
    LibrarySortSelect,
    RowSkeleton,
    StickyFilter,
  },
  data() {
    return {
      SKELETON_ROWS,
      ALL_STATIONS,
      tag: ALL_STATIONS,
      sort: loadRadioSort() as RadioSort,
      listView: readBooleanPreference(LIST_VIEW_KEY),
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
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    stationInfo() {
      return useRadioStationInfoStore()
    },
    /** See the template — only while there is genuinely nothing to show
     * yet, since this flag is set by every library fetch, not just the
     * station list's own. The details count too on a first visit, unless
     * sorting by name: every order but that one comes from them, and the
     * cards would otherwise jump once they arrive. */
    showSkeletons(): boolean {
      if (this.libraryStore.radioStations.length === 0) return this.libraryStore.loading
      return this.sort.key !== 'name' && !this.stationInfo.settled
    },
    tags(): string[] {
      return commonTags(this.libraryStore.radioStations, this.stationInfo.infoFor)
    },
    /** Back to everything when the picked tag has gone, or its button would
     * be gone and the page stuck on an empty wall. */
    activeTag(): string {
      return this.tags.includes(this.tag) ? this.tag : ALL_STATIONS
    },
    sortItems(): { title: string; value: string }[] {
      return RADIO_SORT_KEYS.map((key) => ({ title: this.$t(SORT_LABELS[key]), value: key }))
    },
    containerClass(): string {
      return this.listView
        ? 'beacon-panel beacon-panel--flush radio-view__list'
        : 'radio-view__grid'
    },
    filteredStations(): RadioStation[] {
      const query = this.debouncedQuery
      const infoFor = this.stationInfo.infoFor
      const matching = this.libraryStore.radioStations.filter(
        (station: RadioStation) =>
          (this.activeTag === ALL_STATIONS || hasTag(station, this.activeTag, infoFor)) &&
          // Always exact: a station is found by its name, and the list is
          // short enough that a misspelling is worth correcting rather than
          // guessing around.
          (!query.trim() || matchesAllTerms(query, [station.name], { exact: true })),
      )
      return sortStations(matching, this.sort, infoFor)
    },
    /** Grouped only by the order that is about listening, and headed only
     * when there are two groups to tell apart. */
    sections(): StationSection[] {
      const stations = this.filteredStations
      if (!stations.length) return []
      if (this.sort.key === 'heard') {
        const { heardThisWeek, earlier } = heardSections(
          stations,
          this.stationInfo.infoFor,
          Date.now(),
        )
        if (heardThisWeek.length && earlier.length) {
          return [
            { key: 'week', title: this.$t('radio.sectionHeardThisWeek'), stations: heardThisWeek },
            { key: 'earlier', title: this.$t('radio.sectionEarlier'), stations: earlier },
          ]
        }
      }
      return [{ key: 'all', title: '', stations }]
    },
  },
  created() {
    this.libraryStore.fetchRadioStations()
  },
  watch: {
    // Asked again whenever the list changes (a station added or edited),
    // and on every visit - the last title heard changes with listening.
    'libraryStore.radioStations': {
      handler(stations: RadioStation[]) {
        void useRadioStationInfoStore().load(stations)
      },
      immediate: true,
    },
    filterQuery(value: string | null) {
      clearTimeout(filterDebounceTimer)
      filterDebounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  methods: {
    /** A second click on the station that is on stops it, as the player's
     * own button does. */
    play(station: RadioStation) {
      const playback = usePlaybackStore()
      if (playback.radioStation?.id === station.id) void playback.togglePlay()
      else void playback.playRadioStation(station)
    },
    setListView(listView: boolean): void {
      this.listView = listView
      writeBooleanPreference(LIST_VIEW_KEY, listView)
    },
    pickSort(key: string): void {
      const sortKey = key as RadioSortKey
      this.setSort({ key: sortKey, direction: defaultRadioDirection(sortKey) })
    },
    toggleDirection(): void {
      this.setSort({
        key: this.sort.key,
        direction: this.sort.direction === 'asc' ? 'desc' : 'asc',
      })
    },
    setSort(sort: RadioSort): void {
      this.sort = sort
      saveRadioSort(sort)
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
      this.browseDialog = true
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

.section-title {
  margin-bottom: 8px;
}

.radio-view__list {
  margin-bottom: 24px;
}

/* The gaps are wide for the glow behind a card, as on the Playlists page. */
.radio-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 44px 36px;
  margin: 18px 0 40px;
}

.radio-view__skeleton {
  aspect-ratio: 1;
  background: transparent;
}

.radio-view__skeleton :deep(.v-skeleton-loader__bone) {
  height: 100%;
  margin: 0;
}

/* The add/edit station form: three URL-shaped fields in a column. */
.radio-form__field {
  margin-bottom: 8px;
}
</style>
