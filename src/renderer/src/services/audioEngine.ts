/**
 * Thin wrapper around a single <audio> element for local (non-cast)
 * playback. No Vue reactivity here — the playback store owns state and
 * mirrors what this reports via the callbacks below.
 */

// How far the element's own currentTime may sit from the position load()
// below asked for before the retry considers the early write to have been
// dropped. Not an exact comparison: a browser is free to land a seek on a
// nearby decodable point rather than the exact second requested, and that
// rounding must not read as "the write didn't take".
const SEEK_TOLERANCE_SECONDS = 0.5

export class AudioEngine {
  private readonly audio: HTMLAudioElement
  private audioContext: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  // Undoes the pending 'loadedmetadata' retry armed by load() below, so a
  // newer load()/seek() is never overwritten by the previous one's
  // late-arriving start position.
  private cancelStartPositionRetry: (() => void) | null = null

  onTimeUpdate: ((position: number) => void) | null = null
  onEnded: (() => void) | null = null
  onError: ((message: string) => void) | null = null
  onDurationChange: ((duration: number) => void) | null = null

  constructor() {
    this.audio = new Audio()
    // Without this, getAnalyser() below would tap a "tainted" source (even
    // same-origin-looking requests can differ by port/scheme) and only
    // ever read back silence — connect's CORSMiddleware (main.py) already
    // allows the app's own origin, so this is safe to set unconditionally.
    this.audio.crossOrigin = 'anonymous'
    // Builds the analyser graph now, at app startup, rather than lazily on
    // AudioVisualizer.vue's first frame (which used to live inside
    // getAnalyser() below). createMediaElementSource() reroutes this
    // element's output through the Web Audio graph the moment it's called —
    // on Chromium that produces a brief but genuinely audible dropout, and
    // doing it lazily meant it fired the first time NowPlayingView opened
    // while a song was already audibly playing. Doing it here instead,
    // before anything has ever played, means whatever glitch that rerouting
    // causes happens against silence, not live playback.
    //
    // Wrapped in try/catch so an environment where Web Audio setup fails
    // (unsupported, or some other browser policy) only ever loses the
    // visualizer (getAnalyser() below throws, caught by
    // AudioVisualizer.vue's sampleFrequencies()) instead of taking plain
    // <audio> playback down with it.
    try {
      this.setupAnalyser()
    } catch (error) {
      console.error('[audio-engine] Failed to set up analyser:', error)
    }
    this.audio.addEventListener('timeupdate', () => {
      this.onTimeUpdate?.(this.audio.currentTime)
    })
    this.audio.addEventListener('ended', () => {
      this.onEnded?.()
    })
    this.audio.addEventListener('error', () => {
      this.onError?.(this.audio.error?.message ?? 'Playback error')
    })
    this.audio.addEventListener('durationchange', () => {
      if (Number.isFinite(this.audio.duration)) this.onDurationChange?.(this.audio.duration)
    })
  }

  /** Loads `url` at `startPosition` without starting playback — used to
   * restore a paused song after a reload, so hitting play afterwards has
   * something to resume rather than an empty element. `gain` is the linear
   * ReplayGain multiplier for this song (1 = no change, see
   * services/replayGain.ts) — defaults to 1 so callers with nothing to
   * normalize (radio streams) don't need to pass it explicitly, and so it's
   * always set explicitly rather than silently carrying over the previous
   * song's value. */
  load(url: string, startPosition = 0, gain = 1): void {
    this.cancelStartPositionRetry?.()
    this.audio.src = url
    this.applyStartPosition(startPosition)
    this.setReplayGain(gain)
  }

