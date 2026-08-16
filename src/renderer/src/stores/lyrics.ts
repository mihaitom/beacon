import { defineStore } from 'pinia'
import { autoLyrics, getLyricsByRemoteId, searchLyrics } from '@/services/connect/lyrics'
import type { LyricSearchResult } from '@/services/connect/types'
import { fromStructuredLyrics, parseLyrics, type LyricLine } from '@/services/lyrics/parseLrc'
import { useLibraryStore } from '@/stores/library'
import type { Track } from '@/types/library'

// Source id for a track's own embedded/ID3-tag lyrics (getLyricsBySongId.view)
// — kept alongside the three connect.LyricSource values ('lrclib.net',
// 'SimpMusic', 'NetEase') as the value of CachedLyrics.source /
// LyricsState.source, distinguished by not being a valid search-candidate
// source (the file isn't something you can "pick a different match" from).
export const FILE_SOURCE = 'file'

interface LyricsState {
  trackId: string | null
  synced: boolean
  lines: LyricLine[]
  loading: boolean
  error: boolean
  // Where the currently-shown lyrics came from — FILE_SOURCE, one of
  // connect's LyricSource values, or null (nothing loaded / no match).
  // Shown in the UI so a bad match is easy to trace back to its provider.
  source: string | null
  // The matched candidate's id on `source`, for reference. Null for
  // FILE_SOURCE (there's no candidate id, just "this file's own tags") and
  // while nothing is loaded.
  remoteId: string | null
  // Per-source search results for the "pick a different match" flow, only
  // populated while that picker is open — see loadCandidates()/
  // selectCandidate() below.
  candidates: Record<string, LyricSearchResult[]> | null
  candidatesLoading: boolean
  // Seconds to shift this track's line timestamps by before comparing
  // against playback position — positive delays the lyrics (use when they
  // fire too early), negative advances them. Per-track because the mismatch
  // comes from the *matched lyrics source* being a slightly different
  // edit/version than *this* audio file, not from anything global.
  offset: number
}

interface CachedPositive {
  synced: boolean
  lines: LyricLine[]
  source: string
  remoteId: string | null
}

interface CachedNegative {
  negative: true
  cachedAt: number
}

type CacheEntry = CachedPositive | CachedNegative

// How long a confirmed "nothing found anywhere" result blocks a refetch —
// long enough that normal replays of a track don't keep re-hitting three
// uncached third-party APIs for something that isn't there, short enough
// that a source adding the track later (or a metadata fix) isn't stuck
// forever.
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

// Persisted across restarts, unlike the old session-only cache this
// replaces — "save every lyrics lookup we've ever made" was the explicit
// ask, not just "avoid refetching within one run." One JSON blob keyed by
// track id, same convention as OFFSETS_KEY below. A positive entry never
// expires (a track's lyrics don't change); a negative one expires after
// NEGATIVE_TTL_MS, see isExpired().
const CACHE_KEY = 'beacon.lyricsCache'

// Loaded once per app run and kept in sync by writeCacheEntry() — avoids
// re-parsing the whole persisted blob (one full lyrics text per cached
// track, potentially a lot of them) on every single ensureLoaded() call.
let persistedCache: Record<string, CacheEntry> | null = null
let inFlightTrackId: string | null = null

function loadPersistedCache(): Record<string, CacheEntry> {
  if (!persistedCache) {
    try {
      persistedCache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<
        string,
        CacheEntry
      >
    } catch {
      persistedCache = {}
    }
  }
  return persistedCache
}

function writeCacheEntry(trackId: string, entry: CacheEntry): void {
  const all = loadPersistedCache()
  all[trackId] = entry
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    // Storage full/disabled — the in-memory entry above still serves this
    // session; losing the persisted copy just means a refetch next launch.
  }
}

function isExpiredNegative(entry: CachedNegative): boolean {
  return Date.now() - entry.cachedAt > NEGATIVE_TTL_MS
}

/** Called from SettingsView.vue's "clear caches" action. Only the fetched-
 * lyrics cache — deliberately leaves OFFSETS_KEY (per-track sync-offset
 * corrections, see readStoredOffset() below) alone, since that's the user's
 * own manual work, not a re-fetchable cache. */
export function clearLyricsCache(): void {
  persistedCache = {}
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}

const OFFSETS_KEY = 'beacon.lyricsOffsets'

function readStoredOffset(trackId: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, number>
    return all[trackId] ?? 0
  } catch {
    return 0
  }
}

function writeStoredOffset(trackId: string, offset: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, number>
    if (offset === 0) delete all[trackId]
    else all[trackId] = offset
    localStorage.setItem(OFFSETS_KEY, JSON.stringify(all))
  } catch {
    // Losing a saved offset on write failure (e.g. storage full/disabled)
    // isn't worth surfacing — the in-memory value for this session still works.
  }
}

/** The track's own embedded/ID3-tag lyrics, if its server exposes them —
 * tried before the third-party lookup below since it matches this exact
 * file rather than "some track with this name/artist" that may be a
 * different edit. Null (not an error) on any server that doesn't support
 * the OpenSubsonic extension, same as a genuine "no lyrics tagged". */
async function fetchFileLyrics(track: Track): Promise<CachedPositive | null> {
  const candidates = await useLibraryStore().client().getLyricsBySongId(track.id)
  const best = candidates.find((c) => c.synced) ?? candidates[0]
  if (!best || best.line.length === 0) return null
  const parsed = fromStructuredLyrics(best)
  if (parsed.lines.length === 0) return null
  return { synced: parsed.synced, lines: parsed.lines, source: FILE_SOURCE, remoteId: null }
}

