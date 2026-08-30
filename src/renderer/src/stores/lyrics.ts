import { defineStore } from 'pinia'
import { autoLyrics, getLyricsByRemoteId, searchLyrics } from '@/services/connect/lyrics'
import type { LyricSearchResult } from '@/services/connect/types'
import { fromStructuredLyrics, parseLyrics, type LyricLine } from '@/services/lyrics/parseLrc'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { useLyricsProvidersStore } from '@/stores/lyricsProviders'
import { accountScopedKey } from '@/services/accountKey'
import type { Song } from '@/types/library'

// Source id for a song's own embedded/ID3-tag lyrics (getLyricsBySongId.view)
// — kept alongside the three connect.LyricSource values ('lrclib.net',
// 'SimpMusic', 'NetEase') as the value of CachedLyrics.source /
// LyricsState.source, distinguished by not being a valid search-candidate
// source (the file isn't something you can "pick a different match" from).
export const FILE_SOURCE = 'file'

interface LyricsState {
  songId: string | null
  synced: boolean
  lines: LyricLine[]
  /** Songwriter/producer credits the source put at the top of the sheet,
   * kept out of the lines themselves — see parseLrc.ts's splitOffCredits().
   * Shown beside the source in the panel, where they stay readable, rather
   * than flashing past in the first fraction of a second. */
  credits: string[]
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
  // Seconds to shift this song's line timestamps by before comparing
  // against playback position — positive delays the lyrics (use when they
  // fire too early), negative advances them. Per-song because the mismatch
  // comes from the *matched lyrics source* being a slightly different
  // edit/version than *this* audio file, not from anything global.
  offset: number
}

interface CachedPositive {
  synced: boolean
  lines: LyricLine[]
  // Absent on entries cached before credits were split out; treated as
  // none, which is what they were showing anyway.
  credits?: string[]
  source: string
  remoteId: string | null
  // When this was stored — only consulted for lyrics that came from a
  // third-party provider (see shouldRecheckFile()). Absent on entries
  // written before this existed, which is treated as "long ago" so they
  // get their one re-check.
  cachedAt?: number
}

interface CachedNegative {
  negative: true
  cachedAt: number
}

type CacheEntry = CachedPositive | CachedNegative

// How long a confirmed "nothing found anywhere" result blocks a refetch —
// long enough that normal replays of a song don't keep re-hitting three
// uncached third-party APIs for something that isn't there, short enough
// that a source adding the song later (or a metadata fix) isn't stuck
// forever.
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

// How long lyrics found at a third-party provider are trusted to still be
// the best available answer. Not about those lyrics going stale — it's
// that the *file* may have gained its own since, which is what someone
// tagging their library is doing, and the whole reason file lyrics are
// preferred (see fetchFileLyrics()). A week is often enough to notice a
// tagging session, rare enough that it costs one extra request to the
// user's own server per song per week.
const PROVIDER_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

// Persisted across restarts, unlike the old session-only cache this
// replaces — "save every lyrics lookup we've ever made" was the explicit
// ask, not just "avoid refetching within one run." One JSON blob keyed by
// song id, same convention as OFFSETS_KEY below. A negative entry expires
// after NEGATIVE_TTL_MS; a positive one is kept indefinitely, but one that
// came from a third-party provider is re-checked against the file itself
// from time to time (see shouldRecheckFile()) — the lyrics don't go stale,
// the question of where the best copy lives does.
const CACHE_KEY = 'beacon.lyricsCache'

// Loaded once per app run and kept in sync by writeCacheEntry() — avoids
// re-parsing the whole persisted blob (one full lyrics text per cached
// song, potentially a lot of them) on every single ensureLoaded() call.
let persistedCache: Record<string, CacheEntry> | null = null
let inFlightSongId: string | null = null

function loadPersistedCache(): Record<string, CacheEntry> {
  if (!persistedCache) {
    try {
      persistedCache = JSON.parse(
        localStorage.getItem(accountScopedKey(CACHE_KEY)) ?? '{}',
      ) as Record<string, CacheEntry>
    } catch {
      persistedCache = {}
    }
  }
  return persistedCache
}