  /** Writes `position` twice: once right now, and once more from
   * 'loadedmetadata' if the first write didn't stick. Chromium buffers a
   * currentTime written before metadata has loaded and applies it as soon
   * as the media is ready — which is what every caller here has always
   * relied on — while Safari drops that same write (or answers it with
   * InvalidStateError), leaving the song starting from 0 instead of where
   * it was restored/handed off from. Keeping the early write rather than
   * only seeking from the event means the desktop path behaves exactly as
   * before and the retry is purely additive. */
  private applyStartPosition(position: number): void {
    if (position <= 0) return
    try {
      this.audio.currentTime = position
    } catch (error) {
      // InvalidStateError from writing before metadata exists — expected on
      // the browsers this retry is for, and not worth surfacing.
      console.debug('[audio-engine] Deferring start position until metadata:', error)
    }
    const retry = (): void => {
      this.cancelStartPositionRetry = null
      // Only when the early write above was actually dropped. Anything that
      // legitimately moved the position since then (see seek()) already
      // cleared this listener, so a difference here means "never applied",
      // not "the user moved on".
      if (Math.abs(this.audio.currentTime - position) > SEEK_TOLERANCE_SECONDS) {
        this.audio.currentTime = position
      }
    }
    this.audio.addEventListener('loadedmetadata', retry, { once: true })
    this.cancelStartPositionRetry = () => {
      this.cancelStartPositionRetry = null
      this.audio.removeEventListener('loadedmetadata', retry)
    }
  }

  play(url: string, startPosition = 0, gain = 1): void {
    this.load(url, startPosition, gain)
    this.start()
  }

  /** The single place play() is actually called, so every path that starts
   * sound reports the same way. The returned promise used to be discarded,
   * which swallowed the autoplay policy's NotAllowedError entirely: nothing
   * plays, the element fires no 'error' event (it never failed to *load*
   * anything), and the UI is left showing a playing state with silence
   * behind it. */
  private start(): void {
    void this.audio.play().catch((error: unknown) => {
      // Read off the value rather than narrowing by `instanceof Error`:
      // what lands here is a DOMException, which isn't reliably an Error
      // subclass everywhere (jsdom's isn't), and losing the real message to
      // that technicality would defeat the point of catching it at all.
      const { name, message } = (error ?? {}) as { name?: string; message?: string }
      // Routine, not a failure: the browser rejects a pending play() as
      // soon as a new src/load() supersedes it, which is exactly what
      // skipping through tracks quickly does. Reporting it would clear the
      // playing state of the track that just *started* correctly.
      if (name === 'AbortError') return
      // `||`, not `??`: a rejection carrying an empty message is no more
      // reportable than one carrying none at all.
      this.onError?.(message || 'Playback error')
    })
  }

  /** Sets the Web Audio gain applied on top of the element's own volume
   * (see setVolume()) — the two multiply together, exactly matching
   * ReplayGain's "gain on top of whatever level you already set" semantics.
   * A no-op if setupAnalyser() below failed (see its comment): losing
   * ReplayGain then is an acceptable degradation, same as losing the
   * visualizer. */
  setReplayGain(multiplier: number): void {
    if (this.gainNode) this.gainNode.gain.value = multiplier
  }

  pause(): void {
    this.audio.pause()
  }

  resume(): void {
    this.start()
  }

