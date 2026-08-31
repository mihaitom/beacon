import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine, getAudioEngine } from '@/services/audioEngine'

/** Stands in for the real TimeRanges a browser reports on `audio.buffered`
 * — enough of the interface for reportBuffered() to walk. */
class FakeTimeRanges {
  constructor(private readonly ranges: [number, number][]) {}

  get length(): number {
    return this.ranges.length
  }

  start(i: number): number {
    return this.ranges[i]![0]
  }

  end(i: number): number {
    return this.ranges[i]![1]
  }
}

/** Stands in for the <audio> element the engine builds in its constructor.
 * `dropWritesBeforeMetadata` is the whole point of it: Safari discards a
 * currentTime written before 'loadedmetadata' (the desktop browsers buffer
 * and apply it instead), and that difference is what load()'s retry exists
 * for — so both behaviours have to be reproducible here. */
class FakeAudio extends EventTarget {
  static last: FakeAudio

  src = ''
  preload = ''
  crossOrigin: string | null = null
  volume = 1
  paused = true
  ended = false
  error: { message: string; code?: number } | null = null
  duration = Number.NaN
  buffered: FakeTimeRanges = new FakeTimeRanges([])

  setBuffered(ranges: [number, number][]): void {
    this.buffered = new FakeTimeRanges(ranges)
  }

  dropWritesBeforeMetadata = false
  metadataLoaded = false
  /** Built fresh per call so start()'s catch is attached in the same tick a
   * rejection is created — a pre-built rejected promise would surface as an
   * unhandled rejection before the engine ever gets to it. */
  playImpl: () => Promise<void> = () => Promise.resolve()

  play = vi.fn(() => this.playImpl())
  pause = vi.fn()
  load = vi.fn()
  removeAttribute = vi.fn()

  private time = 0

  constructor() {
    super()
    FakeAudio.last = this
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(value: number) {
    if (this.dropWritesBeforeMetadata && !this.metadataLoaded) return
    this.time = value
  }

  /** Bypasses the setter above, standing in for the browser landing a seek
   * on a nearby decodable point rather than the exact second asked for. */
  settleAt(value: number): void {
    this.time = value
  }

  emitLoadedMetadata(): void {
    this.metadataLoaded = true
    this.dispatchEvent(new Event('loadedmetadata'))
  }
}

class FakeAnalyser {
  fftSize = 0
  smoothingTimeConstant = 0
  minDecibels = 0
  maxDecibels = 0
  connect = vi.fn()
}

class FakeGain {
  gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
  }
  connect = vi.fn()
}

class FakeAudioContext {
  static last: FakeAudioContext

  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  destination = {}
  analyser = new FakeAnalyser()
  /** setupAnalyser() builds these in order: ReplayGain first, the
   * listener's volume second. */
  gain = new FakeGain()
  volume = new FakeGain()
  source = { connect: vi.fn() }

  createMediaElementSource = vi.fn(() => this.source)
  createAnalyser = vi.fn(() => this.analyser)
  createGain = vi.fn(() => (this.createGain.mock.calls.length === 1 ? this.gain : this.volume))
  // Both track the state the way a real context does, so a test can play,
  // pause and play again and have each call see the right one.
  resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  suspend = vi.fn(() => {
    this.state = 'suspended'
    return Promise.resolve()
  })

  constructor() {
    FakeAudioContext.last = this
  }
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name)
}

