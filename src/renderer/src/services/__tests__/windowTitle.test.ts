import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '@/stores/playback'
import { useRadioMetadataStore } from '@/stores/radioMetadata'
import { makeSong } from '@/stores/__tests__/fixtures'
import { initWindowTitle } from '../windowTitle'

describe('the window title', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    initWindowTitle()
  })

  it('is the app alone with nothing loaded', () => {
    expect(document.title).toBe('Beacon')
  })

  it('names the song and its artist, and follows the next one', async () => {
    const playback = usePlaybackStore()
    playback.setQueue(
      [makeSong('a', { title: 'One', artist: 'A' }), makeSong('b', { title: 'Two', artist: 'B' })],
      0,
    )
    await nextTick()
    expect(document.title).toBe('One · A – Beacon')

    playback.currentIndex = 1
    await nextTick()
    expect(document.title).toBe('Two · B – Beacon')
  })

  it('names a station, and its ICY title first once there is one', async () => {
    usePlaybackStore().radioStation = {
      id: 'r',
      name: 'Some FM',
      streamUrl: 'http://s',
      homePageUrl: null,
    }
    await nextTick()
    expect(document.title).toBe('Some FM – Beacon')

    useRadioMetadataStore().nowPlaying = 'Artist - Track'
    await nextTick()
    expect(document.title).toBe('Artist - Track · Some FM – Beacon')
  })
})