  stop(): void {
    this.cancelStartPositionRetry?.()
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  seek(position: number): void {
    // Takes over from any start position load() is still waiting to apply —
    // otherwise a seek made before metadata arrived would be undone by that
    // retry a moment later.
    this.cancelStartPositionRetry?.()
    this.audio.currentTime = position
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(1, Math.max(0, volume))
  }

  get isPaused(): boolean {
    return this.audio.paused
  }

  /** True once the loaded track has played through to the end. Resuming an
   * already-ended element with a bare play() is unreliable (browser/stream
   * dependent whether it actually restarts and keeps firing timeupdate) —
   * callers should do a full play()/load() instead of resume() when this is
   * true. */
  get hasEnded(): boolean {
    return this.audio.ended
  }

  /** Wires a Web Audio analyser tapped off this element's output — see the
   * constructor's comment for why this runs eagerly at construction instead
   * of lazily on first use. Routes back through to `destination` — tapping
   * the signal this way would otherwise silence actual playback, since the
   * browser stops sending an element's audio straight to speakers once
   * something reads from a MediaElementAudioSourceNode built on it. */
  private setupAnalyser(): void {
    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaElementSource(this.audio)
    this.analyserNode = this.audioContext.createAnalyser()
    // A much finer FFT than this used to run (see AudioVisualizer.vue's
    // sampleFrequencies(), which maps the resulting bins into real
    // 1/6-octave log bands over 20-22050Hz) — that coarser one was fine
    // for the old plain linear-bin sampling, but a real log/octave mapping
    // needs enough raw bins to actually resolve distinct low-frequency
    // bands instead of several of them collapsing onto the same handful
    // of bins. Not bigger still (e.g. 16384): an FFT's own window length
    // IS the time slice each read's spectrum represents (4096/44100 ≈
    // 93ms here) — 16384's ~372ms was measurably less dynamic-looking,
    // since short transients (a kick drum, a hi-hat) get smeared across
    // that whole window regardless of smoothingTimeConstant below. This
    // is the same size connect/core/audio_analysis.py's 'cast'-mode
    // window uses, for the same reasoning — see its own comment.
    this.analyserNode.fftSize = 4096
    // Slightly higher than the FFT-size/dB-range tuning pass first landed
    // on (0.6) — that read as a bit too jumpy once actually tried. Not a
    // big correction: this value only damps the analyser's own bin-to-bin
    // read, a separate, much smaller effect than the visual per-rendered-
    // frame easing AudioVisualizer.vue's SMOOTHING_LOCAL already applies
    // on top.
    this.analyserNode.smoothingTimeConstant = 0.7
    // Web Audio's own default range (-100/-30dB) compresses typical
    // program material into a narrower slice of the 0-1 output than this
    // — widened here so normal-volume music actually swings across more
    // of a bar's height instead of hovering low. Matches 'cast' mode's
    // own _MIN_DB/_MAX_DB (see audio_analysis.py) so both read at the
    // same visual scale.
    this.analyserNode.minDecibels = -85
    this.analyserNode.maxDecibels = -25
    // Tapped post-analyser so the visualizer always reflects the song's
    // raw energy, unaffected by whatever ReplayGain happens to be doing to
    // the actual output level.
    this.gainNode = this.audioContext.createGain()
    source.connect(this.analyserNode)
    this.analyserNode.connect(this.gainNode)
    this.gainNode.connect(this.audioContext.destination)
  }

  /** Used by the fullscreen visualizer (AudioVisualizer.vue). Throws if the
   * constructor's setupAnalyser() failed — the caller already handles that
   * (see sampleFrequencies()'s try/catch). */
  getAnalyser(): AnalyserNode {
    if (!this.audioContext || !this.analyserNode) {
      throw new Error('Web Audio analyser unavailable')
    }
    // Autoplay policy can start a freshly-created context 'suspended' —
    // harmless to call every time, resume() on an already-running context
    // is a no-op.
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume()
    }
    return this.analyserNode
  }
}

let instance: AudioEngine | null = null

export function getAudioEngine(): AudioEngine {
  if (!instance) instance = new AudioEngine()
  return instance
}

// `instance` lives outside any framework-managed state — a partial Vite HMR
// swap of this file would leave the *old* instance (still holding the real,
// audibly-playing <audio> element and AudioContext) running unreferenced
// while a fresh getAudioEngine() call elsewhere creates a *second* one, e.g.
// stores/playback.ts's own callers now pointing at a silent new instance
// instead of the one actually making sound. hot.decline() used to be the
// direct way to opt out of HMR, but Vite removed it — self-accepting and
// immediately invalidating forces a full reload on any edit here instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      'services/audioEngine.ts holds a singleton instance that cannot be safely hot-reloaded',
    )
  })
}
