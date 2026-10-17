import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import { initTaskbar, taskbarState } from '../taskbar'
import type { TaskbarCommand } from '../../../../preload/index.d'

describe('the Windows taskbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  it('offers nothing with nothing loaded', () => {
    expect(taskbarState()).toMatchObject({
      canPlay: false,
      canPrevious: false,
      canNext: false,
      progress: null,
    })
  })

  it("shows a song's progress, and skips only where there is somewhere to go", () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)
    playback.duration = 200
    playback.localPosition = 50

    expect(taskbarState()).toMatchObject({
      canPlay: true,
      canPrevious: true,
      canNext: false,
      progress: 0.25,
    })
  })

  /** A live stream has no queue to skip through and no end to measure. */
  it('plays and pauses a station, nothing more', () => {
    usePlaybackStore().radioStation = {
      id: 'r',
      name: 'FM',
      streamUrl: 'http://s',
      homePageUrl: null,
    }

    expect(taskbarState()).toMatchObject({ canPlay: true, canPrevious: false, progress: null })
  })

  it('passes the buttons on, and sends the state only when it changes', async () => {
    let onCommand: (command: TaskbarCommand) => void = () => {}
    const update = vi.fn()
    ;(window as { api?: unknown }).api = {
      taskbar: { update, onCommand: (handler: typeof onCommand) => (onCommand = handler) },
    }
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    playback.duration = 1000
    const next = vi.spyOn(playback, 'playNext').mockResolvedValue()
    initTaskbar()
    expect(update).toHaveBeenCalledTimes(1)

    playback.localPosition = 1 // still 0%
    await nextTick()
    expect(update).toHaveBeenCalledTimes(1)
    playback.localPosition = 500
    await nextTick()
    expect(update).toHaveBeenCalledTimes(2)

    onCommand('next')
    expect(next).toHaveBeenCalledOnce()
  })
})
