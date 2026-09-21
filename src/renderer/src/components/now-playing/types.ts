import type { Song } from '@/types/library'

/** One card in NowPlayingTrackPanels' corner stack, already resolved to
 * display values by NowPlayingView's cornerPanels computed so the component
 * stays presentational. */
export interface NowPlayingPanel {
  key: string
  kind: 'song' | 'chevrons'
  song: Song | null
  eyebrow: string
  title: string
  /** The station name, shown as the secondary line only when an ICY tag is
   * what the title shows. Null otherwise. */
  radioTag: string | null
}
