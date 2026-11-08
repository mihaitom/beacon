// What this device tells connect about its own playback for the account's
// own apps: what, when, and that it stops asking once nobody wants to know.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

const fakePlayback = reactive({
  isCasting: false,
  radioStation: null as { name: string } | null,
  preview: null as unknown,
  currentSong: null as Record<string, unknown> | null,
  localPosition: 0,
  isPlaying: false,
})
const fakeConnect = reactive({ activeTargets: [] as { name: string }[] })
const fakeRadio = reactive({ nowPlaying: null as string | null })

vi.mock('@/stores/playback', () => ({ usePlaybackStore: () => fakePlayback }))
vi.mock('@/stores/connect', () => ({ useConnectStore: () => fakeConnect }))
vi.mock('@/stores/radioMetadata', () => ({ useRadioMetadataStore: () => fakeRadio }))
vi.mock('@/services/connect/nowPlaying', () => ({
  reportNowPlaying: vi.fn(async () => true),
  stopNowPlayingReport: vi.fn(async () => {}),
}))

import { reportNowPlaying, stopNowPlayingReport } from '@/services/connect/nowPlaying'
import {
  _test,
  HEARTBEAT_MS,
  initNowPlayingReport,
  resetNowPlayingReport,
} from '../nowPlayingReport'

const report = vi.mocked(reportNowPlaying)
const stop = vi.mocked(stopNowPlayingReport)

function song(id: string) {
  return { id, title: 'T', artist: 'A', album: 'B', duration: 200, coverArtId: 'c' }
}

function play(id = 'a', position = 0) {
  fakePlayback.currentSong = song(id)
  fakePlayback.localPosition = position
  fakePlayback.isPlaying = true
}

const lastSent = () => report.mock.calls.at(-1)![0]

describe('now playing report', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    report.mockResolvedValue(true)
    Object.assign(fakePlayback, {
      isCasting: false,
      radioStation: null,
      preview: null,
      currentSong: null,
      localPosition: 0,
      isPlaying: false,
    })
    fakeConnect.activeTargets = []
    fakeRadio.nowPlaying = null
  })

  afterEach(() => {
    resetNowPlayingReport()
    vi.useRealTimers()
    delete (window as { api?: unknown }).api
  })

  it('says nothing while nothing plays', async () => {
    await _test.tick()
    expect(report).not.toHaveBeenCalled()
  })

  it('describes the song', async () => {
    play('a', 12)
    await _test.tick()
    expect(lastSent()).toEqual({
      song: { id: 'a', title: 'T', artist: 'A', album: 'B', duration: 200, cover_art_id: 'c' },
      radio: null,
      position: 12,
      paused: false,
      devices: [],
    })
  })

  it('describes a station and its title', async () => {
    fakePlayback.radioStation = { name: 'Station One' }
    fakePlayback.isPlaying = true
    fakeRadio.nowPlaying = 'Artist - Tune'
    await _test.tick()
    expect(lastSent()).toMatchObject({
      song: null,
      radio: { station: 'Station One', title: 'Artist - Tune' },
      position: null,
    })
  })

  it('reports a new title on the same station', async () => {
    fakePlayback.radioStation = { name: 'Station One' }
    fakePlayback.isPlaying = true
    await _test.tick()
    fakeRadio.nowPlaying = 'Artist - Tune'
    await _test.tick()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('leaves a browser cast to connect, which knows it already', async () => {
    play()
    fakePlayback.isCasting = true
    await _test.tick()
    expect(report).not.toHaveBeenCalled()
  })

  it('reports a cast from the desktop app, whose connect is not the server', async () => {
    ;(window as { api?: unknown }).api = {}
    play()
    fakePlayback.isCasting = true
    fakeConnect.activeTargets = [{ name: 'Living room' }]
    await _test.tick()
    expect(lastSent().devices).toEqual(['Living room'])
  })

  it('reports a cast moving to another speaker', async () => {
    ;(window as { api?: unknown }).api = {}
    play()
    fakePlayback.isCasting = true
    fakeConnect.activeTargets = [{ name: 'Living room' }]
    await _test.tick()
    fakeConnect.activeTargets = [{ name: 'Kitchen' }]
    await _test.tick()
    expect(lastSent().devices).toEqual(['Kitchen'])
  })

  it('does not report a preview', async () => {
    play()
    fakePlayback.preview = {}
    await _test.tick()
    expect(report).not.toHaveBeenCalled()
  })

  it('stays quiet as time simply passes, then sends a heartbeat', async () => {
    play('a', 0)
    await _test.tick()
    vi.advanceTimersByTime(HEARTBEAT_MS - 1000)
    fakePlayback.localPosition = (HEARTBEAT_MS - 1000) / 1000
    await _test.tick()
    expect(report).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    fakePlayback.localPosition = HEARTBEAT_MS / 1000
    await _test.tick()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('keeps a paused song alive with heartbeats too', async () => {
    play()
    fakePlayback.isPlaying = false
    await _test.tick()
    vi.advanceTimersByTime(HEARTBEAT_MS)
    await _test.tick()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('reports a pause at once', async () => {
    play()
    await _test.tick()
    fakePlayback.isPlaying = false
    await _test.tick()
    expect(lastSent().paused).toBe(true)
  })

  it('reports a seek at once', async () => {
    play('a', 0)
    await _test.tick()
    vi.advanceTimersByTime(1000)
    fakePlayback.localPosition = 60
    await _test.tick()
    expect(lastSent().position).toBe(60)
  })

  it('reports the next song at once', async () => {
    play('a')
    await _test.tick()
    play('b')
    await _test.tick()
    expect(lastSent().song?.id).toBe('b')
  })

  it('takes back what it said when playing stops', async () => {
    play()
    await _test.tick()
    fakePlayback.currentSong = null
    await _test.tick()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does not take back what it never said', async () => {
    await _test.tick()
    expect(stop).not.toHaveBeenCalled()
  })

  describe('when nobody wants to know', () => {
    beforeEach(() => report.mockResolvedValue(false))

    it('stays quiet for the rest of the song', async () => {
      play('a')
      await _test.tick()
      fakePlayback.isPlaying = false
      await _test.tick()
      vi.advanceTimersByTime(HEARTBEAT_MS)
      await _test.tick()
      expect(report).toHaveBeenCalledTimes(1)
    })

    it('asks again with the next song', async () => {
      play('a')
      await _test.tick()
      play('b')
      await _test.tick()
      expect(report).toHaveBeenCalledTimes(2)
    })

    it('has nothing to take back', async () => {
      play('a')
      await _test.tick()
      fakePlayback.currentSong = null
      await _test.tick()
      expect(stop).not.toHaveBeenCalled()
    })
  })

  it('survives connect being away and tries again', async () => {
    report.mockRejectedValueOnce(new Error('away'))
    play()
    await _test.tick()
    vi.advanceTimersByTime(HEARTBEAT_MS)
    await _test.tick()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('reports a change without waiting for the next tick', async () => {
    initNowPlayingReport()
    play('a')
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(report).toHaveBeenCalledTimes(1)
  })
})