describe('AudioEngine', () => {
  let audio: FakeAudio
  let context: FakeAudioContext
  let engine: AudioEngine

  /** The one query webAudioAllowed() asks. jsdom's own matchMedia stub
   * (see __tests__/setup.ts) answers false to everything, which is the
   * desktop answer — this is how a test says "touch device" instead. */
  function pretendTouchDevice(): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  }

  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    engine = new AudioEngine()
    audio = FakeAudio.last
    context = FakeAudioContext.last
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('the analyser graph', () => {
    it('taps the element as a same-origin source, so the visualizer reads real samples and not silence', () => {
      expect(audio.crossOrigin).toBe('anonymous')
      expect(context.createMediaElementSource).toHaveBeenCalledWith(audio)
    })

    it('routes the tapped signal back to the speakers', () => {
      // Without the last hop the element's audio would be consumed by the
      // graph and never reach the output at all.
      expect(context.source.connect).toHaveBeenCalledWith(context.analyser)
      expect(context.analyser.connect).toHaveBeenCalledWith(context.gain)
      expect(context.gain.connect).toHaveBeenCalledWith(context.volume)
      expect(context.volume.connect).toHaveBeenCalledWith(context.destination)
    })

    it('builds it at construction, before anything has ever played', () => {
      // Doing it later reroutes a live element and is audible as a dropout,
      // which is why this cannot move back into getAnalyser().
      expect(context.createMediaElementSource).toHaveBeenCalledOnce()
      expect(audio.src).toBe('')
    })

    it('wakes a context the autoplay policy started suspended', () => {
      context.state = 'suspended'

      engine.getAnalyser()

      expect(context.resume).toHaveBeenCalledOnce()
    })

    it('leaves a running context alone', () => {
      engine.getAnalyser()

      expect(context.resume).not.toHaveBeenCalled()
    })

    it('wakes it on play, not only once someone opens the visualizer', () => {
      // The graph is built at startup, without a user gesture, so Safari
      // starts it suspended — and since the element's whole output runs
      // through it, that means silence rather than just a missing
      // visualizer. Chromium wakes it by itself after the first gesture,
      // which is why only the mobile web build ever went quiet.
      context.state = 'suspended'

      engine.play('song.mp3')

      expect(context.resume).toHaveBeenCalledOnce()
      expect(audio.play).toHaveBeenCalledOnce()
    })

    it('wakes it when resuming a paused song too', () => {
      context.state = 'suspended'

      engine.resume()

      expect(context.resume).toHaveBeenCalledOnce()
    })

    it('does not wake a context that is already running on every play', () => {
      engine.play('song.mp3')

      expect(context.resume).not.toHaveBeenCalled()
    })

    it('is not built on a phone, where it would cost playback at the lock screen', () => {
      // WebKit suspends a context on lock, and an element routed through
      // one goes with it — see webAudioAllowed(). A plain element keeps
      // playing, which matters more on a phone than the visualizer does.
      pretendTouchDevice()

      const mobile = new AudioEngine()

      expect(mobile.hasAnalyser).toBe(false)
      // The element itself is untouched, so playback is exactly as usual.
      expect(() => mobile.play('song.mp3', 30)).not.toThrow()
      expect(FakeAudio.last.src).toBe('song.mp3')
      expect(FakeAudio.last.currentTime).toBe(30)
    })

    it('is built for a desktop browser, narrow window and all', () => {
      // A resized desktop window is still a mouse-driven desktop browser
      // with no lock screen to lose playback to.
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))

      expect(new AudioEngine().hasAnalyser).toBe(true)
    })

    it('is built in the desktop app whatever the pointer says', () => {
      // A touchscreen laptop running the installed app has no reason to
      // lose the visualizer.
      pretendTouchDevice()
      vi.stubGlobal('api', {})

      expect(new AudioEngine().hasAnalyser).toBe(true)
    })

    it('keeps plain playback working where Web Audio setup fails outright', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal(
        'AudioContext',
        class {
          constructor() {
            throw new Error('Web Audio unavailable')
          }
        },
      )

      const degraded = new AudioEngine()

      expect(logged).toHaveBeenCalled()
      expect(degraded.hasAnalyser).toBe(false)
      // Only the visualizer and ReplayGain are lost — the element still plays.
      expect(() => degraded.getAnalyser()).toThrow(/unavailable/)
      expect(() => degraded.setReplayGain(0.5)).not.toThrow()
      expect(() => degraded.play('song.mp3')).not.toThrow()
      // And volume falls back to the element, rather than being lost too.
      degraded.setVolume(0.25)
      expect(FakeAudio.last.volume).toBe(0.25)
      expect(() => degraded.pause()).not.toThrow()
      expect(() => degraded.stop()).not.toThrow()
    })
  })

  describe('preload', () => {
    it('hints the browser to buffer ahead rather than the bare minimum', () => {
      // Left to some browsers' own default (mobile Chrome on cellular in
      // particular), a bigger buffer than the connection strictly needs
      // right now is exactly what rides out a brief reception gap.
      expect(audio.preload).toBe('auto')
    })
  })

  describe('buffered reporting', () => {
    it('reports the end of the buffered range that actually contains the playhead', () => {
      const onBufferedChange = vi.fn()
      engine.play('song.mp3')
      onBufferedChange.mockClear() // load()'s own initial 0 report
      engine.onBufferedChange = onBufferedChange
      audio.settleAt(10)
      audio.setBuffered([[0, 30]])

      audio.dispatchEvent(new Event('progress'))

      expect(onBufferedChange).toHaveBeenCalledWith(30)
    })

    it('ignores a stale range the playhead has already moved past', () => {
      const onBufferedChange = vi.fn()
      engine.play('song.mp3')
      engine.onBufferedChange = onBufferedChange
      audio.settleAt(50)
      // The first range is left over from before a seek — reporting its
      // end (20) would draw the buffered band behind the playhead.
      audio.setBuffered([
        [0, 20],
        [45, 80],
      ])

      audio.dispatchEvent(new Event('progress'))

      expect(onBufferedChange).toHaveBeenCalledWith(80)
    })

    it('reports 0 when nothing covers the current position yet', () => {
      const onBufferedChange = vi.fn()
      engine.play('song.mp3')
      engine.onBufferedChange = onBufferedChange
      audio.settleAt(50)
      audio.setBuffered([[0, 20]])

      audio.dispatchEvent(new Event('progress'))

      expect(onBufferedChange).toHaveBeenCalledWith(0)
    })

    it('updates on a seek into an already-buffered stretch, which fires no progress event of its own', () => {
      const onBufferedChange = vi.fn()
      engine.play('song.mp3')
      engine.onBufferedChange = onBufferedChange
      audio.setBuffered([[0, 100]])
      audio.settleAt(60)

      audio.dispatchEvent(new Event('seeked'))

      expect(onBufferedChange).toHaveBeenCalledWith(100)
    })

    it('resets to 0 the moment a new track loads, before anything of it is buffered', () => {
      engine.play('first.mp3')
      audio.setBuffered([[0, 200]])
      const onBufferedChange = vi.fn()
      engine.onBufferedChange = onBufferedChange

      engine.play('second.mp3')

      expect(onBufferedChange).toHaveBeenCalledWith(0)
    })
  })

  describe('connection drop', () => {
    // MediaError.MEDIA_ERR_NETWORK — the only code the engine treats as
    // worth an automatic reconnect (see the module's own constant).
    const NETWORK_ERROR_CODE = 2

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function dropConnection(): void {
      audio.error = { message: 'network error', code: NETWORK_ERROR_CODE }
      audio.dispatchEvent(new Event('error'))
    }

    it('reconnects from the last reported position instead of reporting an error straight away', async () => {
      const onError = vi.fn()
      engine.onError = onError
      engine.play('song.mp3')
      audio.settleAt(42)
      audio.dispatchEvent(new Event('timeupdate'))
      audio.play.mockClear()

      dropConnection()
      expect(onError).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)

      expect(audio.src).toBe('song.mp3')
      expect(audio.currentTime).toBe(42)
      expect(audio.play).toHaveBeenCalledOnce()
    })

    it('reports the buffer as empty again once a reconnect actually retries', async () => {
      const onBufferedChange = vi.fn()
      engine.play('song.mp3')
      audio.setBuffered([[0, 200]])
      engine.onBufferedChange = onBufferedChange

      dropConnection()
      await vi.advanceTimersByTimeAsync(1000)

      expect(onBufferedChange).toHaveBeenCalledWith(0)
    })

    it('backs off between attempts instead of hammering the server', async () => {
      engine.play('song.mp3')
      audio.play.mockClear()

      dropConnection()
      await vi.advanceTimersByTimeAsync(999)
      expect(audio.play).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(audio.play).toHaveBeenCalledOnce()
    })

    it('gives up after repeated drops and reports a real error', async () => {
      const onError = vi.fn()
      engine.onError = onError
      engine.play('song.mp3')

      // Five attempts, each covered by its own (growing, capped) backoff —
      // none of them a real reconnect, since the fake never fires 'playing'.
      for (let i = 0; i < 5; i++) {
        dropConnection()
        await vi.advanceTimersByTimeAsync(8000)
      }
      expect(onError).not.toHaveBeenCalled()

      dropConnection()
      expect(onError).toHaveBeenCalledWith('Playback error: connection lost')
    })

    it('resets the attempt count once a reconnect actually succeeds', async () => {
      const onError = vi.fn()
      engine.onError = onError
      engine.play('song.mp3')

      dropConnection()
      await vi.advanceTimersByTimeAsync(1000)
      audio.dispatchEvent(new Event('playing'))

      // A fresh set of five attempts, not one more on top of the first —
      // still no error, where four extra attempts on the same budget would
      // have exhausted it.
      for (let i = 0; i < 5; i++) {
        dropConnection()
        await vi.advanceTimersByTimeAsync(8000)
      }
      expect(onError).not.toHaveBeenCalled()
    })

    it('reports a non-network error immediately, without retrying', () => {
      const onError = vi.fn()
      engine.onError = onError
      engine.play('song.mp3')
      audio.play.mockClear()

      // MediaError.MEDIA_ERR_DECODE — retrying gets the same failure again.
      audio.error = { message: 'decode failed', code: 3 }
      audio.dispatchEvent(new Event('error'))

      expect(onError).toHaveBeenCalledWith('decode failed')
      expect(audio.play).not.toHaveBeenCalled()
    })

    it('does not resurrect playback a pause already stopped', async () => {
      engine.play('song.mp3')
      dropConnection()
      engine.pause()
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(audio.play).not.toHaveBeenCalled()
    })

    it('does not resurrect playback once stop() moved on', async () => {
      engine.play('song.mp3')
      dropConnection()
      engine.stop()
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(audio.play).not.toHaveBeenCalled()
    })

    it('does not carry a reconnect over to the next track', async () => {
      engine.play('first.mp3')
      dropConnection()
      engine.play('second.mp3')
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(audio.play).not.toHaveBeenCalled()
      expect(audio.src).toBe('second.mp3')
    })
  })

  describe('element events', () => {
    it('reports the position as it advances', () => {
      const onTimeUpdate = vi.fn()
      engine.onTimeUpdate = onTimeUpdate
      audio.settleAt(12.5)

      audio.dispatchEvent(new Event('timeupdate'))

      expect(onTimeUpdate).toHaveBeenCalledWith(12.5)
    })

    it('reports the end of a track', () => {
      const onEnded = vi.fn()
      engine.onEnded = onEnded

      audio.dispatchEvent(new Event('ended'))

      expect(onEnded).toHaveBeenCalledOnce()
    })

    it('passes the element error through where there is one to report', () => {
      const onError = vi.fn()
      engine.onError = onError
      audio.error = { message: 'MEDIA_ELEMENT_ERROR: Format error' }

      audio.dispatchEvent(new Event('error'))

      expect(onError).toHaveBeenCalledWith('MEDIA_ELEMENT_ERROR: Format error')
    })

    it('still reports an error the element describes as nothing at all', () => {
      const onError = vi.fn()
      engine.onError = onError

      audio.dispatchEvent(new Event('error'))

      expect(onError).toHaveBeenCalledWith('Playback error')
    })

    it('reports a duration once the element knows one', () => {
      const onDurationChange = vi.fn()
      engine.onDurationChange = onDurationChange
      audio.duration = 240

      audio.dispatchEvent(new Event('durationchange'))

      expect(onDurationChange).toHaveBeenCalledWith(240)
    })

    it('says nothing about the endless duration of a live radio stream', () => {
      const onDurationChange = vi.fn()
      engine.onDurationChange = onDurationChange
      audio.duration = Number.POSITIVE_INFINITY

      audio.dispatchEvent(new Event('durationchange'))

      expect(onDurationChange).not.toHaveBeenCalled()
    })
  })

  describe('start position', () => {
    it('writes it straight away, as the desktop path has always relied on', () => {
      engine.load('song.mp3', 30)

      expect(audio.currentTime).toBe(30)
    })

    it('leaves an applied position alone once metadata arrives', () => {
      engine.load('song.mp3', 30)
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(30)
    })

    it('does not fight the browser rounding a seek to a nearby point', () => {
      engine.load('song.mp3', 30)
      audio.settleAt(30.2)
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(30.2)
    })

    it('re-applies it from metadata where the early write was dropped', () => {
      audio.dropWritesBeforeMetadata = true

      engine.load('song.mp3', 30)
      expect(audio.currentTime).toBe(0)

      audio.emitLoadedMetadata()
      expect(audio.currentTime).toBe(30)
    })

    it('survives an element that rejects the early write outright', () => {
      audio.dropWritesBeforeMetadata = true
      const failing = vi.spyOn(audio, 'currentTime', 'set').mockImplementationOnce(() => {
        throw domError('InvalidStateError', 'The object is in an invalid state.')
      })

      expect(() => engine.load('song.mp3', 30)).not.toThrow()
      failing.mockRestore()

      audio.emitLoadedMetadata()
      expect(audio.currentTime).toBe(30)
    })

    it('applies the newer load(), not the one it replaced', () => {
      audio.dropWritesBeforeMetadata = true

      engine.load('first.mp3', 30)
      engine.load('second.mp3', 90)
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(90)
    })

    it('stays at 0 when the newer load() asks for the start of a song', () => {
      audio.dropWritesBeforeMetadata = true

      engine.load('first.mp3', 30)
      engine.load('second.mp3')
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(0)
    })

    it('lets a seek made before metadata stand', () => {
      engine.load('song.mp3', 30)
      engine.seek(90)
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(90)
    })

    it('does not resurrect a position on an element that was stopped', () => {
      audio.dropWritesBeforeMetadata = true

      engine.load('song.mp3', 30)
      engine.stop()
      audio.emitLoadedMetadata()

      expect(audio.currentTime).toBe(0)
    })
  })

  describe('play() rejections', () => {
    it('reports a blocked autoplay instead of silently playing nothing', async () => {
      const onError = vi.fn()
      engine.onError = onError
      audio.playImpl = () =>
        Promise.reject(domError('NotAllowedError', 'play() failed: permission denied'))

      engine.play('song.mp3')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    })

    it('reports one from resume() the same way', async () => {
      const onError = vi.fn()
      engine.onError = onError
      audio.playImpl = () => Promise.reject(domError('NotAllowedError', 'blocked'))

      engine.resume()
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('blocked'))
    })

    it('falls back to a generic message for a rejection carrying none', async () => {
      const onError = vi.fn()
      engine.onError = onError
      audio.playImpl = () => Promise.reject(new Error())

      engine.play('song.mp3')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Playback error'))
    })

    it('stays quiet about the abort a quick skip to the next song causes', async () => {
      const onError = vi.fn()
      engine.onError = onError
      audio.playImpl = () =>
        Promise.reject(
          domError('AbortError', 'The play() request was interrupted by a new load request.'),
        )

      engine.play('song.mp3')
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce())
      await Promise.resolve()

      expect(onError).not.toHaveBeenCalled()
    })
  })

  describe('transport', () => {
    it('loads, positions and starts a song in one go', () => {
      engine.play('song.mp3', 30, 0.5)

      expect(audio.src).toBe('song.mp3')
      expect(audio.currentTime).toBe(30)
      expect(context.gain.gain.value).toBe(0.5)
      expect(audio.play).toHaveBeenCalledOnce()
    })

    it('loads a song without starting it, so a restored pause stays paused', () => {
      engine.load('song.mp3', 30)

      expect(audio.src).toBe('song.mp3')
      expect(audio.play).not.toHaveBeenCalled()
    })

    it('leaves the element loaded on pause, so resuming needs no reload', () => {
      engine.play('song.mp3')
      engine.pause()

      expect(audio.pause).toHaveBeenCalledOnce()
      expect(audio.src).toBe('song.mp3')
    })

    it('stops the graph on pause, instead of leaving it rendering from a stopped source', () => {
      // A renderer left in that position may repeat the last block it got —
      // heard on iOS as the final half-second looping after pause.
      engine.play('song.mp3')
      engine.pause()

      expect(context.suspend).toHaveBeenCalledOnce()
      expect(context.state).toBe('suspended')
    })

    it('brings it back on the next play', () => {
      engine.play('song.mp3')
      engine.pause()
      context.resume.mockClear()

      engine.resume()

      expect(context.resume).toHaveBeenCalledOnce()
      expect(context.state).toBe('running')
    })

    it('leaves an already-stopped graph alone', () => {
      context.state = 'suspended'

      engine.pause()

      expect(context.suspend).not.toHaveBeenCalled()
    })

    it('detaches the source on stop, so nothing keeps buffering in the background', () => {
      engine.play('song.mp3')
      engine.stop()

      expect(audio.pause).toHaveBeenCalledOnce()
      expect(audio.removeAttribute).toHaveBeenCalledWith('src')
      expect(audio.load).toHaveBeenCalledOnce()
      expect(context.suspend).toHaveBeenCalledOnce()
    })

    it('reports what the element itself says about being paused or finished', () => {
      audio.paused = false
      audio.ended = false
      expect(engine.isPaused).toBe(false)
      expect(engine.hasEnded).toBe(false)

      audio.paused = true
      audio.ended = true
      expect(engine.isPaused).toBe(true)
      expect(engine.hasEnded).toBe(true)
    })

    it('sets the volume through the graph, which iOS lets it change', () => {
      // The element's own `volume` is read-only there, so writing it is
      // ignored without any error and the slider moves for nothing.
      engine.setVolume(0.4)

      expect(context.volume.gain.setTargetAtTime).toHaveBeenCalledWith(0.4, 0, expect.any(Number))
      // Not both: the two would multiply and halve the level twice over.
      expect(audio.volume).toBe(1)
    })

    it('keeps the volume within range', () => {
      engine.setVolume(2)
      engine.setVolume(-1)

      const applied = context.volume.gain.setTargetAtTime.mock.calls.map((call) => call[0])
      expect(applied).toEqual([1, 0])
    })

    it('ramps rather than steps, so dragging the slider does not click', () => {
      engine.setVolume(0.5)

      expect(context.volume.gain.cancelScheduledValues).toHaveBeenCalled()
      expect(context.volume.gain.setTargetAtTime).toHaveBeenCalled()
    })

    it('keeps the ReplayGain factor on its own node, out of the volume', () => {
      engine.setVolume(0.5)
      engine.setReplayGain(0.7)

      // Sharing one node would mean each write wiping out the other.
      expect(context.gain.gain.value).toBe(0.7)
      expect(context.volume.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, 0, expect.any(Number))
    })

    it('defaults the ReplayGain multiplier per song rather than carrying the last one over', () => {
      engine.play('loud.mp3', 0, 0.3)
      expect(context.gain.gain.value).toBe(0.3)

      // A radio stream has nothing to normalize and passes no gain.
      engine.play('stream.mp3')
      expect(context.gain.gain.value).toBe(1)
    })

    it('applies a ReplayGain change to the song already playing', () => {
      engine.play('song.mp3')

      engine.setReplayGain(0.7)

      expect(context.gain.gain.value).toBe(0.7)
    })
  })

  describe('getAudioEngine()', () => {
    it('hands every caller the one element actually making sound', () => {
      // A second instance would hold its own silent <audio>, leaving whoever
      // got it driving nothing (see the module's HMR guard).
      expect(getAudioEngine()).toBe(getAudioEngine())
    })
  })
})
