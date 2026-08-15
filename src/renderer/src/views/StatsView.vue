<template>
  <v-container fluid>
    <div class="mb-8">
      <p class="eyebrow-label mb-2">{{ $t('stats.eyebrow') }}</p>
      <h1 class="page-title">{{ $t('stats.title') }}</h1>
    </div>

    <page-loader v-if="loading && tracks.length === 0" />

    <template v-else>
      <section class="mb-10">
        <h2 class="section-title mb-4">{{ $t('stats.libraryTitle') }}</h2>
        <div class="stat-grid">
          <div class="stat-tile">
            <div class="stat-tile__value detail-title">{{ formatNumber(totalTracks) }}</div>
            <div class="stat-tile__label">{{ $t('stats.tracks') }}</div>
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
              {{ formatNumber(starredCounts.tracks) }}
            </div>
            <div class="stat-tile__label">{{ $t('stats.favoriteTracks') }}</div>
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
          <h2 class="section-title mb-4">{{ $t('stats.topTracks') }}</h2>
          <ranked-list :items="topTracks" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topArtists') }}</h2>
          <ranked-list :items="topArtists" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topAlbums') }}</h2>
          <ranked-list :items="topAlbums" />
        </section>
        <section>
          <h2 class="section-title mb-4">{{ $t('stats.topGenres') }}</h2>
          <ranked-list :items="topGenres" />
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
import type { Track } from '@/types/library'

const TOP_N = 5

/** Aggregates `tracks` by `keyFn` (album/artist id, genre name, format,
 * ...), summing playCount per group — the shared shape every "top N by
 * plays" ranking below needs, just with a different grouping key and
 * label/link per caller. */
function aggregateByPlays(
  tracks: Track[],
  keyFn: (track: Track) => string | null,
  labelFn: (track: Track) => string,
): Map<string, { label: string; plays: number; trackCount: number }> {
  const groups = new Map<string, { label: string; plays: number; trackCount: number }>()
  for (const track of tracks) {
    const key = keyFn(track)
    if (!key) continue
    const entry = groups.get(key) ?? { label: labelFn(track), plays: 0, trackCount: 0 }
    entry.plays += track.playCount || 0
    entry.trackCount += 1
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
    tracks(): Track[] {
      return this.libraryStore.allTracks
    },
    totalTracks(): number {
      return this.tracks.length
    },
    totalArtists(): number {
      return new Set(this.tracks.map((t) => t.artistId).filter(Boolean)).size
    },
    totalAlbums(): number {
      return new Set(this.tracks.map((t) => t.albumId).filter(Boolean)).size
    },
    totalGenres(): number {
      return new Set(this.tracks.map((t) => t.genre).filter(Boolean)).size
    },
    libraryDuration(): number {
      return this.tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    },
    totalPlays(): number {
      return this.tracks.reduce((sum, t) => sum + (t.playCount || 0), 0)
    },
    // Subsonic/Navidrome only ever exposes an aggregate playCount per
    // track, not individual play timestamps — there's no real "this year"
    // time window to slice by, so this (like everything else on this
    // page) is all-time. duration × playCount is an estimate, not a log
    // of actual listens (a play counts once past the scrobble threshold —
    // see connect's checkScrobbleThreshold() — not necessarily start to
    // finish), but it's the closest thing to "hours listened" the data
    // actually supports.
    listeningTime(): number {
      return this.tracks.reduce((sum, t) => sum + (t.duration || 0) * (t.playCount || 0), 0)
    },
    starredCounts(): { tracks: number; albums: number; artists: number } {
      const starred = this.libraryStore.starred
      return {
        tracks: starred.tracks.length,
        albums: starred.albums.length,
        artists: starred.artists.length,
      }
    },
    topTracks(): RankedItem[] {
      return [...this.tracks]
        .filter((t) => t.playCount > 0)
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, TOP_N)
        .map((t) => ({
          id: t.id,
          label: t.title,
          sublabel: t.artist,
          value: t.playCount,
          valueLabel: this.$t('stats.plays', { count: t.playCount }),
          // No standalone track page in this app to link to — album is
          // the closest real destination.
          to: `/albums/${t.albumId}`,
        }))
    },
    topArtists(): RankedItem[] {
      const groups = aggregateByPlays(
        this.tracks,
        (t) => t.artistId || null,
        (t) => t.artist,
      )
      return this.topFromGroups(groups, (id) => `/artists/${id}`)
    },
    topAlbums(): RankedItem[] {
      const groups = aggregateByPlays(
        this.tracks,
        (t) => t.albumId || null,
        (t) => t.album,
      )
      return this.topFromGroups(groups, (id) => `/albums/${id}`)
    },
    topGenres(): RankedItem[] {
      const groups = aggregateByPlays(
        this.tracks,
        (t) => t.genre,
        (t) => t.genre ?? '',
      )
      return this.topFromGroups(groups, (name) => `/genres/${encodeURIComponent(name)}`)
    },
    formatBreakdown(): RankedItem[] {
      const counts = new Map<string, number>()
      for (const t of this.tracks) {
        const key = (t.format || '—').toUpperCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const total = this.tracks.length || 1
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
    // rankings above both) — tracks with no year tag are left out rather
    // than lumped into a misleading "unknown" bucket sized by tagging
    // gaps, not by anything about the music itself.
    decadeBreakdown(): RankedItem[] {
      const counts = new Map<number, number>()
      for (const t of this.tracks) {
        if (!t.year) continue
        const decade = Math.floor(t.year / 10) * 10
        counts.set(decade, (counts.get(decade) ?? 0) + 1)
      }
      const total = this.tracks.length || 1
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
    this.libraryStore.fetchAllTracks()
    this.libraryStore.fetchStarred()
  },
  methods: {
    topFromGroups(
      groups: Map<string, { label: string; plays: number; trackCount: number }>,
      toFn: (id: string) => string,
    ): RankedItem[] {
      return [...groups.entries()]
        .filter(([, v]) => v.plays > 0)
        .sort(([, a], [, b]) => b.plays - a.plays)
        .slice(0, TOP_N)
        .map(([id, v]) => ({
          id,
          label: v.label,
          value: v.plays,
          valueLabel: this.$t('stats.plays', { count: v.plays }),
          to: toFn(id),
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
