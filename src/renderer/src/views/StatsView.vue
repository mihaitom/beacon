<template>
  <v-container fluid class="stats-page">
    <div class="stats-header">
      <p class="eyebrow-label stats-header__eyebrow">{{ $t('stats.eyebrow') }}</p>
      <h1 class="page-title">{{ $t('stats.title') }}</h1>
    </div>

    <page-loader v-if="loading && songs.length === 0" />

    <template v-else>
      <section>
        <h2 class="section-title">{{ $t('stats.libraryTitle') }}</h2>
        <div class="stat-grid">
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalSongs) }}</div>
            <div class="stat-tile__label">{{ $t('stats.songs') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalArtists) }}</div>
            <div class="stat-tile__label">{{ $t('stats.artists') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalAlbums) }}</div>
            <div class="stat-tile__label">{{ $t('stats.albums') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalGenres) }}</div>
            <div class="stat-tile__label">{{ $t('stats.genres') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">
              {{ formatBigDuration(libraryDuration) }}
            </div>
            <div class="stat-tile__label">{{ $t('stats.libraryDuration') }}</div>
          </div>
          <div v-if="storageBytes > 0" class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatBytes(storageBytes) }}</div>
            <div class="stat-tile__label">{{ $t('stats.storage') }}</div>
          </div>
        </div>
      </section>

      <section>
        <h2 class="section-title">{{ $t('stats.listeningTitle') }}</h2>
        <div class="stat-grid">
          <div class="stat-tile stat-tile--highlight">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalPlays) }}</div>
            <div class="stat-tile__label">{{ $t('stats.totalPlays') }}</div>
          </div>
          <div class="stat-tile stat-tile--highlight">
            <div class="stat-tile__value detail-title">{{ formatBigDuration(listeningTime) }}</div>
            <div class="stat-tile__label">{{ $t('stats.listeningTime') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ playedShare }}%</div>
            <div class="stat-tile__label">{{ $t('stats.playedShare') }}</div>
          </div>
          <div v-if="hasLastPlayed" class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(recentlyPlayedCount) }}</div>
            <div class="stat-tile__label">{{ $t('stats.recentlyPlayed') }}</div>
          </div>
        </div>
      </section>

      <section>
        <h2 class="section-title">{{ $t('stats.favoritesTitle') }}</h2>
        <div class="stat-grid">
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">
              {{ formatNumber(starredCounts.songs) }}
            </div>
            <div class="stat-tile__label">{{ $t('stats.favoriteSongs') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">
              {{ formatNumber(starredCounts.albums) }}
            </div>
            <div class="stat-tile__label">{{ $t('stats.favoriteAlbums') }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">
              {{ formatNumber(starredCounts.artists) }}
            </div>
            <div class="stat-tile__label">{{ $t('stats.favoriteArtists') }}</div>
          </div>
          <template v-if="ratings.count > 0">
            <div class="stat-tile">
              <div class="stat-tile__value detail-title">{{ formatNumber(ratings.count) }}</div>
              <div class="stat-tile__label">{{ $t('stats.ratedSongs') }}</div>
            </div>
            <div class="stat-tile">
              <div class="stat-tile__value detail-title">{{ formatRating(ratings.average) }}</div>
              <div class="stat-tile__label">{{ $t('stats.averageRating') }}</div>
            </div>
          </template>
        </div>
      </section>

      <v-alert v-if="totalPlays === 0" type="info" variant="tonal" class="stats-empty">
        {{ $t('stats.noPlaysYet') }}
      </v-alert>

      <div v-else class="pair-grid">
        <section>
          <h2 class="section-title">{{ $t('stats.topSongs') }}</h2>
          <ranked-list :items="topSongs" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title">{{ $t('stats.topArtists') }}</h2>
          <ranked-list :items="topArtists" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title">{{ $t('stats.topAlbums') }}</h2>
          <ranked-list :items="topAlbums" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title">{{ $t('stats.topGenres') }}</h2>
          <ranked-list :items="topGenres" value-icon="mdi-play" />
        </section>
      </div>

      <!-- Composition facts, not listening facts (unlike everything above),
       - in the same grid as the top-N lists so they line up with them. -->
      <div
        v-if="
          formatBreakdown.length ||
          qualityBreakdown.length ||
          decadeBreakdown.length ||
          largestArtists.length
        "
        class="pair-grid"
      >
        <section v-if="formatBreakdown.length">
          <h2 class="section-title">{{ $t('stats.formatsTitle') }}</h2>
          <ranked-list :items="formatBreakdown" />
        </section>
        <section v-if="qualityBreakdown.length">
          <h2 class="section-title">{{ $t('stats.qualityTitle') }}</h2>
          <ranked-list :items="qualityBreakdown" />
        </section>
        <section v-if="decadeBreakdown.length">
          <h2 class="section-title">{{ $t('stats.decadesTitle') }}</h2>
          <ranked-list :items="decadeBreakdown" />
        </section>
        <section v-if="largestArtists.length">
          <h2 class="section-title">{{ $t('stats.largestArtistsTitle') }}</h2>
          <ranked-list :items="largestArtists" value-icon="mdi-music-note" />
        </section>
      </div>
    </template>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import PageLoader from '@/components/PageLoader.vue'
import RankedList, { type RankedItem } from '@/components/library/RankedList.vue'
import type { Artist, Song } from '@/types/library'

const TOP_N = 5
const RECENT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

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
  components: { PageLoader, RankedList },
  data() {
    return {
      // Fixed per visit, so "the last 30 days" doesn't drift while the page
      // is open and the tests can pin it with fake timers.
      now: Date.now(),
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    loading(): boolean {
      return this.libraryStore.loading
    },
    songs(): Song[] {
      return this.libraryStore.allSongs
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
    // Neither Subsonic/Navidrome nor Jellyfin (bridged — see
    // jellyfin_bridge.py's scrobble()) exposes anything beyond an aggregate
    // playCount per song, not individual play timestamps — there's no
    // real "this year" time window to slice by, so this (like everything
    // else on this page) is all-time. duration × playCount is an estimate,
    // not a log of actual listens (a play counts once past the scrobble
    // threshold — see connect's checkScrobbleThreshold() — not necessarily start to
    // finish), but it's the closest thing to "hours listened" the data
    // actually supports. For Jellyfin specifically, playCount is reported
    // via its session-based /Sessions/Playing + /Sessions/Playing/Stopped
    // flow — see scrobble()'s comment.
    listeningTime(): number {
      return this.songs.reduce((sum, t) => sum + (t.duration || 0) * (t.playCount || 0), 0)
    },
    storageBytes(): number {
      return this.songs.reduce((sum, t) => sum + (t.size || 0), 0)
    },
    playedShare(): number {
      if (this.songs.length === 0) return 0
      const played = this.songs.filter((t) => (t.playCount || 0) > 0).length
      return Math.round((played / this.songs.length) * 100)
    },
    hasLastPlayed(): boolean {
      return this.songs.some((t) => t.lastPlayed)
    },
    // Each song carries only its latest play, so this counts distinct songs
    // heard in the window - not plays, which the servers don't log per date.
    recentlyPlayedCount(): number {
      const since = this.now - RECENT_DAYS * DAY_MS
      return this.songs.filter((t) => t.lastPlayed && Date.parse(t.lastPlayed) >= since).length
    },
    ratings(): { count: number; average: number } {
      const rated = this.songs.filter((t) => t.rating > 0)
      if (rated.length === 0) return { count: 0, average: 0 }
      const total = rated.reduce((sum, t) => sum + t.rating, 0)
      return { count: rated.length, average: total / rated.length }
    },
    starredCounts(): { songs: number; albums: number; artists: number } {
      const starred = this.libraryStore.starred
      return {
        songs: starred.songs.length,
        albums: starred.albums.length,
        artists: starred.artists.length,
      }
    },
    topSongs(): RankedItem[] {
      return [...this.songs]
        .filter((t) => t.playCount > 0)
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, TOP_N)
        .map((t) => ({
          id: t.id,
          label: t.title,
          sublabel: t.artist,
          value: t.playCount,
          // Just the number, no repeated "X plays" unit word — RankedList's
          // own valueIcon (mdi-play, set on the <ranked-list> tag below)
          // carries that meaning instead, since every row on this page's
          // four ranked lists means the same thing.
          valueLabel: this.formatNumber(t.playCount),
          // No standalone song page in this app to link to — album is
          // the closest real destination.
          to: `/albums/${t.albumId}`,
          coverArtId: t.coverArtId,
        }))
    },
    // Lookup for topArtists' own artist.coverArtId/imageUrl below — a
    // song's cover is its *album's* art, so showing a random song's album
    // cover next to an artist's name would be misleading; this instead
    // draws from libraryStore.artists (fetchArtists(), see created()),
    // which aggregateByPlays()'s per-song groups have no way to.
    artistsById(): Map<string, Artist> {
      return new Map(this.libraryStore.artists.map((a) => [a.id, a]))
    },
    topArtists(): RankedItem[] {
      const groups = aggregateByPlays(
        this.songs,
        (t) => t.artistId || null,
        (t) => t.artist,
      )
      return this.topFromGroups(groups, (id) => `/artists/${id}`).map((item) => {
        const artist = this.artistsById.get(item.id)
        // artist undefined for as long as fetchArtists() (fired alongside
        // fetchAllSongs() in created(), see its own comment) is still in
        // flight — coverArtId stays defined either way (null, not
        // undefined) so RankedList.vue still reserves the art column
        // instead of the whole row visibly reflowing once artists arrives.
        return {
          ...item,
          // A song's own artist field is its whole credit ("A, B & C").
          label: artist?.name ?? item.label,
          coverArtId: artist?.coverArtId ?? null,
          imageUrl: artist?.imageUrl ?? null,
        }
      })
    },
    topAlbums(): RankedItem[] {
      const groups = aggregateByPlays(
        this.songs,
        (t) => t.albumId || null,
        (t) => t.album,
      )
      return this.topFromGroups(groups, (id) => `/albums/${id}`, true)
    },
    topGenres(): RankedItem[] {
      const groups = aggregateByPlays(
        this.songs,
        (t) => t.genre,
        (t) => t.genre ?? '',
      )
      return this.topFromGroups(groups, (name) => `/genres/${encodeURIComponent(name)}`)
    },
    formatBreakdown(): RankedItem[] {
      const counts = new Map<string, number>()
      for (const t of this.songs) {
        const key = (t.format || '—').toUpperCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return this.shareOfLibrary(counts, (format) => ({ id: format, label: format }))
    },
    qualityBreakdown(): RankedItem[] {
      const counts = new Map<AudioQuality, number>()
      for (const t of this.songs) {
        const quality = audioQuality(t)
        if (quality) counts.set(quality, (counts.get(quality) ?? 0) + 1)
      }
      return this.shareOfLibrary(counts, (quality) => ({
        id: quality,
        label: this.$t(`stats.quality.${quality}`),
      }))
    },
    largestArtists(): RankedItem[] {
      const counts = new Map<string, number>()
      const names = new Map<string, string>()
      for (const t of this.songs) {
        if (!t.artistId) continue
        counts.set(t.artistId, (counts.get(t.artistId) ?? 0) + 1)
        // Only the fallback while the artist list loads: a song's artist
        // field is its whole credit ("A, B & C"), not the artist it's filed under.
        const name = names.get(t.artistId)
        if (!name || t.artist.length < name.length) names.set(t.artistId, t.artist)
      }
      // A song count rather than a share: in a library of thousands of
      // artists every one of them rounds to 1%.
      return this.shareOfLibrary(counts, (id) => {
        const artist = this.artistsById.get(id)
        return {
          id,
          label: artist?.name ?? names.get(id) ?? '',
          to: `/artists/${id}`,
          // Same rule as topArtists: the artist's own art, null while loading.
          coverArtId: artist?.coverArtId ?? null,
          imageUrl: artist?.imageUrl ?? null,
        }
      }).map((item) => ({ ...item, valueLabel: this.formatNumber(item.value) }))
    },
    // Pairs with formatBreakdown above as the other "what's actually in
    // here" library-composition fact (as opposed to the listening-based
    // rankings above both) — songs with no year tag are left out rather
    // than lumped into a misleading "unknown" bucket sized by tagging
    // gaps, not by anything about the music itself.
    decadeBreakdown(): RankedItem[] {
      const counts = new Map<number, number>()
      for (const t of this.songs) {
        if (!t.year) continue
        const decade = Math.floor(t.year / 10) * 10
        counts.set(decade, (counts.get(decade) ?? 0) + 1)
      }
      return this.shareOfLibrary(counts, (decade) => ({
        id: String(decade),
        label: this.$t('stats.decade', { decade }),
      }))
    },
  },
  created() {
    this.libraryStore.fetchAllSongs()
    this.libraryStore.fetchStarred()
    // Only reason to load the full artist list here — see topArtists'
    // coverArtId/imageUrl comment. Own cached request; a no-op if some
    // earlier view (e.g. ArtistsView) already populated it.
    this.libraryStore.fetchArtists()
  },
  methods: {
    topFromGroups(
      groups: Map<
        string,
        { label: string; plays: number; songCount: number; coverArtId: string | null }
      >,
      toFn: (id: string) => string,
      includeCoverArt = false,
    ): RankedItem[] {
      return [...groups.entries()]
        .filter(([, v]) => v.plays > 0)
        .sort(([, a], [, b]) => b.plays - a.plays)
        .slice(0, TOP_N)
        .map(([id, v]) => ({
          id,
          label: v.label,
          value: v.plays,
          // See topSongs' identical comment above.
          valueLabel: this.formatNumber(v.plays),
          to: toFn(id),
          coverArtId: includeCoverArt ? v.coverArtId : undefined,
        }))
    },
    shareOfLibrary<K>(
      counts: Map<K, number>,
      describe: (key: K) => Omit<RankedItem, 'value' | 'valueLabel'>,
    ): RankedItem[] {
      const total = this.songs.length || 1
      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_N)
        .map(([key, count]) => ({
          ...describe(key),
          value: count,
          valueLabel: `${Math.round((count / total) * 100)}%`,
        }))
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
/* The page's own vertical rhythm: every top-level block on it is followed
 * by the same gap, so a section added later lines up without being told
 * to. The heading inside a section sits closer to its own content than
 * the sections do to each other. */
.pair-grid,
.stats-empty,
.v-container > section {
  margin-bottom: 40px;
}

.stats-header {
  margin-bottom: 32px;
}

.stats-header__eyebrow {
  margin-bottom: 8px;
}

.section-title {
  margin-bottom: 16px;
}

.stat-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.stat-tile {
  flex: 1 1 160px;
  min-width: 140px;
  padding: 20px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--beacon-hairline);
}

.stat-tile--highlight {
  background: rgba(245, 169, 78, 0.08);
  border-color: rgba(245, 169, 78, 0.3);
}

.stat-tile__value {
  font-size: 2.25rem;
  color: rgb(var(--v-theme-primary));
  line-height: 1.1;
}

.stat-tile__label {
  margin-top: 4px;
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.65);
}

/* Four columns, two, or one - never three: four lists across three columns
 * leave the fourth alone on its own row. Measured against the page, not
 * the window, so an open sidebar counts. The composition lists use the same
 * columns, which keeps them aligned under the top-N lists. */
.stats-page {
  container-type: inline-size;
}

.pair-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 32px 40px;
}

@container (min-width: 600px) {
  .pair-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container (min-width: 1080px) {
  .pair-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