export const useLyricsStore = defineStore('lyrics', {
  state: (): LyricsState => ({
    trackId: null,
    synced: false,
    lines: [],
    loading: false,
    error: false,
    source: null,
    remoteId: null,
    candidates: null,
    candidatesLoading: false,
    offset: 0,
  }),

  actions: {
    /** Fetches (or reuses the persisted cache for) `track`'s lyrics. Not
     * called eagerly on every track change — only when a lyrics surface
     * (the drawer, or Now Playing's immersive lyrics mode) is actually
     * visible, see LyricsPanel.vue's consumers (LyricsDrawer.vue,
     * NowPlayingView.vue). */
    async ensureLoaded(track: Track): Promise<void> {
      this.offset = readStoredOffset(track.id)

      const cached = loadPersistedCache()[track.id]
      if (cached && !('negative' in cached && isExpiredNegative(cached))) {
        this.trackId = track.id
        this.loading = false
        this.error = false
        if ('negative' in cached) {
          this.synced = false
          this.lines = []
          this.source = null
          this.remoteId = null
        } else {
          this.synced = cached.synced
          this.lines = cached.lines
          this.source = cached.source
          this.remoteId = cached.remoteId
        }
        return
      }
      if (inFlightTrackId === track.id) return // already fetching this one

      this.trackId = track.id
      this.loading = true
      this.error = false
      this.synced = false
      this.lines = []
      this.source = null
      this.remoteId = null
      inFlightTrackId = track.id
      try {
        let positive = await fetchFileLyrics(track)
        if (!positive) {
          const result = await autoLyrics({
            name: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
          })
          if (result) {
            const parsed = parseLyrics(result.lyrics)
            positive = {
              synced: parsed.synced,
              lines: parsed.lines,
              source: result.source,
              remoteId: result.id,
            }
          }
        }
        writeCacheEntry(track.id, positive ?? { negative: true, cachedAt: Date.now() })
        // A newer track may have started while this was in flight — don't
        // let a slower, stale response overwrite what's actually playing now.
        if (this.trackId !== track.id) return
        this.synced = positive?.synced ?? false
        this.lines = positive?.lines ?? []
        this.source = positive?.source ?? null
        this.remoteId = positive?.remoteId ?? null
      } catch (error) {
        // Deliberately not cached (unlike a genuine "no match" above) — a
        // request failure is more likely transient than a stable fact
        // about the track, so the next ensureLoaded() call retries instead
        // of being stuck with a permanent false negative.
        console.error('[lyrics] Failed to fetch lyrics:', error)
        if (this.trackId === track.id) this.error = true
      } finally {
        if (inFlightTrackId === track.id) inFlightTrackId = null
        if (this.trackId === track.id) this.loading = false
      }
    },

    /** Fetches every third-party candidate for `track`, grouped by source
     * — backing the "pick a different match" affordance in LyricsPanel.vue
     * for when the automatic best match isn't the right one. Does not
     * touch the track's own file lyrics (there's nothing to "pick" there,
     * it's either tagged or it isn't). */
    async loadCandidates(track: Track): Promise<void> {
      this.candidatesLoading = true
      try {
        this.candidates = await searchLyrics({
          name: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
        })
      } catch (error) {
        console.error('[lyrics] Failed to search lyrics candidates:', error)
        this.candidates = {}
      } finally {
        this.candidatesLoading = false
      }
    },

    clearCandidates(): void {
      this.candidates = null
    },

    /** Applies one specific candidate from loadCandidates() as `track`'s
     * lyrics, overwriting whatever was cached/shown before — the explicit
     * override for when the automatic best match was wrong. */
    async selectCandidate(track: Track, source: string, id: string): Promise<void> {
      this.candidates = null
      this.loading = true
      this.error = false
      try {
        const raw = await getLyricsByRemoteId(source, id)
        const parsed = raw ? parseLyrics(raw) : null
        const positive: CachedPositive | null = parsed
          ? { synced: parsed.synced, lines: parsed.lines, source, remoteId: id }
          : null
        writeCacheEntry(track.id, positive ?? { negative: true, cachedAt: Date.now() })
        if (this.trackId !== track.id) return
        this.synced = positive?.synced ?? false
        this.lines = positive?.lines ?? []
        this.source = positive?.source ?? null
        this.remoteId = positive?.remoteId ?? null
      } catch (error) {
        console.error('[lyrics] Failed to load selected lyrics candidate:', error)
        if (this.trackId === track.id) this.error = true
      } finally {
        if (this.trackId === track.id) this.loading = false
      }
    },

    /** Sets the current track's timing offset to an absolute value (unlike
     * adjustOffset below, not relative to whatever it already was) and
     * persists it. Used by the "click the line being sung" calibration
     * flow in LyricsPanel.vue, which computes the exact offset needed in
     * one shot rather than nudging toward it. No-op with nothing loaded. */
    setOffset(offsetSeconds: number): void {
      if (!this.trackId) return
      // Rounded to avoid float noise, same as adjustOffset below.
      this.offset = Math.round(offsetSeconds * 10) / 10
      writeStoredOffset(this.trackId, this.offset)
    },

    /** Nudges the current track's timing offset by `deltaSeconds` (typically
     * ±0.1) and persists it — see LyricsState.offset's comment on sign
     * convention. No-op with nothing loaded (nothing to offset). */
    adjustOffset(deltaSeconds: number): void {
      this.setOffset(this.offset + deltaSeconds)
    },
  },
})