function writeCacheEntry(songId: string, entry: CacheEntry): void {
  const all = loadPersistedCache()
  // Stamped here rather than at each call site, so no path can store a
  // provider hit without one — an entry with no timestamp counts as
  // overdue for its file re-check (see shouldRecheckFile()), which would
  // otherwise fire on every single play.
  all[songId] = 'negative' in entry ? entry : { ...entry, cachedAt: Date.now() }
  try {
    localStorage.setItem(accountScopedKey(CACHE_KEY), JSON.stringify(all))
  } catch {
    // Storage full/disabled — the in-memory entry above still serves this
    // session; losing the persisted copy just means a refetch next launch.
  }
}

function isExpiredNegative(entry: CachedNegative): boolean {
  return Date.now() - entry.cachedAt > NEGATIVE_TTL_MS
}

/** Whether a cached hit is worth asking the file about again. Only ever
 * true for lyrics that came from a provider: the file's own are already
 * the best answer there is, so those are never re-checked. */
export function shouldRecheckFile(entry: CachedPositive, now = Date.now()): boolean {
  if (entry.source === FILE_SOURCE) return false
  return now - (entry.cachedAt ?? 0) > PROVIDER_RECHECK_MS
}

/** Called from SettingsView.vue's "clear caches" action. Only the fetched-
 * lyrics cache — deliberately leaves OFFSETS_KEY (per-song sync-offset
 * corrections, see readStoredOffset() below) alone, since that's the user's
 * own manual work, not a re-fetchable cache. */
export function clearLyricsCache(): void {
  persistedCache = {}
  try {
    localStorage.removeItem(accountScopedKey(CACHE_KEY))
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}

/** Drops the in-memory cache/in-flight guard so the next read picks up
 * whatever is under the now-current account's own key — unlike
 * clearLyricsCache() above, this doesn't touch localStorage at all: there
 * may be real data already waiting there for this account, it just wasn't
 * loaded under the *previous* account's in-memory singleton (see this
 * module's own comment on persistedCache). Wired up once from
 * services/accountScopedStores.ts via accountKey.ts's onAccountChange(). */
export function reloadLyricsCacheForAccount(): void {
  persistedCache = null
  inFlightSongId = null
}

const OFFSETS_KEY = 'beacon.lyricsOffsets'

function readStoredOffset(songId: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(accountScopedKey(OFFSETS_KEY)) ?? '{}') as Record<
      string,
      number
    >
    return all[songId] ?? 0
  } catch {
    return 0
  }
}

function writeStoredOffset(songId: string, offset: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(accountScopedKey(OFFSETS_KEY)) ?? '{}') as Record<
      string,
      number
    >
    if (offset === 0) delete all[songId]
    else all[songId] = offset
    localStorage.setItem(accountScopedKey(OFFSETS_KEY), JSON.stringify(all))
  } catch {
    // Losing a saved offset on write failure (e.g. storage full/disabled)
    // isn't worth surfacing — the in-memory value for this session still works.
  }
}

/** The song's own embedded/ID3-tag lyrics, if its server exposes them —
 * tried before the third-party lookup below since it matches this exact
 * file rather than "some song with this name/artist" that may be a
 * different edit. Null (not an error) on any server that doesn't support
 * the OpenSubsonic extension, same as a genuine "no lyrics tagged". */
async function fetchFileLyrics(song: Song): Promise<CachedPositive | null> {
  // Skipped entirely where the server has no such thing to answer with
  // (Plex, see services/capabilities.ts) — the call would otherwise be
  // made and thrown away once per track played, for an answer already
  // known in advance.
  if (!useAuthStore().capabilities.fileLyrics) return null
  const candidates = await useLibraryStore().client().getLyricsBySongId(song.id)
  const best = candidates.find((c) => c.synced) ?? candidates[0]
  if (!best || best.line.length === 0) return null
  const parsed = fromStructuredLyrics(best)
  if (parsed.lines.length === 0) return null
  return {
    synced: parsed.synced,
    lines: parsed.lines,
    credits: parsed.credits,
    source: FILE_SOURCE,
    remoteId: null,
  }
}

