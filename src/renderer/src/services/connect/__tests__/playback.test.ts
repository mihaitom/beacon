import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

const DISPATCH_SEQ_KEY = 'beacon.dispatchSeq'

/** Re-imported per test: the dispatch sequence is module-level state that
 * deliberately survives a reload via localStorage, so each test has to
 * start from a module that hasn't counted anything yet. */
async function freshModule(): Promise<typeof import('../playback')> {
  vi.resetModules()
  return import('../playback')
}

/** The body of the nth request this test made. */
function body(call = 0): Record<string, unknown> {
  const [, options] = vi.mocked(fetchConnect).mock.calls[call]!
  return (options as { body: Record<string, unknown> }).body
}

function path(call = 0): string {
  return vi.mocked(fetchConnect).mock.calls[call]![0]
}

describe('connect playback dispatch', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(fetchConnect).mockResolvedValue({ status: 'ok' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('play', () => {
    it('sends a single song as a one-song queue, so connect has nothing to advance into', async () => {
      const { play } = await freshModule()

      await play('song-1')

      expect(path()).toBe('/play')
      expect(body()).toMatchObject({
        song_ids: ['song-1'],
        queue_index: 0,
        gain: 1.0,
        start_position: 0,
        repeat_mode: 'off',
        shuffle: false,
        force: false,
      })
    })

    it('sends the whole queue, history included, so connect can advance through it by itself', async () => {
      // That auto-advance is what keeps a cast going while the renderer
      // that started it is asleep.
      const { play } = await freshModule()

      await play('b', {
        fullQueue: ['a', 'b', 'c'],
        queueIndex: 1,
        originalQueue: ['a', 'b', 'c'],
        shuffle: true,
        repeatMode: 'all',
        autoplayEnabled: true,
        autoplayBatchSize: 5,
        gain: 0.7,
        startPosition: 42,
      })

      expect(body()).toMatchObject({
        song_ids: ['a', 'b', 'c'],
        queue_index: 1,
        original_queue: ['a', 'b', 'c'],
        shuffle: true,
        repeat_mode: 'all',
        autoplay_enabled: true,
        autoplay_batch_size: 5,
        gain: 0.7,
        start_position: 42,
      })
    })

    it('names the devices only, not whatever else the status carries about them', async () => {
      const { play } = await freshModule()

      await play('song-1', {
        targets: [
          { name: 'Living Room', type: 'sonos', volume: 30 },
          { name: 'Kitchen', type: 'airplay' },
        ] as NonNullable<Parameters<typeof play>[1]>['targets'],
      })

      expect(body().targets).toEqual([
        { name: 'Living Room', type: 'sonos' },
        { name: 'Kitchen', type: 'airplay' },
      ])
    })

    it('passes a quality ceiling through as the pair connect expects', async () => {
      const { play } = await freshModule()

      await play('song-1', { max_lossy_format: 'mp3', max_lossy_bitrate_kbps: 320 })

      expect(body()).toMatchObject({ max_lossy_format: 'mp3', max_lossy_bitrate_kbps: 320 })
    })

    it('leaves a half-set ceiling out entirely rather than making connect guess the rest', async () => {
      // Both absent reads as "no ceiling"; one alone reads as a caller bug.
      const { play } = await freshModule()

      await play('song-1', { max_lossy_format: 'mp3' })

      expect(body()).not.toHaveProperty('max_lossy_format')
      expect(body()).not.toHaveProperty('max_lossy_bitrate_kbps')
    })
  })

  describe('playUrl', () => {
    it('omits cast_directly entirely when not given, so connect keeps its own default (relayed)', async () => {
      const { playUrl } = await freshModule()

      await playUrl('https://stream.example/chill', 'Chill FM')

      expect(body()).not.toHaveProperty('cast_directly')
    })

    it('passes cast_directly through when the caller has an opinion either way', async () => {
      const { playUrl } = await freshModule()

      await playUrl('https://stream.example/chill', 'Chill FM', { castDirectly: true })
      await playUrl('https://stream.example/chill', 'Chill FM', { castDirectly: false })

      expect(body(0)).toMatchObject({ cast_directly: true })
      expect(body(1)).toMatchObject({ cast_directly: false })
    })
  })

  describe('the dispatch sequence', () => {
    it('rises with every dispatch, so an older one arriving late cannot win', async () => {
      const { play } = await freshModule()

      await play('a')
      await play('b')
      await play('c')

      const seqs = [0, 1, 2].map((call) => body(call).seq as number)
      expect(seqs[1]).toBeGreaterThan(seqs[0]!)
      expect(seqs[2]).toBeGreaterThan(seqs[1]!)
    })

    it('is shared with /play-url, which decides what is current just as much', async () => {
      const { play, playUrl } = await freshModule()

      await play('a')
      await playUrl('https://stream.example/chill', 'Chill FM')

      expect(path(1)).toBe('/play-url')
      expect(body(1).seq as number).toBeGreaterThan(body(0).seq as number)
    })

    it('is a timestamp, so two devices sharing a session compare against each other', async () => {
      // A phone logging in for the first time used to start its own counter
      // near zero and have its very first tap dropped as "superseded" by a
      // desktop that had been counting for a while.
      const { play } = await freshModule()

      await play('a')

      expect(body().seq).toBe(Date.now())
    })

    it('picks back up above where a reload left it, not below', async () => {
      // The backend's own counter survives a frontend reload untouched.
      const ahead = Date.now() + 60_000
      localStorage.setItem(DISPATCH_SEQ_KEY, String(ahead))
      const { play } = await freshModule()

      await play('a')

      expect(body().seq as number).toBeGreaterThan(ahead)
      expect(Number(localStorage.getItem(DISPATCH_SEQ_KEY))).toBe(body().seq)
    })

    it('still rises for two dispatches landing in the same millisecond', async () => {
      const { play, updateQueue } = await freshModule()

      await play('a')
      await updateQueue(['a', 'b'], 0)

      expect(body(1).seq as number).toBeGreaterThan(body(0).seq as number)
    })
  })

  describe('the plain transport commands', () => {
    it('asks connect to pause, resume, seek and stop', async () => {
      const { pause, resume, seek, stop } = await freshModule()

      await pause()
      await resume()
      await seek(42)
      await stop()

      expect(path(0)).toBe('/pause')
      expect(path(1)).toBe('/resume')
      expect(path(2)).toBe('/seek')
      expect(body(2)).toEqual({ position: 42 })
      expect(path(3)).toBe('/stop')
    })

    it('has its own call for picking playback back up after a device dropped out', async () => {
      // Nothing is paused in that case — the stream ended and the device
      // stopped, so resume() would have nothing to un-pause.
      const { resumeInterrupted } = await freshModule()

      await resumeInterrupted()

      expect(path()).toBe('/resume-interrupted')
    })
  })

  describe('updateQueue', () => {
    it('re-sends the whole queue so connect keeps advancing through the edited one', async () => {
      const { updateQueue } = await freshModule()

      await updateQueue(['a', 'b', 'c'], 2, {
        originalQueue: ['c', 'b', 'a'],
        shuffle: true,
        repeatMode: 'one',
        autoplayEnabled: true,
        autoplayBatchSize: 3,
      })

      expect(path()).toBe('/queue')
      expect(body()).toMatchObject({
        song_ids: ['a', 'b', 'c'],
        queue_index: 2,
        original_queue: ['c', 'b', 'a'],
        shuffle: true,
        repeat_mode: 'one',
        autoplay_enabled: true,
        autoplay_batch_size: 3,
      })
    })

    it('defaults the standing preferences it was not told about', async () => {
      const { updateQueue } = await freshModule()

      await updateQueue(['a'], 0)

      expect(body()).toMatchObject({
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off',
        autoplay_enabled: false,
        autoplay_batch_size: 10,
      })
    })
  })
})
