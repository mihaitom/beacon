import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine, getAudioEngine } from '@/services/audioEngine'

/** Stands in for the <audio> element the engine builds in its constructor.
 * `dropWritesBeforeMetadata` is the whole point of it: Safari discards a
 * currentTime written before 'loadedmetadata' (the desktop browsers buffer
 * and apply it instead), and that difference is what load()'s retry exists
 * for — so both behaviours have to be reproducible here. */
class FakeAudio extends EventTarget {
  static last: FakeAudio

  src = ''
  crossOrigin: string | null = null
  volume = 1
  paused = true
  ended = false
  error: { message: string } | null = null
  duration = Number.NaN

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
  gain = { value: 1 }
  connect = vi.fn()
}

class FakeAudioContext {
  static last: FakeAudioContext

  state: 'running' | 'suspended' = 'running'
  destination = {}
  analyser = new FakeAnalyser()
  gain = new FakeGain()
  source = { connect: vi.fn() }

  createMediaElementSource = vi.fn(() => this.source)
  createAnalyser = vi.fn(() => this.analyser)
  createGain = vi.fn(() => this.gain)
  resume = vi.fn()

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
      expect(context.gain.connect).toHaveBeenCalledWith(context.destination)
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
      // Only the visualizer and ReplayGain are lost — the element still plays.
      expect(() => degraded.getAnalyser()).toThrow(/unavailable/)
      expect(() => degraded.setReplayGain(0.5)).not.toThrow()
      expect(() => degraded.play('song.mp3')).not.toThrow()
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

    it('detaches the source on stop, so nothing keeps buffering in the background', () => {
      engine.play('song.mp3')
      engine.stop()

      expect(audio.pause).toHaveBeenCalledOnce()
      expect(audio.removeAttribute).toHaveBeenCalledWith('src')
      expect(audio.load).toHaveBeenCalledOnce()
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

    it('keeps the volume within what the element accepts', () => {
      engine.setVolume(0.4)
      expect(audio.volume).toBe(0.4)

      engine.setVolume(2)
      expect(audio.volume).toBe(1)

      engine.setVolume(-1)
      expect(audio.volume).toBe(0)
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
