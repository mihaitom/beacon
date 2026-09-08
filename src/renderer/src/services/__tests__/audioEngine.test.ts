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
  private source = ''

  constructor() {
    super()
    FakeAudio.last = this
  }

  get src(): string {
    return this.source
  }

  /** Assigning a source resets the playhead, same as a browser loading a
   * new one does. That reset is the whole difference the two reconnect
   * paths turn on: a song is seeked back to where it dropped, a live
   * stream is not (it has nowhere to seek to) and carries its reported
   * elapsed across the gap in the engine instead — see liveOffset. */
  set src(value: string) {
    this.source = value
    this.time = 0
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

    // onReconnectStateChange - what stores/playback.ts's own
    // onReconnectStateChange wiring turns into radioBuffering for a local
    // radio station (see that file's own comment for why this stayed
    // unreported until now: a dropped connection used to retry in complete
    // silence, same as it still deliberately does for a song).
    describe('onReconnectStateChange', () => {
      it('fires true as soon as a drop starts retrying, before the retry lands', () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.play('song.mp3')

        dropConnection()

        expect(onReconnectStateChange).toHaveBeenCalledWith(true)
      })

      it('fires false once a reconnect actually succeeds', async () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.play('song.mp3')

        dropConnection()
        await vi.advanceTimersByTimeAsync(1000)
        onReconnectStateChange.mockClear()
        audio.dispatchEvent(new Event('playing'))

        expect(onReconnectStateChange).toHaveBeenCalledWith(false)
      })

      it('fires false once it gives up, alongside onError', async () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.play('song.mp3')

        for (let i = 0; i < 5; i++) {
          dropConnection()
          await vi.advanceTimersByTimeAsync(8000)
        }
        onReconnectStateChange.mockClear()
        dropConnection()

        expect(onReconnectStateChange).toHaveBeenCalledWith(false)
      })

      it('fires false when a pause cancels a pending retry', () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.play('song.mp3')

        dropConnection()
        onReconnectStateChange.mockClear()
        engine.pause()

        expect(onReconnectStateChange).toHaveBeenCalledWith(false)
      })

      it('does not fire on an ordinary play with nothing to reconnect from', () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange

        engine.play('song.mp3')
        audio.dispatchEvent(new Event('playing'))

        // Still called - 'playing' unconditionally reports "not
        // reconnecting" (see the engine's own comment) - but never with
        // true, since nothing ever dropped.
        expect(onReconnectStateChange).toHaveBeenCalledWith(false)
        expect(onReconnectStateChange).not.toHaveBeenCalledWith(true)
      })
    })
  })

  // playLive() — radio. What separates it from a song is not one setting
  // but four (see the method's own docstring); these cover the three that
  // are behaviour rather than plumbing.
  describe('live streams', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Puts the fake into the state a station actually playing produces:
     * not paused, and reporting a position that moves. */
    function playing(position: number): void {
      audio.paused = false
      audio.settleAt(position)
      audio.dispatchEvent(new Event('timeupdate'))
    }

    // The whole reason the watchdog exists: a station's characteristic
    // failure is a connection that stays open and stops delivering, which
    // fires no 'error' event at all, so nothing in the engine would ever
    // have noticed it.
    it('reconnects a stream whose playhead stops advancing, with no error event to go on', async () => {
      engine.playLive('http://station/stream')
      playing(3)
      audio.play.mockClear()

      // Four seconds of standing still, then the first backoff step.
      await vi.advanceTimersByTimeAsync(5000)

      expect(audio.play).toHaveBeenCalledOnce()
      expect(audio.src).toBe('http://station/stream')
    })

    it('leaves a stream alone for as long as it keeps advancing', async () => {
      engine.playLive('http://station/stream')
      audio.play.mockClear()

      // Ten seconds of ordinary playback, reported the way a browser
      // reports it — well past the stall threshold, but never standing
      // still for it.
      for (let second = 1; second <= 10; second++) {
        await vi.advanceTimersByTimeAsync(1000)
        playing(second)
      }

      expect(audio.play).not.toHaveBeenCalled()
    })

    // A paused element's playhead stands still for a reason that is not a
    // fault, and reconnecting one would start sound the listener stopped.
    it('does not treat a pause as a stall', async () => {
      engine.playLive('http://station/stream')
      playing(3)
      engine.pause()
      audio.paused = true
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(30_000)

      expect(audio.play).not.toHaveBeenCalled()
    })

    // The watchdog is live-only: a song has a real buffer behind it, is
    // legitimately allowed to sit still while it fills, and has the
    // element's own 'error' event in front of it.
    it('does not watch a song for stalls', async () => {
      engine.play('song.mp3')
      audio.paused = false
      audio.settleAt(3)
      audio.dispatchEvent(new Event('timeupdate'))
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(30_000)

      expect(audio.play).not.toHaveBeenCalled()
    })

    // A live stream has nowhere to seek to. Writing the elapsed listening
    // time onto one as a start position asks for a point in the stream
    // that does not exist.
    it('reconnects at the edge instead of seeking to the elapsed time', async () => {
      engine.playLive('http://station/stream')
      playing(120)

      audio.error = { message: 'network error', code: 2 }
      audio.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(1000)

      expect(audio.currentTime).toBe(0)
    })

    // ...but the elapsed readout is listening time, not an offset into
    // anything, so it survives the gap rather than dropping back to 0:00.
    it('carries the elapsed time across a reconnect', async () => {
      const onTimeUpdate = vi.fn()
      engine.onTimeUpdate = onTimeUpdate
      engine.playLive('http://station/stream')
      playing(120)

      audio.error = { message: 'network error', code: 2 }
      audio.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(1000)
      // The reconnected stream starts from its own beginning again.
      playing(5)

      expect(onTimeUpdate).toHaveBeenLastCalledWith(125)
    })

    // A station's connection being closed cleanly, by the station or by
    // Beacon's relay restarting under it. The watchdog cannot cover this
    // one: a browser reports an ended element as paused, and a paused
    // element is exactly what must not be reconnected.
    it('treats the stream ending as a drop rather than an end', async () => {
      const onEnded = vi.fn()
      engine.onEnded = onEnded
      engine.playLive('http://station/stream')
      playing(30)
      audio.play.mockClear()

      audio.ended = true
      audio.paused = true
      audio.dispatchEvent(new Event('ended'))
      await vi.advanceTimersByTimeAsync(1000)

      expect(onEnded).not.toHaveBeenCalled()
      expect(audio.play).toHaveBeenCalledOnce()
    })

    it('still reports a song reaching its end', () => {
      const onEnded = vi.fn()
      engine.onEnded = onEnded
      engine.play('song.mp3')

      audio.dispatchEvent(new Event('ended'))

      expect(onEnded).toHaveBeenCalledOnce()
    })

    // holdsConnection — a station relayed by Beacon's own backend rather
    // than fetched from its own server.
    describe('a held connection', () => {
      it('reports the stall but leaves the connection standing', async () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)
        audio.play.mockClear()

        await vi.advanceTimersByTimeAsync(20_000)

        // The relay is still fetching the station and queueing what this
        // device is missing; tearing the connection down would throw that
        // queue away and resume at the live edge instead of filling the
        // gap.
        expect(audio.play).not.toHaveBeenCalled()
        expect(onReconnectStateChange).toHaveBeenCalledWith(true)
      })

      it('picks straight back up when the audio resumes', async () => {
        const onReconnectStateChange = vi.fn()
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)
        await vi.advanceTimersByTimeAsync(20_000)
        engine.onReconnectStateChange = onReconnectStateChange

        // The queued seconds arriving at once, then ordinary playback.
        playing(9)
        audio.dispatchEvent(new Event('playing'))
        await vi.advanceTimersByTimeAsync(2000)

        expect(onReconnectStateChange).toHaveBeenCalledWith(false)
        expect(onReconnectStateChange).not.toHaveBeenCalledWith(true)
      })

      // The same recovery, without the element saying anything about it.
      // 'playing' only fires when the *element* was stalled, and the
      // watchdog also reports stalls it never noticed — a process that was
      // suspended, an audio sink that stopped consuming. Reported live
      // 2026-09-08: the buffering bar stayed on a station that had been
      // playing cleanly for hours, and only a reload cleared it.
      it('clears the stall when the playhead moves again, with no playing event to go on', async () => {
        const onReconnectStateChange = vi.fn()
        engine.onReconnectStateChange = onReconnectStateChange
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(onReconnectStateChange).toHaveBeenLastCalledWith(true)

        playing(9)

        expect(onReconnectStateChange).toHaveBeenLastCalledWith(false)
      })

      // A watchdog tick that arrives a minute late timed the machine being
      // asleep, not the stream. The playhead stood still for exactly the
      // same reason, and giving up on a station over it would take a
      // perfectly good connection down on waking.
      it('does not condemn a stream because the watchdog itself was suspended', async () => {
        const onConnectionLost = vi.fn()
        const onReconnectStateChange = vi.fn()
        engine.onConnectionLost = onConnectionLost
        engine.onReconnectStateChange = onReconnectStateChange
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)

        // Wall clock jumps; nothing ran while it did.
        vi.setSystemTime(Date.now() + 90_000)
        await vi.advanceTimersByTimeAsync(1000)

        expect(onConnectionLost).not.toHaveBeenCalled()
        expect(onReconnectStateChange).not.toHaveBeenCalledWith(true)
      })

      it('gives up once waiting has stopped being worth it', async () => {
        const onConnectionLost = vi.fn()
        engine.onConnectionLost = onConnectionLost
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)

        await vi.advanceTimersByTimeAsync(59_000)
        expect(onConnectionLost).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(2000)

        expect(onConnectionLost).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      })

      // A connection that actually failed is gone whoever was holding it,
      // and the relay it pointed at is still there to reconnect to.
      it('still reconnects on a real error', async () => {
        engine.playLive('http://beacon/stream/radio-local', { holdsConnection: true })
        playing(3)
        audio.play.mockClear()

        audio.error = { message: 'network error', code: 2 }
        audio.dispatchEvent(new Event('error'))
        await vi.advanceTimersByTimeAsync(1000)

        expect(audio.play).toHaveBeenCalledOnce()
      })

      // The station's own server holds nothing for anyone.
      it('does not hold a station fetched directly', async () => {
        engine.playLive('http://station/stream')
        playing(3)
        audio.play.mockClear()

        await vi.advanceTimersByTimeAsync(5000)

        expect(audio.play).toHaveBeenCalledOnce()
      })
    })

    // Six attempts rather than a song's five, and a 15s cap rather than 8s
    // — see MAX_LIVE_RECONNECT_ATTEMPTS.
    it('tries for longer than a song does before giving up', async () => {
      const onConnectionLost = vi.fn()
      const onError = vi.fn()
      engine.onConnectionLost = onConnectionLost
      engine.onError = onError
      engine.playLive('http://station/stream')

      function drop(): void {
        audio.error = { message: 'network error', code: 2 }
        audio.dispatchEvent(new Event('error'))
      }

      // Five drops is where a song would already have given up.
      for (let i = 0; i < 5; i++) {
        drop()
        await vi.advanceTimersByTimeAsync(15_000)
      }
      drop()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(onConnectionLost).not.toHaveBeenCalled()

      drop()

      expect(onConnectionLost).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith('Playback error: connection lost')
    })

    // Nothing is retrying any more, so nothing should still be ticking
    // either. Asserted as "no timer is left", not as "no reconnect
    // happens": the guards inside checkForStall() already make a watchdog
    // that keeps running harmless, which is exactly why one left behind
    // would go unnoticed — a station played for an afternoon and given up
    // on would tick once a second until the app was closed.
    it('leaves nothing ticking once it has given up', async () => {
      engine.playLive('http://station/stream')
      playing(3)
      for (let i = 0; i < 7; i++) {
        audio.error = { message: 'network error', code: 2 }
        audio.dispatchEvent(new Event('error'))
        await vi.advanceTimersByTimeAsync(15_000)
      }

      expect(vi.getTimerCount()).toBe(0)
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

  /** A transcode from playFrom(): served from a chosen second, with no
   * length of its own (connect/routes/local_stream.py). Everything here is
   * about the two things that follow from having no length — the element's
   * clock starts at 0 while the listener is minutes into a song, and a
   * connection that goes away is not reported as one. */
  describe('a stream that starts partway in', () => {
    const urlFor = (seconds: number): string => `stream?start=${seconds.toFixed(3)}`
    const NETWORK_ERROR_CODE = 2

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Plays `duration`-second track from 180s in, with 20s of it heard. */
    function playingAt(duration: number | null = 600): void {
      engine.playFrom(urlFor, 180, 1, duration)
      audio.paused = false
      audio.settleAt(20)
      audio.dispatchEvent(new Event('timeupdate'))
    }

    function dropConnection(): void {
      audio.error = { message: 'network error', code: NETWORK_ERROR_CODE }
      audio.dispatchEvent(new Event('error'))
    }

    it('reports the position as the track position, not the stream position', () => {
      const onTimeUpdate = vi.fn()
      engine.onTimeUpdate = onTimeUpdate
      playingAt()

      expect(onTimeUpdate).toHaveBeenLastCalledWith(200)
    })

    it('asks for the same audio again from where it dropped', async () => {
      playingAt()

      dropConnection()
      await vi.advanceTimersByTimeAsync(1000)

      // A different URL, not a seek: there is nothing to seek within.
      expect(audio.src).toBe('stream?start=200.000')
      expect(audio.currentTime).toBe(0)
    })

    it('keeps reporting track positions after reconnecting', async () => {
      const onTimeUpdate = vi.fn()
      playingAt()
      dropConnection()
      await vi.advanceTimersByTimeAsync(1000)

      engine.onTimeUpdate = onTimeUpdate
      audio.settleAt(5)
      audio.dispatchEvent(new Event('timeupdate'))

      expect(onTimeUpdate).toHaveBeenLastCalledWith(205)
    })

    it('draws no buffered band, however much the element claims to hold', () => {
      // A length-less stream's `buffered` describes how far the demuxer
      // has parsed, not what the browser is holding — a flat couple of
      // seconds while the real buffer is minutes deep. See
      // reportBuffered().
      const onBufferedChange = vi.fn()
      playingAt()
      engine.onBufferedChange = onBufferedChange
      audio.setBuffered([[0, 45]])

      audio.dispatchEvent(new Event('progress'))

      expect(onBufferedChange).toHaveBeenLastCalledWith(0)
    })

    it('ignores the length the element works out for itself', () => {
      // What it eventually reports is the length of what it was *sent* —
      // a track resumed at 3:00 reports 1:10 — which would rescale the
      // seek bar at the very end of the song.
      const onDurationChange = vi.fn()
      engine.onDurationChange = onDurationChange
      playingAt()

      audio.duration = 70
      audio.dispatchEvent(new Event('durationchange'))

      expect(onDurationChange).not.toHaveBeenCalled()
    })

    describe('a stream that ends before the track does', () => {
      it('picks the connection back up instead of ending the song', async () => {
        // Without a length, a connection going away mid-track reaches the
        // element as a stream that simply finished. The track is 600s long
        // and this stopped at 200.
        const onEnded = vi.fn()
        engine.onEnded = onEnded
        playingAt(600)

        audio.dispatchEvent(new Event('ended'))
        await vi.advanceTimersByTimeAsync(1000)

        expect(onEnded).not.toHaveBeenCalled()
        expect(audio.src).toBe('stream?start=200.000')
      })

      it('ends the song when the stream really did reach the end', async () => {
        const onEnded = vi.fn()
        engine.onEnded = onEnded
        engine.playFrom(urlFor, 180, 1, 202)
        audio.settleAt(20)
        audio.dispatchEvent(new Event('timeupdate'))

        audio.dispatchEvent(new Event('ended'))

        expect(onEnded).toHaveBeenCalledOnce()
      })

      it('ends the song when there is no length to judge against', () => {
        const onEnded = vi.fn()
        engine.onEnded = onEnded
        playingAt(null)

        audio.dispatchEvent(new Event('ended'))

        expect(onEnded).toHaveBeenCalledOnce()
      })

      it('gives up on a stream that keeps ending straight away', async () => {
        // A server handing out a moment of audio and hanging up each time:
        // every attempt "succeeds" enough to reset the reconnect ladder, so
        // this needs a count of its own or it retries forever.
        const onEnded = vi.fn()
        engine.onEnded = onEnded
        playingAt(600)

        for (let i = 0; i < 5; i++) {
          audio.dispatchEvent(new Event('ended'))
          await vi.advanceTimersByTimeAsync(8000)
          audio.dispatchEvent(new Event('playing'))
        }
        audio.dispatchEvent(new Event('ended'))

        expect(onEnded).toHaveBeenCalledOnce()
      })

      it('keeps trying for a track that plays on between drops', async () => {
        // The same five attempts, reset by playback actually getting
        // somewhere — a long track on a flaky connection is not a broken
        // one.
        const onEnded = vi.fn()
        engine.onEnded = onEnded
        playingAt(600)

        for (let i = 0; i < 8; i++) {
          audio.dispatchEvent(new Event('ended'))
          await vi.advanceTimersByTimeAsync(8000)
          audio.dispatchEvent(new Event('playing'))
          // Twenty seconds of music between each drop, which is what tells
          // this apart from a stream that never gets anywhere.
          audio.settleAt(20)
          audio.dispatchEvent(new Event('timeupdate'))
        }

        expect(onEnded).not.toHaveBeenCalled()
      })
    })

    it('treats a playhead that has stood still for too long as a drop', async () => {
      // Same failure a station has: a held response whose far end goes
      // quiet produces no error at all. Far longer than a station's four
      // seconds — see TRANSCODE_STALL_SECONDS.
      playingAt()
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(14_000)
      expect(audio.play).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(audio.src).toBe('stream?start=200.000')
    })

    it('leaves a plain file to the browser', async () => {
      // A file has a real buffer behind it and the element's own error
      // event in front of it; a watchdog here would only fight rebuffering.
      engine.play('song.mp3')
      audio.paused = false
      audio.settleAt(42)
      audio.dispatchEvent(new Event('timeupdate'))
      audio.play.mockClear()

      await vi.advanceTimersByTimeAsync(60_000)

      expect(audio.play).not.toHaveBeenCalled()
    })

    it('can still reconnect after a pause and a resume', async () => {
      // A pause used to clear the reconnect target outright, so a drop
      // after resuming was reported as an error instead — worst for a
      // transcode, which is exactly what a long pause kills at the far end.
      playingAt()
      const onError = vi.fn()
      engine.onError = onError

      engine.pause()
      engine.resume()
      dropConnection()
      await vi.advanceTimersByTimeAsync(1000)

      expect(onError).not.toHaveBeenCalled()
      expect(audio.src).toBe('stream?start=200.000')
    })

    it('still drops a retry that was already waiting when the pause came', async () => {
      playingAt()
      audio.play.mockClear()

      dropConnection()
      engine.pause()
      await vi.advanceTimersByTimeAsync(8000)

      // The one thing the pause has to prevent: sound resuming by itself.
      expect(audio.play).not.toHaveBeenCalled()
    })

    it('does not reconnect through the previous track once another loads', async () => {
      playingAt()
      dropConnection()

      engine.playFrom((s) => `other?start=${s.toFixed(3)}`, 0, 1, 300)
      await vi.advanceTimersByTimeAsync(8000)

      expect(audio.src).toBe('other?start=0.000')
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
