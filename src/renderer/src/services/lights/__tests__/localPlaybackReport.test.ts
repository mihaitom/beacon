// What this device tells connect about its own playback, so the room
// lights can follow it: when it reports, what, and when it stops.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

const fakePlayback = reactive({
  isCasting: false,
  radioStation: null as unknown,
  preview: null as unknown,
  currentSong: null as { id: string } | null,
  localPosition: 0,
  isPlaying: false,
})

vi.mock('@/stores/playback', () => ({ usePlaybackStore: () => fakePlayback }))
vi.mock('@/services/connect/lights', () => ({
  reportLocalPlayback: vi.fn(async () => {}),
  stopLocalReport: vi.fn(async () => {}),
}))

async function load() {
  vi.resetModules()
  const lights = await import('@/services/connect/lights')
  const mod = await import('../localPlaybackReport')
  return {
    mod,
    report: vi.mocked(lights.reportLocalPlayback),
    stop: vi.mocked(lights.stopLocalReport),
  }
}

function play(songId: string, position = 0) {
  fakePlayback.currentSong = { id: songId }
  fakePlayback.localPosition = position
  fakePlayback.isPlaying = true
}

describe('which devices report', () => {
  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  async function reportsAfterStart() {
    vi.useFakeTimers()
    try {
      const ctx = await load()
      vi.clearAllMocks()
      ctx.mod.initLightsReport()
      play('a', 0)
      await vi.advanceTimersByTimeAsync(600)
      ctx.mod.resetLightsReport()
      return ctx.report.mock.calls.length > 0
    } finally {
      vi.useRealTimers()
    }
  }

  it('the desktop app does, a browser does not', async () => {
    ;(window as { api?: unknown }).api = {}
    expect(await reportsAfterStart()).toBe(true)
    delete (window as { api?: unknown }).api
    expect(await reportsAfterStart()).toBe(false)
  })
})

describe('reporting', () => {
  let ctx: Awaited<ReturnType<typeof load>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    Object.assign(fakePlayback, {
      isCasting: false,
      radioStation: null,
      preview: null,
      currentSong: null,
      localPosition: 0,
      isPlaying: false,
    })
    ctx = await load()
    // The mocked module outlives resetModules, and with it the call counts.
    vi.clearAllMocks()
  })

  afterEach(() => {
    ctx.mod.resetLightsReport()
    vi.useRealTimers()
  })

  const tick = () => ctx.mod._test.tick()

  it('reports a song as it starts, then only every few seconds', async () => {
    play('a', 0)
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(1)
    expect(ctx.report).toHaveBeenLastCalledWith('a', 0, true)

    vi.advanceTimersByTime(1000)
    fakePlayback.localPosition = 1
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(ctx.mod.REPORT_INTERVAL_MS)
    fakePlayback.localPosition = 4
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(2)
  })

  it('reports a seek at once', async () => {
    play('a', 10)
    await tick()
    vi.advanceTimersByTime(500)
    fakePlayback.localPosition = 90
    await tick()
    expect(ctx.report).toHaveBeenLastCalledWith('a', 90, true)
  })

  it('reports a new song and a pause at once', async () => {
    play('a', 10)
    await tick()
    play('b', 0)
    await tick()
    expect(ctx.report).toHaveBeenLastCalledWith('b', 0, true)
    fakePlayback.isPlaying = false
    await tick()
    expect(ctx.report).toHaveBeenLastCalledWith('b', 0, false)
    // Paused stays quiet.
    vi.advanceTimersByTime(10_000)
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(3)
  })

  it('stops reporting once casting, and says so once', async () => {
    play('a', 10)
    await tick()
    fakePlayback.isCasting = true
    await tick()
    await tick()
    expect(ctx.stop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(1)
  })

  it('never reports radio or a preview', async () => {
    play('a', 0)
    fakePlayback.radioStation = { name: 'x' }
    await tick()
    fakePlayback.radioStation = null
    fakePlayback.preview = { song: 'x' }
    await tick()
    expect(ctx.report).not.toHaveBeenCalled()
  })

  it('shrugs off a failed request and tries again on the next interval', async () => {
    ctx.report.mockRejectedValueOnce(new Error('connect away'))
    play('a', 0)
    await tick()
    vi.advanceTimersByTime(ctx.mod.REPORT_INTERVAL_MS)
    fakePlayback.localPosition = 3
    await tick()
    expect(ctx.report).toHaveBeenCalledTimes(2)
  })
})
