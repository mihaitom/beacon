import { watch } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'

const APP_NAME = 'Beacon'

/** "Title · Artist – Beacon", or the app's name alone with nothing loaded.
 * What the taskbar, Alt+Tab and a browser tab show: the song first, since
 * the name is what gets cut off when there is no room. */
export function windowTitle(primary: string | null, secondary: string | null): string {
  if (!primary) return APP_NAME
  return `${[primary, secondary].filter(Boolean).join(' · ')} – ${APP_NAME}`
}

/** Keeps document.title on what is playing - the Electron window takes its
 * title from the page. A station shows its current ICY title with the
 * station after it, the way the player bar labels it. */
export function initWindowTitle(): void {
  const playback = usePlaybackStore()
  const radioMeta = useRadioMetadataStore()
  watch(
    () => {
      const station = playback.radioStation
      if (station) {
        const tag = radioMeta.nowPlaying
        return windowTitle(tag ?? station.name, tag ? station.name : null)
      }
      const song = playback.currentSong
      return windowTitle(song?.title ?? null, song?.artist ?? null)
    },
    (title) => {
      document.title = title
    },
    { immediate: true },
  )
}