export const useLyricsStore = defineStore('lyrics', {
  state: (): LyricsState => ({
    songId: null,
    synced: false,
    lines: [],
    credits: [],
    loading: false,
    error: false,
    source: null,
    remoteId: null,
    candidates: null,
    candidatesLoading: false,
    offset: 0,
  }),

  actions: {
    /** Fetches (or reuses the persisted cache for) `song`'s lyrics. Not
     * called eagerly on every song change — only when a lyrics surface
     * (the drawer, or Now Playing's immersive lyrics mode) is actually
     * visible, see LyricsPanel.vue's consumers (LyricsDrawer.vue,
     * NowPlayingView.vue). */
    /** Re-asks the file about a song whose cached lyrics came from a
     * third-party provider. Written for the case that actually happens:
     * someone tags their library *after* having played the song, which
     * used to leave Beacon showing the provider's copy forever, since a
     * positive cache entry was never revisited.
     *
     * Silent either way — no loading state, no error surface. If the file
     * has lyrics now they replace what's on screen; if not, the existing
     * entry is kept and simply marked as checked, so this doesn't run
     * again for another week. */
    async recheckFileLyrics(song: Song, cached: CachedPositive): Promise<void> {
      let fromFile: CachedPositive | null = null
      try {
        fromFile = await fetchFileLyrics(song)
      } catch {
        // A failed re-check leaves the cached lyrics exactly as they were,
        // including their age, so the next play tries again.
        return
      }
      writeCacheEntry(song.id, fromFile ?? cached)
      // The song may have changed while this was in flight — the point of
      // this call is the *next* play either way, not overwriting whatever
      // is on screen now.
      if (!fromFile || this.songId !== song.id) return
      this.synced = fromFile.synced
      this.lines = fromFile.lines
      this.credits = fromFile.credits ?? []
      this.source = fromFile.source
      this.remoteId = fromFile.remoteId
    },

    async ensureLoaded(song: Song): Promise<void> {
      this.offset = readStoredOffset(song.id)

      const cached = loadPersistedCache()[song.id]
      if (cached && !('negative' in cached && isExpiredNegative(cached))) {
        this.songId = song.id
        this.loading = false
        this.error = false
        if ('negative' in cached) {
          this.synced = false
          this.lines = []
          this.credits = []
          this.source = null
          this.remoteId = null
        } else {
          this.synced = cached.synced
          this.lines = cached.lines
          this.credits = cached.credits ?? []
          this.source = cached.source
          this.remoteId = cached.remoteId
          // Shown first, checked after: whatever is cached is displayed
          // immediately, and the file is asked in the background only when
          // it's due (see shouldRecheckFile()). Nothing waits on it, so a
          // song whose lyrics haven't changed costs exactly what it did
          // before.
          if (shouldRecheckFile(cached)) void this.recheckFileLyrics(song, cached)
        }
        return
      }
      if (inFlightSongId === song.id) return // already fetching this one

      this.songId = song.id
      this.loading = true
      this.error = false
      this.synced = false
      this.lines = []
      this.credits = []
      this.source = null
      this.remoteId = null
      inFlightSongId = song.id
      try {
        let positive = await fetchFileLyrics(song)
        // Only actually asked once something is enabled — every provider,
        // by default (see stores/lyricsProviders.ts's own comment), but
        // Settings can empty that out. `queriedProviders` (not just
        // `positive`) decides below whether a miss is worth caching:
        // skipping the lookup entirely isn't the same fact as asking and
        // getting nothing back, and caching it as a negative would leave a
        // song stuck showing "no lyrics" for NEGATIVE_TTL_MS after someone
        // changes their provider selection, for a lookup that was never
        // actually tried with the new selection.
        let queriedProviders = false
        if (!positive) {
          const enabledSources = useLyricsProvidersStore().enabled
          if (enabledSources.length > 0) {
            queriedProviders = true
            const result = await autoLyrics(
              {
                name: song.title,
                artist: song.artist,
                album: song.album,
                duration: song.duration,
              },
              enabledSources,
            )
            const parsed = result ? parseLyrics(result.lyrics) : null
            // Lines, not just a result: a sheet can come back holding
            // nothing but the songwriter credits, which parseLyrics moves
            // out of the lyrics (see splitOffCredits). Two names are not a
            // song, and recording them as a hit would leave the panel
            // claiming a source for lyrics it doesn't have.
            if (result && parsed && parsed.lines.length > 0) {
              positive = {
                synced: parsed.synced,
                lines: parsed.lines,
                credits: parsed.credits,
                source: result.source,
                remoteId: result.id,
              }
            }
          }
        }
        if (positive || queriedProviders) {
          writeCacheEntry(song.id, positive ?? { negative: true, cachedAt: Date.now() })
        }
        // A newer song may have started while this was in flight — don't
        // let a slower, stale response overwrite what's actually playing now.
        if (this.songId !== song.id) return
        this.synced = positive?.synced ?? false
        this.lines = positive?.lines ?? []
        this.credits = positive?.credits ?? []
        this.source = positive?.source ?? null
        this.remoteId = positive?.remoteId ?? null
      } catch (error) {
        // Deliberately not cached (unlike a genuine "no match" above) — a
        // request failure is more likely transient than a stable fact
        // about the song, so the next ensureLoaded() call retries instead
        // of being stuck with a permanent false negative.
        console.error('[lyrics] Failed to fetch lyrics:', error)
        if (this.songId === song.id) this.error = true
      } finally {
        if (inFlightSongId === song.id) inFlightSongId = null
        if (this.songId === song.id) this.loading = false
      }
    },

    /** Fetches every third-party candidate for `song`, grouped by source
     * — backing the "pick a different match" affordance in LyricsPanel.vue
     * for when the automatic best match isn't the right one. Does not
     * touch the song's own file lyrics (there's nothing to "pick" there,
     * it's either tagged or it isn't). */
    async loadCandidates(song: Song): Promise<void> {
      this.candidatesLoading = true
      try {
        this.candidates = await searchLyrics({
          name: song.title,
          artist: song.artist,
          album: song.album,
          duration: song.duration,
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

    /** Applies one specific candidate from loadCandidates() as `song`'s
     * lyrics, overwriting whatever was cached/shown before — the explicit
     * override for when the automatic best match was wrong. */
    async selectCandidate(song: Song, source: string, id: string): Promise<void> {
      this.candidates = null
      this.loading = true
      this.error = false
      try {
        const raw = await getLyricsByRemoteId(source, id)
        const parsed = raw ? parseLyrics(raw) : null
        const positive: CachedPositive | null = parsed
          ? {
              synced: parsed.synced,
              lines: parsed.lines,
              credits: parsed.credits,
              source,
              remoteId: id,
            }
          : null
        writeCacheEntry(song.id, positive ?? { negative: true, cachedAt: Date.now() })
        if (this.songId !== song.id) return
        this.synced = positive?.synced ?? false
        this.lines = positive?.lines ?? []
        this.credits = positive?.credits ?? []
        this.source = positive?.source ?? null
        this.remoteId = positive?.remoteId ?? null
      } catch (error) {
        console.error('[lyrics] Failed to load selected lyrics candidate:', error)
        if (this.songId === song.id) this.error = true
      } finally {
        if (this.songId === song.id) this.loading = false
      }
    },

    /** Sets the current song's timing offset to an absolute value (unlike
     * adjustOffset below, not relative to whatever it already was) and
     * persists it. Used by the "click the line being sung" calibration
     * flow in LyricsPanel.vue, which computes the exact offset needed in
     * one shot rather than nudging toward it. No-op with nothing loaded. */
    setOffset(offsetSeconds: number): void {
      if (!this.songId) return
      // Rounded to avoid float noise, same as adjustOffset below.
      this.offset = Math.round(offsetSeconds * 10) / 10
      writeStoredOffset(this.songId, this.offset)
    },

    /** Nudges the current song's timing offset by `deltaSeconds` (typically
     * ±0.1) and persists it — see LyricsState.offset's comment on sign
     * convention. No-op with nothing loaded (nothing to offset). */
    adjustOffset(deltaSeconds: number): void {
      this.setOffset(this.offset + deltaSeconds)
    },
  },
})
