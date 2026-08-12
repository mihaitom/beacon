/**
 * Thin wrapper around a single <audio> element for local (non-cast)
 * playback. No Vue reactivity here — the playback store owns state and
 * mirrors what this reports via the callbacks below.
 */
export class AudioEngine {
  private readonly audio: HTMLAudioElement
  private audioContext: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null

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
   * restore a paused track after a reload, so hitting play afterwards has
   * something to resume rather than an empty element. */
  load(url: string, startPosition = 0): void {
    this.audio.src = url
    this.audio.currentTime = startPosition
  }

  play(url: string, startPosition = 0): void {
    this.load(url, startPosition)
    void this.audio.play()
  }

  pause(): void {
    this.audio.pause()
  }

  resume(): void {
    void this.audio.play()
  }

  stop(): void {
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  seek(position: number): void {
    this.audio.currentTime = position
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(1, Math.max(0, volume))
  }

  get isPaused(): boolean {
    return this.audio.paused
  }

  /** Lazily wires a Web Audio analyser tapped off this element's output —
   * used by the fullscreen visualizer (AudioVisualizer.vue). Created at
   * most once per element (the Web Audio API throws if
   * createMediaElementSource is called on the same element twice) and
   * reused across every subsequent track, since this same <audio> element
   * is reused for the app's whole lifetime too (see getAudioEngine()).
   * Routes back through to `destination` — tapping the signal this way
   * would otherwise silence actual playback, since the browser stops
   * sending an element's audio straight to speakers once something reads
   * from a MediaElementAudioSourceNode built on it. */
  getAnalyser(): AnalyserNode {
    if (!this.analyserNode) {
      this.audioContext = new AudioContext()
      const source = this.audioContext.createMediaElementSource(this.audio)
      this.analyserNode = this.audioContext.createAnalyser()
      this.analyserNode.fftSize = 128
      this.analyserNode.smoothingTimeConstant = 0.8
      source.connect(this.analyserNode)
      this.analyserNode.connect(this.audioContext.destination)
    }
    // Autoplay policy can start a freshly-created context 'suspended' —
    // harmless to call every time, resume() on an already-running context
    // is a no-op.
    if (this.audioContext && this.audioContext.state === 'suspended') {
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
