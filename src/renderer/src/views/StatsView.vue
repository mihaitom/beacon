<template>
  <v-container fluid class="stats-page">
    <div v-if="accountItems.length > 1" class="stats-page__account">
      <v-select
        v-model="viewedAccount"
        :items="accountItems"
        :aria-label="$t('stats.accountPicker')"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        prepend-inner-icon="mdi-account-outline"
      />
    </div>

    <div v-if="debugMoments.length" class="stats-page__debug">
      <v-btn
        v-for="entry in debugMoments"
        :key="`${entry.kind}${entry.value}`"
        size="x-small"
        variant="tonal"
        :disabled="moment !== null"
        @click="playDebugMoment(entry)"
      >
        {{ entry.tier ?? entry.kind }} {{ entry.value }}
      </v-btn>
    </div>

    <page-loader v-if="loading && songs.length === 0" />

    <template v-else>
      <stats-hero
        ref="hero"
        :listening-seconds="listeningTime"
        :plays="heroPlays"
        :library-share="isOwnView && songs.length ? formatShare(playedCount, songs.length) : null"
        :streak="streak.current"
        :cover-url="heroCover"
        :label-url="recordLabel"
        :passed-plays="isOwnView ? passedPlays : 0"
        :playing="playbackStore.isPlaying"
        :other-account="viewedAccount"
        :since="sinceLabel"
        :fresh="fresh"
        :line="heroLine"
        :landed-record="landedRecord"
        :timestamps="history?.timestamps ?? []"
        :seen-records="
          debugHeldRecords ?? (isOwnView ? (ownHistory?.milestones?.records ?? null) : null)
        "
      />

      <div class="stats-page__columns">
        <empty-state
          v-if="chartsEmpty"
          icon="mdi-chart-box-outline"
          :title="isOwnView ? $t('stats.noPlaysYet') : $t('stats.otherEmpty')"
        />
        <stats-charts v-else :charts="charts" :since="isOwnView ? null : sinceLabel" />

        <stats-year
          :timestamps="history?.timestamps ?? []"
          :streak="streak"
          :today="today"
          :import-status="isOwnView ? importStatus : null"
          :options="offeredImports"
          @start-import="beginImport"
        />
      </div>

      <stats-collection
        :facts="collectionFacts"
        :decades="decadeBreakdown"
        :quality="qualityBreakdown"
        :formats="formatBreakdown.slice(0, TOP_FORMATS)"
      />
    </template>

    <stats-moment
      v-if="moment"
      :moment="moment"
      :subtitle="momentSubtitle"
      :target="momentTarget"
      @closed="onMomentClosed"
    />
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLastfmStore } from '@/stores/lastfm'
import { useLibraryStore } from '@/stores/library'
import { useListenbrainzStore } from '@/stores/listenbrainz'
import { usePlaybackStore } from '@/stores/playback'
import EmptyState from '@/components/EmptyState.vue'
import PageLoader from '@/components/PageLoader.vue'
import StatsCharts, { type ChartItem, type ChartKind } from '@/components/stats/StatsCharts.vue'
import StatsCollection from '@/components/stats/StatsCollection.vue'
import StatsHero from '@/components/stats/StatsHero.vue'
import StatsMoment from '@/components/stats/StatsMoment.vue'
import StatsYear from '@/components/stats/StatsYear.vue'
import { chartMovement } from '@/services/library/chartMovement'
import { streaks } from '@/services/library/listeningYear'
import { STACK_COVERS } from '@/services/library/stackCovers'
import {
  importAction,
  importOptions,
  type ImportOption,
} from '@/services/library/playHistoryImport'
import {
  nextMoment,
  reachedMilestones,
  recordDetails,
  recordProgress,
  type MilestoneValues,
  type Moment,
  milestoneMoment,
} from '@/services/library/statsMilestones'
import {
  getImportStatus,
  getPlayHistoryAccounts,
  getPlayHistorySummary,
  saveMilestones,
  startImport,
  type PlayHistoryImportStatus,
  type PlayHistorySummary,
  type PlayHistoryTop,
} from '@/services/connect/playHistory'
import { pollingAllowed } from '@/services/connect/pollGate'
import type { Artist, Song } from '@/types/library'
import { lineOfTheDay, statsLines } from '@/services/library/statsLines'

