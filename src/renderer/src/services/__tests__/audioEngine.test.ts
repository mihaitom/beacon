import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine } from '@/services/audioEngine'

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
  readonly error: MediaError | null = null
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

class FakeAudioContext {
  state = 'running'
  destination = {}
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }))
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    smoothingTimeConstant: 0,
    minDecibels: 0,
    maxDecibels: 0,
    connect: vi.fn(),
  }))
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }))
  resume = vi.fn()
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name)
}

describe('AudioEngine', () => {
  let audio: FakeAudio
  let engine: AudioEngine

  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    engine = new AudioEngine()
    audio = FakeAudio.last
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
})
