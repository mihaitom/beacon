import { fetchConnect } from '@/services/connect/http'

export interface NowPlayingReport {
  song: {
    id: string
    title: string
    artist: string
    album: string
    duration: number
    cover_art_id: string
  } | null
  radio: { station: string; title: string | null } | null
  position: number | null
  paused: boolean
  devices: string[]
}

/** Whether any of the account's own apps wants to know. */
export async function reportNowPlaying(report: NowPlayingReport): Promise<boolean> {
  const { wanted } = await fetchConnect<{ wanted: boolean }>('/now-playing/report', {
    method: 'POST',
    body: report,
  })
  return wanted
}

export async function stopNowPlayingReport(): Promise<void> {
  await fetchConnect('/now-playing/report', { method: 'DELETE' })
}
