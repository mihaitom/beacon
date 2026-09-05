import { defineStore } from 'pinia'
import { autoLyrics, getLyricsByRemoteId, searchLyrics } from '@/services/connect/lyrics'
import type { LyricSearchResult } from '@/services/connect/types'
import { fromStructuredLyrics, parseLyrics, type LyricLine } from '@/services/lyrics/parseLrc'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { useLyricsProvidersStore } from '@/stores/lyricsProviders'
import { accountScopedKey, getAccountKey } from '@/services/accountKey'
import {
  clearLyricsStore,
  readLyrics,
  writeLyrics,
  writeManyLyrics,
} from '@/services/lyrics/lyricsStore'
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
// ask, not just "avoid refetching within one run." A negative entry expires
// after NEGATIVE_TTL_MS; a positive one is kept indefinitely, but one that
// came from a third-party provider is re-checked against the file itself
// from time to time (see shouldRecheckFile()) — the lyrics don't go stale,
// the question of where the best copy lives does.
//
// Kept in IndexedDB (services/lyrics/lyricsStore.ts), one record per song.
// It used to be a single localStorage blob, which put an unbounded,
// ever-growing cache inside the ~5 MB every other persisted thing in the
// app shares — see that module's own comment for what ran out first. This
// key is only read now, once, to carry an existing cache over.
const LEGACY_CACHE_KEY = 'beacon.lyricsCache'

// This session's own copy, so a song looked at twice (a replay, a re-render,
// the panel being reopened) doesn't go back to disk. The store behind it is
// per record, so unlike the old blob there is nothing to parse up front —
// this fills as songs are actually played.
let sessionCache = new Map<string, CacheEntry>()
let inFlightSongId: string | null = null

// Which account the cache currently holds lyrics for. Bumped whenever that
// changes, and captured by every lookup before it starts, so an answer that
// was already in flight when someone else logged in is recognized as
// belonging to the previous one and dropped rather than stored.
//
// Without it, a provider lookup started before the switch writes its result
// under a key built *after* it — song ids are only unique within one media
// server (Plex's are small integers), so that is one account's lyrics filed
// under another account's song. The artwork cache has the same guard for the
// same reason (see services/connect/coverArtBatch.ts's own `generation`).
let generation = 0

/** Records are namespaced by account rather than the store being wiped when
 * one logs out: two people sharing a browser each keep their own lyrics,
 * and switching back doesn't start from nothing. */
function storeKey(songId: string): string {
  const account = getAccountKey()
  return account ? `${account}::${songId}` : songId
}

/** Whatever is known about this song, from this session first and from disk
 * otherwise. Null when nothing is. */
async function readCacheEntry(songId: string): Promise<CacheEntry | null> {
  const started = generation
  const remembered = sessionCache.get(songId)
  if (remembered) return remembered
  const key = storeKey(songId)
  await migrateLegacyCache()
  const stored = await readLyrics<CacheEntry>(key)
  // Someone else logged in while this was reading — that entry belongs to
  // the account that has just been left.
  if (started !== generation) return null
  if (stored) sessionCache.set(songId, stored)
  return stored
}

/** `startedAt` is the generation the work behind this entry began in (see
 * `generation`); an entry from a previous one is dropped rather than
 * stored. Callers that have nothing asynchronous behind them can leave it
 * at the current one. */
function writeCacheEntry(songId: string, entry: CacheEntry, startedAt = generation): void {
  if (startedAt !== generation) return
  // Stamped here rather than at each call site, so no path can store a
  // provider hit without one — an entry with no timestamp counts as
  // overdue for its file re-check (see shouldRecheckFile()), which would
  // otherwise fire on every single play.
  const stamped: CacheEntry = 'negative' in entry ? entry : { ...entry, cachedAt: Date.now() }
  sessionCache.set(songId, stamped)
  writeLyrics(storeKey(songId), stamped)
}

/** Moves an existing cache out of the old single localStorage blob and into
 * the store, once per account per app run, and takes the old key with it.
 * Without this, upgrading would silently throw away every lyric anyone had
 * ever looked up.
 *
 * The entries go into this session's own copy as well as to the store, so
 * they keep working immediately — and keep working at all in a browser
 * where nothing can be persisted, where the store would otherwise have
 * swallowed them. */
let migrations = new Map<string, Promise<void>>()

async function migrateLegacyCache(): Promise<void> {
  const key = accountScopedKey(LEGACY_CACHE_KEY)
  let migration = migrations.get(key)
  if (migration) return migration
  migration = (async () => {
    let legacy: Record<string, CacheEntry>
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return
      legacy = JSON.parse(raw) as Record<string, CacheEntry>
    } catch {
      return
    }
    const entries: [string, CacheEntry][] = []
    for (const [songId, entry] of Object.entries(legacy)) {
      if (!entry) continue
      if (!sessionCache.has(songId)) sessionCache.set(songId, entry)
      entries.push([storeKey(songId), entry])
    }
    // One write for the whole cache, not one per song: the fallback backend
    // rewrites its entire blob per call, which for a few thousand entries
    // would be a visible freeze at first launch after an upgrade.
    writeManyLyrics(entries)
    try {
      localStorage.removeItem(key)
    } catch {
      // Storage disabled between the read and now — a second run would
      // simply copy the same entries again, which costs nothing.
    }
  })()
  migrations.set(key, migration)
  return migration
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
export function clearLyricsCache(): Promise<void> {
  sessionCache = new Map()
  // A lookup still in flight was started against what has just been thrown
  // away, and storing its answer would put back part of what someone asked
  // to be cleared.
  generation += 1
  const cleared = clearLyricsStore()
  try {
    localStorage.removeItem(accountScopedKey(LEGACY_CACHE_KEY))
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
  return cleared
}

/** Drops this session's copy and the in-flight guard so the next read goes
 * back to the store under the now-current account's own keys — unlike
 * clearLyricsCache() above, this deletes nothing: the previous account's
 * entries stay exactly where they are, and so do this one's, which may
 * already be there from an earlier login. Wired up once from
 * services/accountScopedStores.ts via accountKey.ts's onAccountChange(). */
export function reloadLyricsCacheForAccount(): void {
  sessionCache = new Map()
  migrations = new Map()
  inFlightSongId = null
  generation += 1
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
      const startedAt = generation
      let fromFile: CachedPositive | null = null
      try {
        fromFile = await fetchFileLyrics(song)
      } catch {
        // A failed re-check leaves the cached lyrics exactly as they were,
        // including their age, so the next play tries again.
        return
      }
      writeCacheEntry(song.id, fromFile ?? cached, startedAt)
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
      const startedAt = generation
      this.offset = readStoredOffset(song.id)

      const cached = await readCacheEntry(song.id)
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
          writeCacheEntry(song.id, positive ?? { negative: true, cachedAt: Date.now() }, startedAt)
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
      const startedAt = generation
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
        writeCacheEntry(song.id, positive ?? { negative: true, cachedAt: Date.now() }, startedAt)
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
