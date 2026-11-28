import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import type { Song } from '@/types/library'

/** Discovery Radio from any song menu, with the error toast every menu
 * would otherwise repeat. Unlike Song Radio it has nothing to fall back on
 * (see startDiscoveryRadio()), so a failure has to be said. */
export async function playDiscoveryRadio(song: Song): Promise<void> {
  try {
    await usePlaybackStore().startDiscoveryRadio(song)
  } catch (error) {
    emitter.emit('toast', {
      level: 'error',
      title: i18n.global.t('library.discoveryRadio'),
      message: i18n.global.t('library.discoveryRadioError'),
    })
    console.error('[discovery-radio]', error)
  }
}
