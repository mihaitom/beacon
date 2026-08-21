<template>
  <v-container fluid>
    <div class="mb-8">
      <p class="eyebrow-label mb-2">{{ $t('stats.eyebrow') }}</p>
      <h1 class="page-title">{{ $t('stats.title') }}</h1>
    </div>

    <page-loader v-if="loading && songs.length === 0" />

    <template v-else>
      <section class="mb-10">
        <h2 class="section-title mb-4">{{ $t('stats.libraryTitle') }}</h2>
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
        </div>
      </section>

      <section class="mb-10">
        <h2 class="section-title mb-4">{{ $t('stats.listeningTitle') }}</h2>
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
        </div>
      </section>

      <v-alert v-if="totalPlays === 0" type="info" variant="tonal" class="mb-10">
        {{ $t('stats.noPlaysYet') }}
      </v-alert>

      <div v-else class="pair-grid mb-10">
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topSongs') }}</h2>
          <ranked-list :items="topSongs" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topArtists') }}</h2>
          <ranked-list :items="topArtists" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topAlbums') }}</h2>
          <ranked-list :items="topAlbums" value-icon="mdi-play" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topGenres') }}</h2>
          <ranked-list :items="topGenres" value-icon="mdi-play" />
        </section>
      </div>

      <!-- Composition facts, not listening facts (unlike everything above)
       - — paired together in the same 2-column rhythm as the top-N grid
       - rather than left as a single section that reads as a leftover
       - afterthought on its own row. -->
      <div v-if="formatBreakdown.length || decadeBreakdown.length" class="pair-grid">
        <section v-if="formatBreakdown.length">
          <h2 class="section-title mb-4">{{ $t('stats.formatsTitle') }}</h2>
          <ranked-list :items="formatBreakdown" />
        </section>
        <section v-if="decadeBreakdown.length">
          <h2 class="section-title mb-4">{{ $t('stats.decadesTitle') }}</h2>
          <ranked-list :items="decadeBreakdown" />
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
      const total = this.songs.length || 1
      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_N)
        .map(([format, count]) => ({
          id: format,
          label: format,
          value: count,
          valueLabel: `${Math.round((count / total) * 100)}%`,
        }))
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
      const total = this.songs.length || 1
      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_N)
        .map(([decade, count]) => ({
          id: String(decade),
          label: this.$t('stats.decade', { decade }),
          value: count,
          valueLabel: `${Math.round((count / total) * 100)}%`,
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

/* Shared by the top-N grid (4 sections) and the composition-facts grid
 * (2 sections) below it — same 2-column rhythm either way, so a
 * shorter/odd-numbered group of sections never ends up as a single
 * leftover row that reads as an afterthought. */
.pair-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 32px 40px;
}
</style>
