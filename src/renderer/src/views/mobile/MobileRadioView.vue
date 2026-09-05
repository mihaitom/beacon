<template>
  <v-container fluid>
    <!-- The same flat title row every other Mobile* view uses, with the two
       - actions as icon buttons beside it — none of those views has a
       - header-level action whose labelled, pill-shaped desktop treatment
       - this could match against. -->
    <div class="mobile-header">
      <h1 class="page-title mobile-header__title">{{ $t('radio.title') }}</h1>
      <!-- The same compass as the desktop header's labelled button. There
         - is no "add by hand" beside it: that is three URL-shaped text
         - fields, and nobody types a stream URL on a phone — Discover
         - reaches the same result with a search and one tap. -->
      <v-btn
        icon="mdi-compass-outline"
        color="primary"
        variant="tonal"
        :title="$t('radio.discoverStations')"
        @click="discoverOpen = true"
      />
    </div>

    <!-- Only worth offering once there is more than a handful to search
       - through, the same threshold every other list here uses. Filters the
       - saved stations only; Discover has its own search against Radio
       - Browser's directory. -->
    <sticky-filter v-if="libraryStore.radioStations.length > 8">
      <v-text-field
        v-model="filterQuery"
        :label="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        clearable
        hide-details
      />
    </sticky-filter>

    <v-progress-circular v-if="showSkeletons" indeterminate class="mb-4" />

    <!-- Rows, not the desktop's grid of bordered tiles: a grid collapses to
       - one tile per line at this width anyway, so all the box around each
       - entry contributed was chrome. MobileRadioRow sits beside the
       - other Mobile* rows and is measured against the phone remote's own
       - radio tab — see __tests__/mobileRemoteParity.test.ts. -->
    <div v-if="filteredStations.length" class="mobile-radio-list">
      <mobile-radio-row
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

    <!-- Editing stays: renaming a station, or correcting a stream URL that
       - has moved, is not something to have to reach a desktop for — unlike
       - typing a whole new one in from scratch. -->
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

    <radio-discover-dialog v-model="discoverOpen" compact />
  </v-container>
</template>

<script lang="ts">
// The phone's own Radio page. It used to be a wrapper around the desktop
// RadioView with four props turning desktop-shaped pieces off, which left
// one component answering to two designs and deciding between them with
// media queries. Every other list screen on the phone is its own view
// (MobileLibraryView, MobilePlaylistsView, MobileQueueView); this is now
// too.
//
// The list rows are this side's own (components/mobile/MobileRadioRow.vue,
// beside every other phone row and measured against the LAN remote — see
// __tests__/mobileRemoteParity.test.ts). What the two pages do share is
// RadioDiscoverDialog, the station search: the one part of Radio that
// genuinely reads the same on both, and the one with a third-party API
// behind it that should not be wired up twice.
//
// What it deliberately does not have: the desktop's backdrop/cover hero
// (sized for a wide detail page), the tile grid, and adding a station by
// typing three URLs.
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { matchesAllTerms } from '@/services/textSearch'
import RadioDiscoverDialog from '@/components/radio/RadioDiscoverDialog.vue'
import MobileRadioRow from '@/components/mobile/MobileRadioRow.vue'
import StickyFilter from '@/components/StickyFilter.vue'
import type { RadioStation } from '@/types/library'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

export default {
  name: 'MobileRadioView',
  components: { RadioDiscoverDialog, MobileRadioRow, StickyFilter },
  data() {
    return {
      discoverOpen: false,
      editDialog: false,
      editingId: null as string | null,
      formName: '',
      formStreamUrl: '',
      formHomePageUrl: '',
      filterQuery: '',
      // filteredStations reads this rather than filterQuery, so filtering
      // does not run synchronously on every keystroke — the same pattern
      // as every other filtered list here. Also what the empty-state alert
      // checks, to tell "no stations saved at all" from "none of them
      // match this search".
      debouncedQuery: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    /** Only while there is genuinely nothing to show yet — the store's
     * loading flag is set by every library fetch, not just this list's. */
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
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
  },
  created() {
    this.libraryStore.fetchRadioStations()
  },
  methods: {
    play(station: RadioStation) {
      void usePlaybackStore().playRadioStation(station)
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
  },
}
</script>

<style scoped>
/* Rows sit directly against each other; the hairline between them is
 * MobileRadioRow's own (.mobile-row), which is what the phone remote's
 * list is measured against. */
.mobile-radio-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
