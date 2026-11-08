import { fetchConnect } from './http'
import type { MilestoneValues } from '@/services/library/statsMilestones'
import type { ImportSource } from '@/services/library/playHistoryImport'
import type { Song } from '@/types/library'

/** One line of a chart counted from the log, for an account whose play
 * counts this client cannot ask its server for. */
export interface PlayHistoryTop {
  id: string
  value: number
  label: string
  sublabel?: string
  album_id?: string
  artist_id?: string
  cover_art_id?: string
}

/** The Stats page's chart windows. "all_time" means no cutoff. */
export type PlayHistoryPeriod = 'week' | 'month' | 'quarter' | 'half_yearly' | 'year' | 'all_time'

/** The charts over one window of an account's log. */
export interface PlayHistoryCharts {
  period: PlayHistoryPeriod
  total: number
  top: Record<'songs' | 'artists' | 'albums' | 'genres', PlayHistoryTop[]>
}

export interface PlayHistorySummary {
  /** False for a session the server gave no name for: it has no log. */
  available: boolean
  total: number
  /** UTC seconds, oldest first. */
  timestamps: number[]
  /** When Beacon's own first entry was written, UTC seconds. */
  live_since: number | null
  /** Song id to plays in the last 30 days, Beacon's own entries only. */
  recent_plays: Record<string, number>
  top: Record<'songs' | 'artists' | 'albums' | 'genres', PlayHistoryTop[]>
  /** Own account only, and null until the first visit has set a baseline. */
  milestones?: MilestoneValues | null
}

export interface PlayHistoryImportStatus {
  status: 'none' | 'running' | 'done' | 'failed'
  source?: ImportSource
  fetched?: number
  error?: 'not_found' | 'unavailable'
  /** This desktop is paired with a server, and imports belong there. */
  paired?: boolean
}

export function recordListen(song: Song): Promise<unknown> {
  return fetchConnect('/play-history', {
    method: 'POST',
    body: {
      song_id: song.id,
      title: song.title,
      artist: song.artist,
      artist_id: song.artistId,
      album: song.album,
      album_id: song.albumId,
      cover_art_id: song.coverArtId ?? '',
      genre: song.genre ?? '',
      duration: song.duration || 0,
    },
  })
}

export function getPlayHistorySummary(username?: string): Promise<PlayHistorySummary> {
  const query = username === undefined ? '' : `?username=${encodeURIComponent(username)}`
  return fetchConnect<PlayHistorySummary>(`/play-history/summary${query}`)
}

export function getPlayHistoryCharts(
  period: PlayHistoryPeriod,
  username?: string,
): Promise<PlayHistoryCharts> {
  const params = new URLSearchParams({ period })
  if (username !== undefined) params.set('username', username)
  return fetchConnect<PlayHistoryCharts>(`/play-history/charts?${params.toString()}`)
}

export async function getPlayHistoryAccounts(): Promise<string[]> {
  return (await fetchConnect<{ accounts: string[] }>('/play-history/accounts')).accounts
}

export function saveMilestones(seen: MilestoneValues): Promise<unknown> {
  return fetchConnect('/play-history/milestones', { method: 'PUT', body: seen })
}

export function getImportStatus(): Promise<PlayHistoryImportStatus> {
  return fetchConnect<PlayHistoryImportStatus>('/play-history/import')
}

export function startImport(
  source: ImportSource,
  username: string,
  again = false,
): Promise<PlayHistoryImportStatus> {
  return fetchConnect<PlayHistoryImportStatus>('/play-history/import', {
    method: 'POST',
    body: { source, username, again },
  })
}
