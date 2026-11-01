/** Tells connect which picture Now Playing shows behind the current song -
 * the artist's Fanart.tv background or the cover - so the room lights take
 * their colours from what is in the foreground, the way the visualizer
 * bars do. Only while the lights are set up, and only on a change. */

import { fanartSource } from '@/services/connect/fanart'
import { reportPicture } from '@/services/connect/lights'
import { useLightsStore } from '@/stores/lights'

let last: { songId: string; url: string | null } | null = null

/** `shownUrl` is the image as Now Playing loads it (routed through
 * connect), or null for the cover. */
export async function reportForegroundPicture(
  songId: string | null,
  shownUrl: string | null,
): Promise<void> {
  if (!songId || !useLightsStore().active) return
  const url = shownUrl ? fanartSource(shownUrl) : null
  if (last && last.songId === songId && last.url === url) return
  last = { songId, url }
  try {
    await reportPicture(songId, url)
  } catch {
    // Not worth a word: the lights keep the cover's colours.
    last = null
  }
}

/** For tests. */
export function resetPictureReport(): void {
  last = null
}
