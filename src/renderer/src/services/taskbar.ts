import { watch } from 'vue'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import type { TaskbarState } from '../../../preload/index.d'

/** What the Windows taskbar shows for this window (see main's
 * updateTaskbar()): the same three buttons as the player bar, the same
 * enabled states, and how far into the song it is. */
export function taskbarState(): TaskbarState {
  const playback = usePlaybackStore()
  const isRadio = playback.radioStation != null
  const loaded = playback.currentSong != null || isRadio
  const t = (key: string) => i18n.global.t(key)
  return {
    playing: playback.isPlaying,
    canPlay: loaded,
    canPrevious: loaded && !isRadio,
    canNext: loaded && !isRadio && playback.hasNext,
    // Whole percent: finer than that is invisible on an icon, and every
    // change is a message to the main process.
    progress:
      !isRadio && playback.currentSong && playback.duration > 0
        ? Math.round((playback.localPosition / playback.duration) * 100) / 100
        : null,
    labels: {
      previous: t('player.previous'),
      play: t(playback.isPlaying ? 'player.pause' : 'player.play'),
      next: t('player.next'),
    },
  }
}

/** Desktop app only - the web build has no taskbar of its own. */
export function initTaskbar(): void {
  const taskbar = window.api?.taskbar
  if (!taskbar) return
  const playback = usePlaybackStore()
  taskbar.onCommand((command) => {
    if (command === 'previous') void playback.playPrevious()
    else if (command === 'next') void playback.playNext()
    else void playback.togglePlay()
  })
  // Compared as text: the state is rebuilt on every position tick, and only
  // a change in what it says is worth a message.
  watch(
    () => JSON.stringify(taskbarState()),
    (state) => taskbar.update(JSON.parse(state)),
    { immediate: true },
  )
}
