import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { usePlaybackStore } from '@/stores/playback'
import { isExternalSourceSong } from '@/services/connect/externalSource'
import type { Song } from '@/types/library'

/** The song-menu entries that exist only because of AudioMuse-AI, with the
 * error toast every menu would otherwise repeat. Neither has anything to
 * fall back on, so a failure has to be said. */

function failed(titleKey: string, messageKey: string, error: unknown): void {
  emitter.emit('toast', {
    level: 'error',
    title: i18n.global.t(titleKey),
    message: i18n.global.t(messageKey),
  })
  console.error(`[${titleKey}]`, error)
}

export async function playDiscoveryRadio(song: Song): Promise<void> {
  try {
    await usePlaybackStore().startDiscoveryRadio(song)
  } catch (error) {
    failed('library.discoveryRadio', 'library.discoveryRadioError', error)
  }
}

/** Whether a menu for `song` offers "Path to this song": AudioMuse answers,
 * something else from the library is playing, and `song` is in the library
 * too (AudioMuse has analysed only that). */
export function canPathTo(song: Song | null | undefined): boolean {
  if (!song || isExternalSourceSong(song) || !useAudioMuseStore().available) return false
  const playback = usePlaybackStore()
  const current = playback.currentSong
  if (!current || current.id === song.id || playback.radioStation || playback.preview) return false
  return !isExternalSourceSong(current)
}

export async function playPathTo(song: Song): Promise<void> {
  try {
    await usePlaybackStore().queuePathTo(song)
  } catch (error) {
    failed('library.pathTo', 'library.pathToError', error)
  }
}
