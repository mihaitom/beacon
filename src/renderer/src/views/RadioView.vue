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
    <detail-header fallback-icon="mdi-radio" :title="$t('radio.title')">
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
            prepend-icon="mdi-compass-outline"
            rounded="pill"
            color="primary"
            @click="openBrowse"
            >{{ $t('radio.discoverStations') }}</v-btn
          >
        </div>
      </template>
    </detail-header>

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
        class="library-search"
      />
    </sticky-filter>

    <!-- See PlaylistsView.vue's identical block: placeholders shaped like
     - the tiles, in the grid's own place, instead of a spinner that shifted
     - everything below it. -->
    <div v-if="showSkeletons" class="radio-view__grid radio-view__grid--loading">
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
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import DetailHeader from '@/components/library/DetailHeader.vue'
import RadioDiscoverDialog from '@/components/radio/RadioDiscoverDialog.vue'
import RadioStationCard from '@/components/library/RadioStationCard.vue'
import TileSkeleton from '@/components/library/TileSkeleton.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import { matchesAllTerms } from '@/services/textSearch'
import type { RadioStation } from '@/types/library'

// Debounces filterQuery, this view's own saved-station search —
// module-level like SongsView.vue's own, since a component instance only
// ever has one search box live at a time and this avoids a stray timer
// surviving past the component that armed it.
let filterDebounceTimer: ReturnType<typeof setTimeout> | undefined

// See PlaylistsView.vue's own SKELETON_TILES — same number, same reasoning.
const SKELETON_TILES = 8

export default {
  name: 'RadioView',
  components: {
    DetailHeader,
    RadioDiscoverDialog,
    RadioStationCard,
    TileSkeleton,
    StickyFilter,
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
  },
  methods: {
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

.radio-view__grid {
  display: flex;
  flex-wrap: wrap;
  /* Tighter than AlbumsView.vue's own .album-grid/ArtistsView.vue's
   * .artist-grid (20px) — RadioStationCard.vue is a compact horizontal
   * tile, not a big square cover, and 20px between tiles that short read
   * as gappy rather than airy. */
  gap: 14px;
}

/* The placeholder grid keeps the gap the real one has under it, so
 * nothing shifts when the stations arrive. */
.radio-view__grid--loading {
  margin-bottom: 16px;
}

/* The add/edit station form: three URL-shaped fields in a column. */
.radio-form__field {
  margin-bottom: 8px;
}
</style>
