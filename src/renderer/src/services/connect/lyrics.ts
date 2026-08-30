import { fetchConnect } from './http'
import type { AutoLyricsResult, LyricSearchResult } from './types'

interface LyricsQuery {
  name?: string
  artist?: string
  album?: string
  duration?: number
}

function buildParams(query: LyricsQuery, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams(extra)
  if (query.name) params.set('name', query.name)
  if (query.artist) params.set('artist', query.artist)
  if (query.album) params.set('album', query.album)
  if (query.duration != null) params.set('duration', String(query.duration))
  return params
}

/** Best-match lyrics for a song (connect/routes/lyrics.py's /lyrics/auto)
 * — what the playback UI actually uses, see stores/lyrics.ts. Null when
 * nothing matched well enough (MATCH_THRESHOLD on the backend). `sources`
 * restricts which third-party providers get queried — stores/lyrics.ts
 * only calls this at all once stores/lyricsProviders.ts has at least one
 * enabled, and passes exactly that list through, same as searchLyrics()
 * below already does. An empty/omitted list falls back to every source on
 * the backend (_parse_sources), which is why the frontend never calls this
 * without first checking there's something to pass. */
export async function autoLyrics(
  query: LyricsQuery,
  sources?: string[],
): Promise<AutoLyricsResult | null> {
  const params = buildParams(query, sources?.length ? { sources: sources.join(',') } : {})
  return fetchConnect<AutoLyricsResult | null>(`/lyrics/auto?${params.toString()}`)
}

/** Per-source candidate lists (/lyrics/search) — not used yet, exists for a
 * future "pick a different match" affordance alongside getLyricsByRemoteId. */
export async function searchLyrics(
  query: LyricsQuery,
  sources?: string[],
): Promise<Record<string, LyricSearchResult[]>> {
  const params = buildParams(query, sources?.length ? { sources: sources.join(',') } : {})
  return fetchConnect<Record<string, LyricSearchResult[]>>(`/lyrics/search?${params.toString()}`)
}

/** Raw lyrics for one specific search candidate (/lyrics/by-remote-id) —
 * same future use as searchLyrics() above. */
export async function getLyricsByRemoteId(source: string, id: string): Promise<string | null> {
  const params = new URLSearchParams({ source, id })
  return fetchConnect<string | null>(`/lyrics/by-remote-id?${params.toString()}`)
}