const TOP_N = 8
const TOP_FORMATS = 3
const DAY_SECONDS = 86_400
// Comparing against "before the last 30 days" says nothing until the log
// actually covers them: every play would otherwise look like a climb.
const MOVEMENT_DAYS = 30
// After the page's own entrance, so the two do not compete.
const MOMENT_DELAY_MS = 2000
const FRESH_MS = 1000
// One of each kind and size, for looking at the animations.
const DEBUG_MOMENTS: Moment[] = [
  // The first of each metal.
  ...[100, 500, 1000, 2500, 10000].map((value) => milestoneMoment('hours', value)),
  ...[7, 30, 100, 300, 500].map((value) => milestoneMoment('streak', value)),
  // The first record of each tier.
  ...[1, 5, 8, 10, 13].map((value): Moment => ({
    kind: 'pressing',
    value,
    size: 'l',
    tier: recordDetails(value).tier,
  })),
]
const IMPORT_POLL_MS = 2000
const QUALITY_ORDER: AudioQuality[] = ['hires', 'lossless', 'lossy']

const LOSSLESS_FORMATS = new Set(['flac', 'alac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'tta'])
const DSD_FORMATS = new Set(['dsf', 'dff'])
// ALAC ships as .m4a just like AAC, so the suffix alone can't tell them
// apart. AAC tops out at 320 kbps in practice, ALAC of CD audio rarely goes
// below ~600 - anything past this is lossless.
const ALAC_MIN_BITRATE = 500

type AudioQuality = 'hires' | 'lossless' | 'lossy'

/** Hi-Res means more than CD: past 16 bit or past 48 kHz. Null when the
 * server reports no format at all. */
function audioQuality(song: Song): AudioQuality | null {
  const format = song.format?.toLowerCase()
  if (!format) return null
  if (DSD_FORMATS.has(format)) return 'hires'
  const lossless =
    LOSSLESS_FORMATS.has(format) || (format === 'm4a' && (song.bitRate ?? 0) >= ALAC_MIN_BITRATE)
  if (!lossless) return 'lossy'
  return (song.bitDepth ?? 0) > 16 || (song.sampleRate ?? 0) > 48000 ? 'hires' : 'lossless'
}

/** Aggregates `songs` by `keyFn` (album/artist id, genre name, format,
 * ...), summing playCount per group — the shared shape every "top N by
 * plays" ranking below needs, just with a different grouping key and
 * label/link per caller. */
function aggregateByPlays(
  songs: Song[],
  keyFn: (song: Song) => string | null,
  labelFn: (song: Song) => string,
): Map<string, { label: string; plays: number; songCount: number; coverArtId: string | null }> {
  const groups = new Map<
    string,
    { label: string; plays: number; songCount: number; coverArtId: string | null }
  >()
  for (const song of songs) {
    const key = keyFn(song)
    if (!key) continue
    const entry = groups.get(key) ?? {
      label: labelFn(song),
      plays: 0,
      songCount: 0,
      // From the first song seen for this group — every song on the same
      // album shares the same cover, so it doesn't matter which one "wins".
      coverArtId: song.coverArtId,
    }
    entry.plays += song.playCount || 0
    entry.songCount += 1
    groups.set(key, entry)
  }
  return groups
}

export default {
  name: 'StatsView',
  components: {
    EmptyState,
    PageLoader,
    StatsCharts,
    StatsCollection,
    StatsHero,
    StatsMoment,
    StatsYear,
  },
  data() {
    return {
      // Fixed per visit, so a day does not roll over under the listener and
      // the tests can pin it with fake timers.
      now: Date.now(),
      TOP_FORMATS,
      ownHistory: null as PlayHistorySummary | null,
      otherHistory: null as PlayHistorySummary | null,
      /** Null is this listener's own page. */
      viewedAccount: null as string | null,
      accounts: [] as string[],
      importStatus: null as PlayHistoryImportStatus | null,
      lastfmConfigured: false,
      moment: null as Moment | null,
      /** What the moment on screen will have made seen, once it has landed. */
      momentReached: null as MilestoneValues | null,
      fresh: null as Moment['kind'] | null,
      landedRecord: null as number | null,
      /** A debug pressing: that record stays off the shelf until it lands. */
      debugHeldRecords: null as number | null,
      /** Whether this load of the log has been compared with the milestones. */
      milestonesChecked: false,
      momentTimer: 0,
      freshTimer: 0,
      importTimer: 0,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    authStore() {
      return useAuthStore()
    },
    loading(): boolean {
      return this.libraryStore.loading
    },
    songs(): Song[] {
      return this.libraryStore.allSongs
    },
    isOwnView(): boolean {
      return this.viewedAccount === null
    },
    history(): PlayHistorySummary | null {
      return this.isOwnView ? this.ownHistory : this.otherHistory
    },
    today(): Date {
      return new Date(this.now)
    },
    streak(): { current: number; longest: number } {
      return streaks(this.history?.timestamps ?? [], this.today)
    },
    accountItems(): { title: string; value: string | null }[] {
      const own = this.authStore.username
      return [
        { title: this.$t('stats.accountOwn'), value: null },
        ...this.accounts
          .filter((name) => name !== own)
          .map((name) => ({ title: name, value: name })),
      ]
    },
    heroPlays(): number {
      return this.isOwnView ? this.totalPlays : (this.history?.total ?? 0)
    },
    heroCover(): string | null {
      const cover = this.isOwnView
        ? this.topAlbums[0]?.coverArtId
        : this.history?.top.albums.find((album) => album.cover_art_id)?.cover_art_id
      return cover ? this.libraryStore.client().coverArtUrl(cover, 300) : null
    },
    /** The record plays what is playing; with nothing on, it stays the top
     * album the page is built around. Someone else's page keeps theirs. */
    recordLabel(): string | null {
      const cover = this.isOwnView ? this.playbackStore.currentSong?.coverArtId : null
      return cover ? this.libraryStore.client().coverArtUrl(cover, 300) : null
    },
    /** When another account's log starts, which is what their figures mean. */
    sinceLabel(): string | null {
      const first = this.history?.timestamps[0]
      if (this.isOwnView || first === undefined) return null
      return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: 'medium' }).format(
        new Date(first * 1000),
      )
    },
    totalSongs(): number {
      return this.songs.length
    },
    totalArtists(): number {
      return new Set(this.songs.map((t) => t.artistId).filter(Boolean)).size
    },
    totalAlbums(): number {
      return new Set(this.songs.map((t) => t.albumId).filter(Boolean)).size
    },
    totalGenres(): number {
      return new Set(this.songs.map((t) => t.genre).filter(Boolean)).size
    },
    libraryDuration(): number {
      return this.songs.reduce((sum, t) => sum + (t.duration || 0), 0)
    },
    totalPlays(): number {
      return this.songs.reduce((sum, t) => sum + (t.playCount || 0), 0)
    },
    // duration × playCount is an estimate: a play counts once past the
    // scrobble threshold, not necessarily start to finish. It is all-time,
    // which the log (a year at most) cannot be.
    listeningTime(): number {
      return this.songs.reduce((sum, t) => sum + (t.duration || 0) * (t.playCount || 0), 0)
    },
    storageBytes(): number {
      return this.songs.reduce((sum, t) => sum + (t.size || 0), 0)
    },
    playedCount(): number {
      return this.songs.filter((t) => (t.playCount || 0) > 0).length
    },
    ratings(): { count: number; average: number } {
      const rated = this.songs.filter((t) => t.rating > 0)
      if (rated.length === 0) return { count: 0, average: 0 }
      const total = rated.reduce((sum, t) => sum + t.rating, 0)
      return { count: rated.length, average: total / rated.length }
    },
    collectionFacts(): { value: string; label: string }[] {
      const facts = [
        { value: this.formatNumber(this.totalSongs), label: this.$t('stats.songs') },
        { value: this.formatNumber(this.totalArtists), label: this.$t('stats.artists') },
        { value: this.formatNumber(this.totalAlbums), label: this.$t('stats.albums') },
        { value: this.formatNumber(this.totalGenres), label: this.$t('stats.genres') },
        {
          value: this.formatBigDuration(this.libraryDuration),
          label: this.$t('stats.libraryDuration'),
        },
      ]
      if (this.storageBytes > 0) {
        facts.push({ value: this.formatBytes(this.storageBytes), label: this.$t('stats.storage') })
      }
      // Favourites and ratings are the signed-in account's, not the viewed one's.
      if (this.isOwnView) {
        facts.push({
          value: this.formatNumber(this.libraryStore.starred.songs.length),
          label: this.$t('stats.favoriteSongs'),
        })
        if (this.ratings.count > 0) {
          facts.push({
            value: this.formatRating(this.ratings.average),
            label: this.$t('stats.averageRating'),
          })
        }
      }
      return facts
    },
    /** Rank changes need a log that reaches back over the whole window. */
    recentPlays(): Record<string, number> | null {
      const since = this.ownHistory?.live_since
      if (!since || this.now / 1000 - since < MOVEMENT_DAYS * DAY_SECONDS) return null
      return this.ownHistory?.recent_plays ?? null
    },
    topSongs(): ChartItem[] {
      return this.withMovement(
        [...this.songs]
          .filter((t) => t.playCount > 0)
          .sort((a, b) => b.playCount - a.playCount)
          .slice(0, TOP_N)
          .map((t) => ({
            id: t.id,
            label: t.title,
            sublabel: t.artist,
            value: t.playCount,
            valueLabel: this.formatNumber(t.playCount),
            // No standalone song page in this app; the album is the closest.
            to: `/albums/${t.albumId}`,
            coverArtId: t.coverArtId,
          })),
        (t) => t.id,
      )
    },
    // A song's cover is its album's art, which beside an artist's name would
    // be misleading, so artists draw from the artist list instead.
    artistsById(): Map<string, Artist> {
      return new Map(this.libraryStore.artists.map((a) => [a.id, a]))
    },
    topArtists(): ChartItem[] {
      const artistKey = (t: Song): string | null => t.artistId || null
      const groups = aggregateByPlays(this.songs, artistKey, (t) => t.artist)
      const items = this.topFromGroups(groups, (id) => `/artists/${id}`).map((item) => {
        const artist = this.artistsById.get(item.id)
        return {
          ...item,
          // A song's own artist field is its whole credit ("A, B & C").
          label: artist?.name ?? item.label,
          // Null, not undefined, while the list loads: the art column stays
          // and the rows do not reflow when it arrives.
          coverArtId: artist?.coverArtId ?? null,
          imageUrl: artist?.imageUrl ?? null,
        }
      })
      return this.withMovement(items, artistKey)
    },
    topAlbums(): ChartItem[] {
      const albumKey = (t: Song): string | null => t.albumId || null
      const groups = aggregateByPlays(this.songs, albumKey, (t) => t.album)
      return this.withMovement(
        this.topFromGroups(groups, (id) => `/albums/${id}`, true),
        albumKey,
      )
    },
    topGenres(): ChartItem[] {
      const genreKey = (t: Song): string | null => t.genre
      const groups = aggregateByPlays(this.songs, genreKey, (t) => t.genre ?? '')
      return this.withMovement(
        this.topFromGroups(groups, (name) => `/genres/${encodeURIComponent(name)}`),
        genreKey,
      )
    },
    charts(): Record<ChartKind, ChartItem[]> {
      if (this.isOwnView) {
        return {
          songs: this.topSongs,
          artists: this.topArtists,
          albums: this.topAlbums,
          genres: this.withCrate(this.topGenres),
        }
      }
      const top = this.history?.top
      return {
        songs: (top?.songs ?? []).map((item) => this.logItem(item, 'songs')),
        artists: (top?.artists ?? []).map((item) => this.logItem(item, 'artists')),
        albums: (top?.albums ?? []).map((item) => this.logItem(item, 'albums')),
        genres: this.withCrate((top?.genres ?? []).map((item) => this.logItem(item, 'genres'))),
      }
    },
    chartsEmpty(): boolean {
      return Object.values(this.charts).every((items) => items.length === 0)
    },
    formatBreakdown(): ChartItem[] {
      const counts = new Map<string, number>()
      for (const t of this.songs) {
        const key = (t.format || '—').toUpperCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([format, count]) => this.shareItem(format, format, count))
    },
    qualityBreakdown(): ChartItem[] {
      const counts = new Map<AudioQuality, number>()
      for (const t of this.songs) {
        const quality = audioQuality(t)
        if (quality) counts.set(quality, (counts.get(quality) ?? 0) + 1)
      }
      return QUALITY_ORDER.filter((quality) => counts.has(quality)).map((quality) =>
        this.shareItem(quality, this.$t(`stats.quality.${quality}`), counts.get(quality) ?? 0),
      )
    },
    // Songs with no year tag are left out rather than lumped into an
    // "unknown" bucket sized by tagging gaps. Oldest first: it is a timeline.
    decadeBreakdown(): ChartItem[] {
      const counts = new Map<number, number>()
      for (const t of this.songs) {
        if (!t.year) continue
        const decade = Math.floor(t.year / 10) * 10
        counts.set(decade, (counts.get(decade) ?? 0) + 1)
      }
      return [...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([decade, count]) =>
          this.shareItem(String(decade), this.$t('stats.decade', { decade }), count),
        )
    },
    /** The last round number of plays, marked on the record. */
    passedPlays(): number {
      return reachedMilestones(this.milestoneValues).plays
    },
    milestoneValues(): MilestoneValues {
      return {
        plays: this.totalPlays,
        hours: Math.floor(this.listeningTime / 3600),
        streak: streaks(this.ownHistory?.timestamps ?? [], this.today).current,
        records: recordProgress(this.totalPlays).finished,
      }
    },
    /** Both halves of a milestone have to be in: a comparison against a
     * library still loading would set the baseline too low. */
    milestonesReady(): boolean {
      return (
        this.ownHistory !== null &&
        this.ownHistory.available &&
        this.songs.length > 0 &&
        this.libraryStore.allSongsLoaded &&
        !this.loading
      )
    },
    /** Not until the library and the log are both in: it would change under
     * the reader as each arrives. */
    heroLine(): string | null {
      if (!this.isOwnView || !this.libraryStore.allSongsLoaded || !this.ownHistory) return null
      const line = lineOfTheDay(
        statsLines({
          songs: this.songs,
          timestamps: this.ownHistory.timestamps,
          today: this.today,
          locale: this.$i18n.locale,
        }),
        this.today,
      )
      return line && this.$t(`stats.heroLines.${line.key}`, line.params)
    },
    /** Only when running from source; a build replaces the condition. */
    debugMoments(): Moment[] {
      return import.meta.env.DEV ? DEBUG_MOMENTS : []
    },
    momentSubtitle(): string {
      if (!this.moment) return ''
      const { kind, value } = this.moment
      if (kind === 'pressing') {
        const { tier, holds } = recordDetails(value)
        return this.$t('stats.milestonePressingSub', {
          record: this.$t(`stats.tiers.${tier}`),
          n: this.formatNumber(holds),
        })
      }
      if (kind === 'hours') {
        const days = Math.round(value / 24)
        return this.$t('stats.milestoneHoursSub', { n: this.formatNumber(days) }, days)
      }
      const { current, longest } = streaks(this.ownHistory?.timestamps ?? [], this.today)
      if (current >= longest) return this.$t('stats.milestoneStreakBest')
      const left = longest - current
      return this.$t('stats.milestoneStreakSub', { n: this.formatNumber(left) }, left)
    },
    importChoices(): ImportOption[] {
      return importOptions({
        lastfmName: useLastfmStore().username,
        lastfmConfigured: this.lastfmConfigured,
        listenbrainzName: useListenbrainzStore().username,
      })
    },
    offeredImports(): ImportOption[] {
      // While paired the server's log is the one shown, so it imports there.
      if (!this.isOwnView || !this.importStatus || this.importStatus.paired) return []
      const action = importAction(this.importStatus.status, this.importChoices)
      return action === 'choose' || action === 'retry' || action === 'again'
        ? this.importChoices
        : []
    },
  },
  watch: {
    milestonesReady(ready: boolean): void {
      if (ready) this.checkMilestones()
    },
    // Often still unknown when the page opens: the check is a request.
    'authStore.isAdmin'(): void {
      void this.loadAccounts()
    },
    viewedAccount(name: string | null): void {
      this.otherHistory = null
      if (name !== null) void this.loadOther(name)
    },
  },
  created() {
    this.libraryStore.fetchAllSongs()
    this.libraryStore.fetchStarred()
    // For the artists' own artwork, see artistsById. A no-op once loaded.
    this.libraryStore.fetchArtists()
    void this.loadOwn()
    void this.loadAccounts()
    void this.prepareImport()
  },
  beforeUnmount() {
    clearTimeout(this.momentTimer)
    clearTimeout(this.freshTimer)
    clearTimeout(this.importTimer)
  },
  methods: {
    async loadOwn(): Promise<void> {
      try {
        this.ownHistory = await getPlayHistorySummary()
        this.milestonesChecked = false
        if (this.milestonesReady) this.checkMilestones()
      } catch {
        // The log is an addition to this page: without connect's answer the
        // figures the media server provides still stand.
      }
    },
    async loadOther(name: string): Promise<void> {
      try {
        const summary = await getPlayHistorySummary(name)
        if (this.viewedAccount === name) this.otherHistory = summary
      } catch {
        // Stays empty; the picker is still there to go elsewhere.
      }
    },
    async loadAccounts(): Promise<void> {
      if (!this.authStore.isAdmin) return
      try {
        this.accounts = await getPlayHistoryAccounts()
      } catch {
        // A server that says no just means no picker.
      }
    },
    checkMilestones(): void {
      if (this.milestonesChecked || !this.ownHistory) return
      this.milestonesChecked = true
      const seen = this.ownHistory.milestones ?? null
      const reached = reachedMilestones(this.milestoneValues)
      const moment = nextMoment(seen, this.milestoneValues)
      if (!moment) {
        // Without a count yet: saved before records were counted, and there
        // is nothing to compare against.
        if (seen?.records === undefined) {
          this.ownHistory.milestones = reached
          void this.rememberMilestones(reached)
        }
        return
      }
      this.momentTimer = window.setTimeout(() => {
        // Someone browsing another account did not come for this.
        if (!this.isOwnView) return
        this.moment = moment
        this.momentReached = reached
        // Now rather than on closing: leaving mid-animation has still shown it.
        void this.rememberMilestones(reached)
      }, MOMENT_DELAY_MS)
    },
    async rememberMilestones(seen: MilestoneValues): Promise<void> {
      try {
        await saveMilestones(seen)
      } catch {
        // Worst case the same moment comes once more.
      }
    },
    momentTarget(): { x: number; y: number; size: number } | null {
      const hero = this.$refs.hero as InstanceType<typeof StatsHero> | undefined
      if (!hero) return null
      if (this.moment?.kind === 'pressing') {
        return hero.shelfRect(this.moment.value) ?? hero.labelRect()
      }
      if (this.moment?.kind === 'hours' || this.moment?.kind === 'streak') {
        return hero.figureRect(this.moment.kind)
      }
      return hero.labelRect()
    },
    /** Shows a moment and nothing else: no milestone is marked as seen. */
    playDebugMoment(entry: Moment): void {
      clearTimeout(this.momentTimer)
      this.momentReached = null
      if (entry.kind === 'pressing') {
        // One not earned yet has no place to land: it goes to the turntable.
        const { finished } = recordProgress(this.totalPlays)
        this.debugHeldRecords = entry.value <= finished ? entry.value - 1 : null
      }
      this.moment = entry
    },
    onMomentClosed(): void {
      this.debugHeldRecords = null
      this.fresh = this.moment?.kind ?? null
      this.landedRecord = this.moment?.kind === 'pressing' ? this.moment.value : null
      // Only now, so a new ring appears as the record lands in the hero.
      if (this.ownHistory && this.momentReached) this.ownHistory.milestones = this.momentReached
      this.moment = null
      this.freshTimer = window.setTimeout(() => {
        this.fresh = null
        this.landedRecord = null
      }, FRESH_MS)
    },
    async prepareImport(): Promise<void> {
      try {
        const [status, configured] = await Promise.all([
          getImportStatus(),
          useLastfmStore().checkConfigured(),
        ])
        this.lastfmConfigured = configured
        this.importStatus = status
        if (status.status === 'running') this.pollImport()
        const [only] = this.importChoices
        if (only && importAction(status.status, this.importChoices) === 'start') {
          await this.beginImport(only)
        }
      } catch {
        // No import offer, and the year fills from the next song on.
      }
    },
    async beginImport(option: ImportOption): Promise<void> {
      try {
        const again = this.importStatus?.status === 'done'
        this.importStatus = await startImport(option.source, option.username, again)
        if (this.importStatus.status === 'running') this.pollImport()
      } catch {
        // connect refused it (no key any more): the offer stays as it was.
      }
    },
    pollImport(): void {
      // An answer can still arrive after the page has been left.
      if (this.$.isUnmounted) return
      this.importTimer = window.setTimeout(async () => {
        if (!pollingAllowed()) {
          this.pollImport()
          return
        }
        try {
          this.importStatus = await getImportStatus()
        } catch {
          this.pollImport()
          return
        }
        if (this.importStatus.status === 'running') this.pollImport()
        else void this.loadOwn()
      }, IMPORT_POLL_MS)
    },
    /** A chart line counted from the log. The ids are empty on what came
     * from an import, which knows names only, so those lines do not link. */
    logItem(item: PlayHistoryTop, kind: ChartKind): ChartItem {
      const base = {
        id: item.id,
        label: item.label,
        sublabel: item.sublabel || undefined,
        value: item.value,
        valueLabel: this.formatNumber(item.value),
      }
      if (kind === 'genres') {
        return { ...base, to: `/genres/${encodeURIComponent(item.label)}` }
      }
      if (kind === 'artists') {
        const artist = item.artist_id ? this.artistsById.get(item.artist_id) : undefined
        return {
          ...base,
          to: item.artist_id ? `/artists/${item.artist_id}` : undefined,
          coverArtId: artist?.coverArtId ?? null,
          imageUrl: artist?.imageUrl ?? null,
        }
      }
      return {
        ...base,
        to: item.album_id ? `/albums/${item.album_id}` : undefined,
        coverArtId: item.cover_art_id || null,
      }
    },
    /** A genre has no picture, so its number one shows the records it is
     * made of, the most played in front. */
    withCrate(items: ChartItem[]): ChartItem[] {
      const [first, ...rest] = items
      if (!first) return items
      const name = first.label.toLowerCase()
      const plays = new Map<string, number>()
      for (const song of this.songs) {
        if (!song.coverArtId || song.genre?.toLowerCase() !== name) continue
        plays.set(song.coverArtId, (plays.get(song.coverArtId) ?? 0) + (song.playCount || 0))
      }
      const covers = [...plays.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, STACK_COVERS)
        .map(([cover]) => cover)
      return [{ ...first, covers }, ...rest]
    },
    withMovement(items: ChartItem[], keyOf: (song: Song) => string | null): ChartItem[] {
      if (!this.recentPlays) return items
      const movement = chartMovement(this.songs, this.recentPlays, keyOf)
      return items.map((item) => ({ ...item, move: movement.get(item.id) }))
    },
    topFromGroups(
      groups: Map<
        string,
        { label: string; plays: number; songCount: number; coverArtId: string | null }
      >,
      toFn: (id: string) => string,
      includeCoverArt = false,
    ): ChartItem[] {
      return [...groups.entries()]
        .filter(([, v]) => v.plays > 0)
        .sort(([, a], [, b]) => b.plays - a.plays)
        .slice(0, TOP_N)
        .map(([id, v]) => ({
          id,
          label: v.label,
          value: v.plays,
          valueLabel: this.formatNumber(v.plays),
          to: toFn(id),
          coverArtId: includeCoverArt ? v.coverArtId : undefined,
        }))
    },
    shareItem(id: string, label: string, count: number): ChartItem {
      return {
        id,
        label,
        value: count,
        valueLabel: this.formatShare(count, this.songs.length || 1),
      }
    },
    formatBytes(bytes: number): string {
      const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte']
      let value = bytes
      let unit = 0
      while (value >= 1000 && unit < units.length - 1) {
        value /= 1000
        unit += 1
      }
      return new Intl.NumberFormat(this.$i18n.locale, {
        style: 'unit',
        unit: units[unit],
        maximumFractionDigits: value < 10 ? 1 : 0,
      }).format(value)
    },
    formatRating(value: number): string {
      return `${value.toLocaleString(this.$i18n.locale, { maximumFractionDigits: 1 })} ★`
    },
    /** 16 %, 16%, 16 % - where the sign goes is the language's call. */
    formatPercent(value: number): string {
      return new Intl.NumberFormat(this.$i18n.locale, { style: 'percent' }).format(value / 100)
    },
    /** A share as a whole percent, never rounded to a figure that says
     * something else: 50 songs heard out of 19,529 is "< 1 %", not "0 %",
     * which read as nothing at all. Same at the other end. */
    formatShare(part: number, whole: number): string {
      if (whole <= 0) return this.formatPercent(0)
      const percent = Math.round((part / whole) * 100)
      if (part > 0 && percent === 0) return `< ${this.formatPercent(1)}`
      if (part < whole && percent === 100) return `> ${this.formatPercent(99)}`
      return this.formatPercent(percent)
    },
    formatNumber(value: number): string {
      return value.toLocaleString(this.$i18n.locale)
    },
    formatBigDuration(totalSeconds: number): string {
      const totalMinutes = Math.floor(totalSeconds / 60)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return this.$t('stats.days', { days, hours })
      if (hours > 0) return this.$t('stats.hours', { hours, minutes })
      return this.$t('stats.minutes', { minutes })
    },
  },
}
</script>

<style scoped>
.stats-page {
  container: stats-page / inline-size;
  display: flex;
  flex-direction: column;
  gap: 48px;
}

.stats-page__columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 48px;
}

/* Side by side once one column would only stretch: a chart's bars and a
 * year's days had grown to absurd lengths on an ultrawide. */
@container stats-page (min-width: 2000px) {
  .stats-page__columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.stats-page__debug {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: -32px;
}

.stats-page__account {
  width: min(100%, 260px);
  margin-bottom: -32px;
  margin-left: auto;
}

/* A rounded pill, as every other control above a page's content. */
.stats-page__account :deep(.v-field) {
  border-radius: 999px;
}
</style>
