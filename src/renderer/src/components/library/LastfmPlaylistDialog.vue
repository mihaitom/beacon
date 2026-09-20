<template>
  <v-dialog v-model="visible" max-width="880" scrollable>
    <v-card class="beacon-dialog">
      <v-card-title class="dialog-head">
        <div class="dialog-head__text">
          <span class="eyebrow-label">{{ $t('lastfm.eyebrow') }}</span>
          <h2 class="display-title dialog-head__title">{{ dialogTitle }}</h2>
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :aria-label="$t('common.cancel')"
          @click="visible = false"
        />
      </v-card-title>

      <v-card-text>
        <!-- Step 1: what to fetch. Stays mounted behind the result list so
         - going back doesn't lose what was typed. -->
        <div v-if="step === 'form'" class="form">
          <v-select
            v-model="op"
            :items="sourceOptions"
            :label="$t('lastfm.source')"
            variant="solo-filled"
            hide-details
          />

          <template v-if="op === 'charts'">
            <template v-if="source === 'lastfm'">
              <v-select
                v-model="chartScope"
                :items="chartScopeOptions"
                :label="$t('lastfm.chartScope')"
                variant="solo-filled"
                hide-details
              />
              <!-- Its own country list, not the station directory's - the
               - two disagree on names, and Last.fm rejects most of the
               - directory's. See services/lastfmCountries.ts.
               - v-autocomplete rather than a select because the list runs
               - to roughly 250 entries. -->
              <v-autocomplete
                v-if="chartScope === 'country'"
                v-model="countryValue"
                :items="countryItems"
                item-title="name"
                item-value="value"
                :label="$t('lastfm.country')"
                :placeholder="$t('lastfm.countryPlaceholder')"
                variant="solo-filled"
                hide-details
                clearable
              />
            </template>
            <!-- ListenBrainz has sitewide charts but no per-country ones,
             - so a range is the only thing to pick. -->
            <v-select
              v-else
              v-model="periodValue"
              :items="periodOptions"
              :label="periodLabel"
              variant="solo-filled"
              hide-details
            />
          </template>

          <!-- A combobox, not a select: these are only the common tags,
           - and both services have a tag for nearly anything. Typing
           - something that isn't in the list is a normal way to use this. -->
          <v-combobox
            v-if="op === 'genre'"
            v-model="genreTag"
            :items="GENRE_SUGGESTIONS"
            :label="$t('lastfm.genre')"
            :placeholder="$t('lastfm.genrePlaceholder')"
            variant="solo-filled"
            hide-details
          />

          <v-text-field
            v-if="op === 'artist'"
            v-model="artist"
            :label="$t('lastfm.artist')"
            variant="solo-filled"
            hide-details
          />

          <template v-if="op === 'mytop' || op === 'recommended'">
            <v-text-field
              v-model="username"
              :label="usernameLabel"
              :hint="usernameHint"
              persistent-hint
              variant="solo-filled"
            />
            <!-- The collaborative-filtering feed takes no range, so a
             - recommended list has nothing to pick here. -->
            <v-select
              v-if="op === 'mytop'"
              v-model="periodValue"
              :items="periodOptions"
              :label="periodLabel"
              variant="solo-filled"
              hide-details
            />
          </template>

          <div class="limit">
            <div class="limit__head">
              <span class="eyebrow-label">{{ $t('lastfm.limit') }}</span>
              <span class="limit__value">{{ limit }}</span>
            </div>
            <v-slider
              v-model="limit"
              :min="10"
              :max="200"
              :step="10"
              color="primary"
              hide-details
            />
          </div>

          <v-alert v-if="error" type="error" variant="tonal" density="compact">
            {{ error }}
          </v-alert>
        </div>

        <!-- Step 2: what the library turned out to have. -->
        <div v-else class="result">
          <div v-if="busy" class="progress">
            <p class="progress__label text-medium-emphasis">{{ progressLabel }}</p>
            <v-progress-linear
              :model-value="progressPercent"
              :indeterminate="progressTotal === 0"
              color="primary"
              rounded
            />
          </div>

          <template v-else>
            <div class="summary">
              <div class="summary__count">
                <span class="summary__found">{{ foundCount }}</span>
                <span class="summary__total text-medium-emphasis">/ {{ resolved.length }}</span>
              </div>
              <div class="summary__text">
                <p class="summary__label">{{ $t('lastfm.summaryFound') }}</p>
                <p class="text-body-small text-medium-emphasis">
                  {{ $t('lastfm.summaryHint') }}
                </p>
              </div>
            </div>

            <!-- A combobox, not a plain field: typing over the suggested
             - name is the common case, and picking an existing playlist
             - out of the list is what makes updating one possible at all.
             - v-autocomplete would not take a name that isn't in it. -->
            <v-combobox
              v-model="playlistNameValue"
              :items="playlistNames"
              :label="$t('common.name')"
              variant="solo-filled"
              hide-details
              class="name-field"
            />

            <!-- Only once the name really names an existing playlist. An
             - update is destructive in one of its two forms, so it is
             - never the silent default: the choice is made here. -->
            <div v-if="existingPlaylist" class="existing">
              <p class="setting-note text-body-small">
                {{ $t('lastfm.existingPlaylist', { name: existingPlaylist.name }) }}
              </p>
              <v-radio-group v-model="updateMode" hide-details density="compact">
                <v-radio value="append" :label="$t('lastfm.modeAppend')" />
                <v-radio value="replace" :label="$t('lastfm.modeReplace')" />
              </v-radio-group>
            </div>

            <v-alert v-if="error" type="error" variant="tonal" density="compact">
              {{ error }}
            </v-alert>

            <div class="beacon-panel beacon-panel--flush tracks-panel">
              <!-- Which column is which. Same grid as a row, so the two
               - headings sit exactly over the two sides; hidden on a
               - phone, where the pair stacks and the arrow says it. -->
              <div class="tracks-head">
                <span />
                <span class="column-label">{{ sourceColumnLabel }}</span>
                <span class="tracks-head__gap" />
                <span class="column-label">{{ $t('lastfm.columnLibrary') }}</span>
              </div>

              <ul class="tracks">
                <li
                  v-for="(entry, index) in resolved"
                  :key="index"
                  class="track"
                  :class="{ 'track--missing': !entry.match }"
                >
                  <!-- The chart position, so it counts every entry rather
                 - than only the found ones: number 5 is number 5 whether
                 - this library has it or not, and renumbering around the
                 - gaps would claim a ranking Last.fm never gave. -->
                  <span class="track__rank">{{ index + 1 }}</span>

                  <div class="track__side track__side--source">
                    <div class="track__names">
                      <span class="track__title">{{ entry.track.title }}</span>
                      <span class="track__artist text-body-small text-medium-emphasis">{{
                        entry.track.artist
                      }}</span>
                    </div>
                    <!-- One at a time: a missing track is looked up or
                     - fetched on its own, not as a batch. Only offered
                     - where the library has nothing - that is the track
                     - worth taking elsewhere. -->
                    <v-btn
                      v-if="!entry.match"
                      :icon="copiedIndex === index ? 'mdi-check' : 'mdi-content-copy'"
                      :color="copiedIndex === index ? 'success' : undefined"
                      variant="text"
                      size="small"
                      density="comfortable"
                      :aria-label="$t('lastfm.copyTrack')"
                      @click="copyTrack(entry, index)"
                    />
                  </div>

                  <v-icon
                    :icon="entry.match ? 'mdi-arrow-right' : 'mdi-close'"
                    :color="entry.match ? 'primary' : undefined"
                    size="16"
                    class="track__arrow"
                  />

                  <!-- What the library actually offered, side by side with
                 - what was asked for: the point at which a close match is
                 - either recognised as the right song or spotted as the
                 - wrong one. -->
                  <div v-if="entry.match" class="track__side track__side--found">
                    <cover-art
                      :cover-art-id="entry.match.song.coverArtId"
                      :size="40"
                      class="track__art"
                    />
                    <div class="track__names">
                      <span class="track__title">{{ entry.match.song.title }}</span>
                      <span class="track__artist text-body-small text-medium-emphasis">
                        {{ entry.match.song.artist
                        }}<template v-if="entry.match.song.album">
                          · {{ entry.match.song.album }}</template
                        >
                      </span>
                    </div>
                    <span
                      v-if="entry.match.confidence === 'close'"
                      class="track__note text-body-small text-medium-emphasis"
                    >
                      {{ $t('lastfm.closeMatch') }}
                    </span>
                  </div>
                  <div v-else class="track__side track__side--missing">
                    <span class="text-body-small text-medium-emphasis">
                      {{ $t('lastfm.missing') }}
                    </span>
                  </div>
                </li>
              </ul>
            </div>
          </template>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="step === 'result' && !busy" variant="text" @click="step = 'form'">
          {{ $t('lastfm.back') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          v-if="step === 'form'"
          color="primary"
          :disabled="!canSearch"
          :loading="busy"
          @click="search"
        >
          {{ $t('lastfm.search') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          :disabled="busy || foundCount === 0 || !playlistName.trim()"
          :loading="creating"
          @click="create"
        >
          {{ createLabel }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import CoverArt from './CoverArt.vue'
import { ConnectApiError } from '@/services/connect/http'
import { useLastfmStore } from '@/stores/lastfm'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import { getLastfmTracks, type LastfmOp, type LastfmPeriod } from '@/services/connect/lastfm'
import {
  getListenbrainzTracks,
  type ListenbrainzOp,
  type ListenbrainzPeriod,
} from '@/services/connect/listenbrainz'
import {
  playlistSongIds,
  resolveTracks,
  type ResolvedTrack,
} from '@/services/library/lastfmMatcher'
import type { Playlist } from '@/types/library'
import { LASTFM_COUNTRIES, type LastfmCountry } from '@/services/lastfmCountries'
import {
  loadRecentCountries,
  pinRecentCountries,
  saveRecentCountries,
  withRecentCountry,
  type CountryDividerItem,
} from '@/services/recentCountries'

/** Which service the builder reads from. Last.fm is the original and the
 * default; ListenBrainz shares the whole matcher/result/creation half and
 * differs only in which backend query it sends (see search()). */
type BuilderSource = 'lastfm' | 'listenbrainz'

// Common Last.fm tags, offered as suggestions rather than as the only
// choices - the field is a combobox, and anything typed into it is sent
// as-is. Deliberately international: the list a German listener wants is
// not the one a Spanish or Italian one wants, and a picker that leans on
// any single country reads as noise everywhere else. Grouped by family
// rather than sorted alphabetically - the combobox filters as you type, so
// the list is for browsing, and "House/Techno/Trance/Drum And Bass"
// together is easier to scan than those four scattered through the
// alphabet. Not translated: they go out as the search term itself, and
// Last.fm's tags are the English ones (its tag index is case-insensitive,
// so the capitalisation here is cosmetic).
const GENRE_SUGGESTIONS = [
  'Rock',
  'Classic Rock',
  'Alternative',
  'Indie',
  'Punk',
  'Metal',
  'Hard Rock',
  'Pop',
  'Dance',
  'Disco',
  'Electronic',
  'House',
  'Techno',
  'Trance',
  'Drum And Bass',
  'Dubstep',
  'Ambient',
  'Hip Hop',
  'Rap',
  'RnB',
  'Soul',
  'Funk',
  'Reggae',
  'Latin',
  'Jazz',
  'Blues',
  'Classical',
  'Country',
  'Folk',
  'Singer-Songwriter',
  'Soundtrack',
]

/**
 * Filling a new playlist from Last.fm: a chart, a genre's top tracks, one
 * artist's top tracks, or a listening history, matched against what this
 * library actually holds (services/library/lastfmMatcher.ts).
 *
 * Two steps in one dialog rather than a wizard, because the result is only
 * worth showing as something to approve: a chart import is a guess about
 * which songs were meant, and the list of what was and wasn't found is the
 * point at which that guess is either accepted or thrown away.
 */
export default {
  name: 'LastfmPlaylistDialog',
  components: { CoverArt },
  data() {
    return {
      GENRE_SUGGESTIONS,
      visible: false,
      step: 'form' as 'form' | 'result',
      busy: false,
      creating: false,
      error: '',

      source: 'lastfm' as BuilderSource,
      op: 'charts' as LastfmOp | ListenbrainzOp,
      chartScope: 'country' as 'country' | 'global',
      country: '',
      tag: '',
      artist: '',
      username: '',
      period: '1month' as LastfmPeriod,
      lbPeriod: 'month' as ListenbrainzPeriod,
      limit: 50,
      // Shared with the radio station directory (services/recentCountries)
      // - a country picked there is offered here too. Keyed by ISO code,
      // which is the one thing the two country lists agree on.
      recentCountryCodes: loadRecentCountries(),

      resolved: [] as ResolvedTrack[],
      playlistName: '',
      /** What to do when the name is an existing playlist's. Append is the
       * default because it cannot lose anything; replace is the one worth
       * choosing deliberately. */
      updateMode: 'append' as 'append' | 'replace',
      progressDone: 0,
      progressTotal: 0,
      /** Which missing row's copy button just flipped to a checkmark, and
       * the timer that flips it back. */
      copiedIndex: -1,
      copyResetTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      // Flipped when the dialog closes mid-search, so the worker loop in
      // resolveTracks() stops issuing lookups for a dialog nobody is
      // looking at any more.
      abortSignal: { aborted: false },
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    /** The autocomplete's clear button sets the model to null, the same
     * as the two comboboxes below. */
    countryValue: {
      get(): string {
        return this.country
      },
      set(value: string | null) {
        this.country = value ?? ''
      },
    },
    /** v-combobox hands back `null` when its field is cleared, which every
     * `.trim()` on the way out would throw on. Normalised here, once. */
    genreTag: {
      get(): string {
        return this.tag
      },
      set(value: string | null) {
        this.tag = value ?? ''
      },
    },
    lastfmStore() {
      return useLastfmStore()
    },
    listenbrainzStore() {
      return useListenbrainzStore()
    },
    dialogTitle(): string {
      return this.source === 'listenbrainz'
        ? this.$t('listenbrainz.title')
        : this.$t('lastfm.title')
    },
    sourceColumnLabel(): string {
      return this.source === 'listenbrainz'
        ? this.$t('listenbrainz.columnListenbrainz')
        : this.$t('lastfm.columnLastfm')
    },
    usernameLabel(): string {
      return this.source === 'listenbrainz'
        ? this.$t('listenbrainz.username')
        : this.$t('lastfm.username')
    },
    usernameHint(): string {
      return this.source === 'listenbrainz'
        ? this.$t('listenbrainz.usernameHint')
        : this.$t('lastfm.usernameHint')
    },
    periodLabel(): string {
      return this.source === 'listenbrainz'
        ? this.$t('listenbrainz.period')
        : this.$t('lastfm.period')
    },
    sourceOptions(): { title: string; value: LastfmOp | ListenbrainzOp }[] {
      if (this.source === 'listenbrainz') {
        return [
          { title: this.$t('listenbrainz.sourceCharts'), value: 'charts' },
          { title: this.$t('listenbrainz.sourceGenre'), value: 'genre' },
          { title: this.$t('listenbrainz.sourceArtist'), value: 'artist' },
          { title: this.$t('listenbrainz.sourceMyTop'), value: 'mytop' },
          { title: this.$t('listenbrainz.sourceRecommended'), value: 'recommended' },
        ]
      }
      return [
        { title: this.$t('lastfm.sourceCharts'), value: 'charts' },
        { title: this.$t('lastfm.sourceGenre'), value: 'genre' },
        { title: this.$t('lastfm.sourceArtist'), value: 'artist' },
        { title: this.$t('lastfm.sourceMyTop'), value: 'mytop' },
      ]
    },
    chartScopeOptions(): { title: string; value: string }[] {
      return [
        { title: this.$t('lastfm.chartCountry'), value: 'country' },
        { title: this.$t('lastfm.chartGlobal'), value: 'global' },
      ]
    },
    periodOptions(): { title: string; value: LastfmPeriod | ListenbrainzPeriod }[] {
      if (this.source === 'listenbrainz') {
        return [
          { title: this.$t('listenbrainz.periodWeek'), value: 'week' },
          { title: this.$t('listenbrainz.periodMonth'), value: 'month' },
          { title: this.$t('listenbrainz.periodQuarter'), value: 'quarter' },
          { title: this.$t('listenbrainz.periodHalfYearly'), value: 'half_yearly' },
          { title: this.$t('listenbrainz.periodYear'), value: 'year' },
          { title: this.$t('listenbrainz.periodAllTime'), value: 'all_time' },
        ]
      }
      return [
        { title: this.$t('lastfm.period7day'), value: '7day' },
        { title: this.$t('lastfm.period1month'), value: '1month' },
        { title: this.$t('lastfm.period3month'), value: '3month' },
        { title: this.$t('lastfm.period6month'), value: '6month' },
        { title: this.$t('lastfm.period12month'), value: '12month' },
        { title: this.$t('lastfm.periodOverall'), value: 'overall' },
      ]
    },
    /** One v-model for the range picker, whichever service is active — the
     * template shows a single select and should not have to know which
     * field it writes to. */
    periodValue: {
      get(): LastfmPeriod | ListenbrainzPeriod {
        return this.source === 'listenbrainz' ? this.lbPeriod : this.period
      },
      set(value: LastfmPeriod | ListenbrainzPeriod) {
        if (this.source === 'listenbrainz') this.lbPeriod = value as ListenbrainzPeriod
        else this.period = value as LastfmPeriod
      },
    },
    canSearch(): boolean {
      if (this.busy) return false
      if (this.op === 'genre') return !!this.tag.trim()
      if (this.op === 'artist') return !!this.artist.trim()
      if (this.op === 'mytop' || this.op === 'recommended') return !!this.username.trim()
      if (this.op === 'charts' && this.source === 'lastfm' && this.chartScope === 'country') {
        return !!this.country.trim()
      }
      return true
    },
    foundCount(): number {
      return this.resolved.filter((entry) => entry.match).length
    },
    countryOptions(): LastfmCountry[] {
      return LASTFM_COUNTRIES
    },
    /** The recently picked countries first, then the rest alphabetically.
     * The shared list holds ISO codes, while this picker's value is the
     * name Last.fm wants - the mapping happens through the options, which
     * carry both. */
    countryItems(): (LastfmCountry | CountryDividerItem)[] {
      return pinRecentCountries(this.countryOptions, this.recentCountryCodes)
    },
    /** The picked country as it should read in a playlist name: the
     * friendly label, not the API's own spelling ("Libya", not "Libyan
     * Arab Jamahiriya"). */
    countryName(): string {
      return (
        this.countryOptions.find((option) => option.value === this.country)?.name ?? this.country
      )
    },
    playlistNames(): string[] {
      return this.libraryStore.playlists.map((playlist) => playlist.name)
    },
    /** v-combobox hands back `null` when cleared, the same as the genre
     * field above. */
    playlistNameValue: {
      get(): string {
        return this.playlistName
      },
      set(value: string | null) {
        this.playlistName = value ?? ''
      },
    },
    /** The playlist this name already belongs to, if any. Compared
     * case-insensitively on the trimmed name, because "Last.fm Charts" and
     * "last.fm charts" are the same playlist to anyone reading the list -
     * and creating a second one differing only in case is never what was
     * meant. Two playlists really sharing a name (which Subsonic permits)
     * resolve to the first; there is nothing here to tell them apart by. */
    existingPlaylist(): Playlist | null {
      const wanted = this.playlistName.trim().toLowerCase()
      if (!wanted) return null
      return (
        this.libraryStore.playlists.find(
          (playlist) => playlist.name.trim().toLowerCase() === wanted,
        ) ?? null
      )
    },
    createLabel(): string {
      if (!this.existingPlaylist) return this.$t('common.create')
      return this.updateMode === 'replace'
        ? this.$t('lastfm.replaceAction')
        : this.$t('lastfm.appendAction')
    },
    progressPercent(): number {
      if (!this.progressTotal) return 0
      return (this.progressDone / this.progressTotal) * 100
    },
    progressLabel(): string {
      if (!this.progressTotal) {
        return this.source === 'listenbrainz'
          ? this.$t('listenbrainz.fetching')
          : this.$t('lastfm.fetching')
      }
      return this.$t('lastfm.matching', {
        done: this.progressDone,
        total: this.progressTotal,
      })
    },
  },
  watch: {
    visible(open: boolean) {
      if (open) {
        this.abortSignal = { aborted: false }
      } else {
        this.abortSignal.aborted = true
      }
    },
  },
  beforeUnmount() {
    clearTimeout(this.copyResetTimer)
  },
  methods: {
    open(source: BuilderSource = 'lastfm'): void {
      this.source = source
      this.step = 'form'
      this.op = 'charts'
      this.error = ''
      this.resolved = []
      this.updateMode = 'append'
      this.username =
        source === 'listenbrainz' ? this.listenbrainzStore.username : this.lastfmStore.username
      this.visible = true
      // The name field matches against these, so they have to be loaded
      // even when the dialog was opened somewhere other than the playlist
      // list. Cached, so this is usually free. Fire-and-forget: a failure
      // only costs the name suggestions, and the store has already recorded
      // it - without the catch this would surface as an unhandled rejection.
      void this.libraryStore.fetchPlaylists().catch(() => {})
    },

    /** Stores the country just searched with, so it sits at the top of
     * the picker next time - here and in the radio station directory.
     * Recorded on use rather than on selection: a country clicked through
     * while browsing the list is not one that was meant. */
    rememberCountry(): void {
      if (this.source !== 'lastfm' || this.op !== 'charts' || this.chartScope !== 'country') return
      const picked = this.countryOptions.find((option) => option.value === this.country)
      if (!picked) return
      this.recentCountryCodes = withRecentCountry(this.recentCountryCodes, picked.code)
      saveRecentCountries(this.recentCountryCodes)
    },

    /** Puts one track on the clipboard as "Artist - Title", the shape a
     * search box or a download program expects. Per track rather than in
     * bulk: a missing track is looked up on its own. The button flips to a
     * checkmark for a moment - a failure only logs, the same as the other
     * copy buttons in the app, and the checkmark simply not appearing says
     * enough. */
    async copyTrack(entry: ResolvedTrack, index: number): Promise<void> {
      try {
        await navigator.clipboard.writeText(`${entry.track.artist} - ${entry.track.title}`)
        clearTimeout(this.copyResetTimer)
        this.copiedIndex = index
        this.copyResetTimer = setTimeout(() => {
          this.copiedIndex = -1
        }, 2000)
      } catch (error) {
        console.error('[lastfm] Failed to copy the track:', error)
      }
    },

    /** The name a playlist gets before anyone edits it — descriptive
     * enough that three imports don't sit in the list as "Last.fm",
     * "Last.fm (1)" and "Last.fm (2)". */
    defaultName(): string {
      if (this.source === 'listenbrainz') {
        if (this.op === 'genre') {
          return this.$t('listenbrainz.nameGenre', { tag: this.tag.trim() })
        }
        if (this.op === 'artist') {
          return this.$t('listenbrainz.nameArtist', { artist: this.artist.trim() })
        }
        if (this.op === 'mytop') {
          const period = this.periodOptions.find((entry) => entry.value === this.lbPeriod)
          return this.$t('listenbrainz.nameMyTop', { period: period?.title ?? '' })
        }
        if (this.op === 'recommended') return this.$t('listenbrainz.nameRecommended')
        return this.$t('listenbrainz.nameCharts')
      }
      if (this.op === 'genre') return this.$t('lastfm.nameGenre', { tag: this.tag.trim() })
      if (this.op === 'artist') return this.$t('lastfm.nameArtist', { artist: this.artist.trim() })
      if (this.op === 'mytop') {
        const period = this.periodOptions.find((entry) => entry.value === this.period)
        return this.$t('lastfm.nameMyTop', { period: period?.title ?? '' })
      }
      return this.chartScope === 'global'
        ? this.$t('lastfm.nameGlobalCharts')
        : this.$t('lastfm.nameCountryCharts', { country: this.countryName.trim() })
    },

    /** The backend's own reason when it sent one (an unknown Last.fm
     * username is the common case, and "User not found" says far more than
     * a generic failure would), otherwise the caller's fallback. */
    messageFor(error: unknown, fallback: string): string {
      if (error instanceof ConnectApiError) {
        const detail = (error.body as { detail?: unknown })?.detail
        if (typeof detail === 'string' && detail) return detail
      }
      return fallback
    },

    async search(): Promise<void> {
      this.busy = true
      this.error = ''
      this.step = 'result'
      this.resolved = []
      this.progressDone = 0
      this.progressTotal = 0

      try {
        const tracks =
          this.source === 'listenbrainz'
            ? await getListenbrainzTracks({
                op: this.op as ListenbrainzOp,
                limit: this.limit,
                tag: this.tag.trim(),
                artist: this.artist.trim(),
                username: this.username.trim(),
                period: this.lbPeriod,
              })
            : await getLastfmTracks({
                op: this.op as LastfmOp,
                limit: this.limit,
                country:
                  this.op === 'charts' && this.chartScope === 'country' ? this.country.trim() : '',
                tag: this.tag.trim(),
                artist: this.artist.trim(),
                username: this.username.trim(),
                period: this.period,
              })

        // ListenBrainz deliberately does not write the name back: its
        // settings value also drives Home's "Recommended for you" shelf,
        // and typing a name here to look at someone else's charts must not
        // silently repoint that shelf. Last.fm has no such second reader,
        // so it keeps remembering what was typed.
        if (this.source !== 'listenbrainz') {
          if (this.op === 'mytop') this.lastfmStore.setUsername(this.username)
          this.rememberCountry()
        }
        if (this.abortSignal.aborted) return

        if (tracks.length === 0) {
          this.error =
            this.source === 'listenbrainz'
              ? this.$t('listenbrainz.noTracks')
              : this.$t('lastfm.noTracks')
          this.step = 'form'
          return
        }

        this.progressTotal = tracks.length
        const client = this.libraryStore.client()
        this.resolved = await resolveTracks(
          tracks,
          async (query, limit) => (await client.search3(query, limit, 0, 0)).songs,
          (done) => {
            this.progressDone = done
          },
          this.abortSignal,
        )
        this.playlistName = this.defaultName()
      } catch (error) {
        this.error = this.messageFor(
          error,
          this.source === 'listenbrainz'
            ? this.$t('listenbrainz.failed')
            : this.$t('lastfm.failed'),
        )
        this.step = 'form'
      } finally {
        this.busy = false
      }
    },

    async create(): Promise<void> {
      const ids = playlistSongIds(this.resolved)
      if (!ids.length) return

      this.creating = true
      this.error = ''
      try {
        const existing = this.existingPlaylist
        if (!existing) {
          await this.libraryStore.createPlaylist(this.playlistName.trim(), ids)
        } else if (this.updateMode === 'replace') {
          await this.libraryStore.restorePlaylistSongs(existing.id, ids)
        } else {
          await this.appendToPlaylist(existing, ids)
        }
        this.visible = false
      } catch (error) {
        this.error = this.messageFor(error, this.$t('lastfm.createFailed'))
      } finally {
        this.creating = false
      }
    },

    /** Adds only what the playlist does not already hold. The list this
     * dialog produces overlaps heavily with a chart imported last week, and
     * appending it wholesale would put a second copy of every one of those
     * songs in there. */
    async appendToPlaylist(playlist: Playlist, ids: string[]): Promise<void> {
      const full = await this.libraryStore.fetchPlaylist(playlist.id)
      const present = new Set(full.songs.map((song) => song.id))
      const missing = ids.filter((id) => !present.has(id))
      // Everything found is already in there: nothing to write, and
      // sending an empty update would report a change that did not happen.
      if (!missing.length) return
      await this.libraryStore.addToPlaylist(playlist.id, missing)
    },
  },
}
</script>

<style scoped>
.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.dialog-head__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* The serif face the styleguide reserves for a dialog's subject. One per
 * dialog: the list below stays on the body scale. */
.dialog-head__title {
  font-size: 1.5rem;
}

.form,
.result {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.limit__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.limit__value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 2rem 0;
}

.progress__label {
  font-size: 0.875rem;
}

/* The ratio is the headline of this step, so it is set as a figure rather
 * than buried in a sentence. */
.summary {
  display: flex;
  align-items: center;
  gap: 1rem;
  border-radius: 14px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(255, 255, 255, 0.02);
  padding: 14px 18px;
}

.summary__count {
  display: flex;
  align-items: baseline;
  gap: 0.2rem;
  font-variant-numeric: tabular-nums;
}

.summary__found {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
}

.summary__total {
  font-size: 1rem;
}

.summary__text {
  flex: 1;
  min-width: 0;
}

.summary__label {
  font-weight: 600;
}

.existing {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.setting-note {
  color: rgb(var(--v-theme-warning));
}

.tracks-panel {
  /* The rows carry their own padding, and their separators have to reach
   * both edges - which is what --flush is for. */
  overflow: hidden;
}

.tracks {
  display: flex;
  flex-direction: column;
  list-style: none;
  padding: 0;
}

.tracks-head,
.track {
  display: grid;
  /* Rank, then the two sides either side of the arrow. The sides share
   * the remaining width evenly (1fr each, min-width 0 below) so neither
   * a long Last.fm title nor a long album name can squeeze the other
   * out of view. */
  grid-template-columns: 1.75rem 1fr auto 1fr;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 18px;
}

.tracks-head {
  border-bottom: 1px solid var(--beacon-hairline);
  padding-top: 10px;
  padding-bottom: 10px;
  background: rgba(255, 255, 255, 0.02);
}

/* The eyebrow's shape, in muted white rather than amber: amber is the
 * signal colour, and a pair of column labels is not a signal (styleguide,
 * "Column headings"). */
.column-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
}

/* The arrow column has no heading of its own, so the library heading has
 * to clear the width the arrow takes up in every row below it. */
.tracks-head__gap {
  width: 16px;
}

/* Between siblings only - a border after the last row would underline the
 * end of the list instead of separating anything. */
.track + .track {
  border-top: 1px solid var(--beacon-hairline);
}

.track {
  transition: background-color 120ms ease;
}

.track:hover {
  background: var(--beacon-hover);
}

/* A track the library does not have is not an error, it is simply not
 * there - so it steps back rather than colouring itself red. */
.track--missing {
  opacity: 0.62;
}

/* ... but its copy button has to be readable to be found, so hovering the
 * row brings the whole thing back to full strength. */
.track--missing:hover {
  opacity: 1;
}

.track__rank {
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.55);
  text-align: right;
}

.track__side {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.track__side--found {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

/* The source side carries the copy button beside the name for a track the
 * library does not have. */
.track__side--source {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

.track__names {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.track__art {
  border-radius: 4px;
  flex-shrink: 0;
}

.track__title,
.track__artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track__arrow {
  flex-shrink: 0;
}

.track__note {
  flex-shrink: 0;
}

/* A phone has no room for two columns side by side: the pair stacks, and
 * the arrow turns downwards to keep saying which way it reads. */
@media (max-width: 599px) {
  .tracks-head {
    display: none;
  }

  .track {
    grid-template-columns: 1.5rem 1fr;
    grid-template-areas:
      'rank source'
      'rank arrow'
      'rank found';
    gap: 0.25rem 0.5rem;
    padding: 0.6rem 14px;
  }

  .track__rank {
    grid-area: rank;
    align-self: start;
    padding-top: 0.1rem;
  }

  .track__side:first-of-type {
    grid-area: source;
  }

  .track__arrow {
    grid-area: arrow;
    justify-self: start;
    rotate: 90deg;
  }

  .track__side--found,
  .track__side--missing {
    grid-area: found;
  }

  .summary {
    padding: 12px 14px;
  }
}
</style>
