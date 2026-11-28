import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { getSonicMoods, sonicMix } from '@/services/connect/audiomuse'
import { makeSong } from '@/stores/__tests__/fixtures'
import { sonicHomeShelvesMixin } from '../sonicHomeShelves'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
vi.mock('@/services/connect/audiomuse', () => ({
  getAudioMuseStatus: vi.fn().mockResolvedValue({ available: false, reason: 'not-configured' }),
  getSonicMoods: vi.fn(),
  sonicMix: vi.fn(),
}))

const Host = { mixins: [sonicHomeShelvesMixin], template: '<div />' }

function played(count: number) {
  return Array.from({ length: count }, (_, i) => makeSong(`top${i}`, { playCount: 100 - i }))
}

function audiomuseAnswers() {
  const store = useAudioMuseStore()
  store.status = { available: true }
  store.checkedAt = Date.now()
}

function mountHome() {
  return mount(Host, { global: { plugins: [i18n] } })
}

type HomeVm = {
  soundsLikeYouSongs: { id: string }[]
  sonicMoods: string[]
  loadSoundsLikeYou(): Promise<void>
  playMood(mood: string): Promise<void>
  moodPlaying: string | null
}

describe("Home's AudioMuse rows", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sonicMix)
      .mockReset()
      .mockResolvedValue([makeSong('new')])
    vi.mocked(getSonicMoods).mockReset().mockResolvedValue(['sad', 'happy'])
  })

  it('blends a few of the most played songs, never offering them back', async () => {
    audiomuseAnswers()
    useLibraryStore().allSongs = played(15)
    const vm = mountHome().vm as unknown as HomeVm
    await flushPromises()

    const request = vi.mocked(sonicMix).mock.calls[0]![0]
    const top = played(15).map((s) => s.id)
    expect(request.method).toBe('blend')
    expect(request.add.length).toBeLessThan(top.length)
    expect(request.add.every((item) => top.includes(item.id))).toBe(true)
    expect(request.exclude).toEqual(top)
    expect(vm.soundsLikeYouSongs.map((s) => s.id)).toEqual(['new'])
  })

  it('waits for the play counts when AudioMuse answers first', async () => {
    audiomuseAnswers()
    mountHome()
    await flushPromises()
    expect(sonicMix).not.toHaveBeenCalled()

    useLibraryStore().allSongs = played(3)
    await flushPromises()
    expect(sonicMix).toHaveBeenCalledTimes(1)
  })

  it('asks nothing without AudioMuse', async () => {
    useLibraryStore().allSongs = played(15)
    mountHome()
    await flushPromises()
    expect(sonicMix).not.toHaveBeenCalled()
    expect(getSonicMoods).not.toHaveBeenCalled()
  })

  it('shows an empty shelf rather than an old one when the blend fails', async () => {
    audiomuseAnswers()
    useLibraryStore().allSongs = played(15)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const vm = mountHome().vm as unknown as HomeVm
    await flushPromises()

    vi.mocked(sonicMix).mockRejectedValue(new Error('503'))
    await vm.loadSoundsLikeYou()
    expect(vm.soundsLikeYouSongs).toEqual([])
  })

  it('offers the moods it has a name for, in its own order', async () => {
    audiomuseAnswers()
    vi.mocked(getSonicMoods).mockResolvedValue(['sad', 'grumpy', 'happy'])
    const vm = mountHome().vm as unknown as HomeVm
    await flushPromises()
    expect(vm.sonicMoods).toEqual(['happy', 'sad'])
  })

  it('marks the mood the queue was started from, until something else plays', () => {
    const playback = usePlaybackStore()
    const vm = mountHome().vm as unknown as HomeVm
    playback.setQueue([makeSong('m1'), makeSong('m2')], 0)
    playback.moodMix = 'relaxed'
    expect(vm.moodPlaying).toBe('relaxed')

    playback.setQueue([makeSong('m1')], 0)
    expect(vm.moodPlaying).toBeNull()
  })

  it('says so when a mood finds nothing', async () => {
    audiomuseAnswers()
    vi.spyOn(usePlaybackStore(), 'startMoodMix').mockRejectedValue(new Error('empty'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    emitter.on('toast', toast)
    const vm = mountHome().vm as unknown as HomeVm

    await vm.playMood('sad')

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
    emitter.off('toast', toast)
  })
})
