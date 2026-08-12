/**
 * Thin wrapper around a single <audio> element for local (non-cast)
 * playback. No Vue reactivity here — the playback store owns state and
 * mirrors what this reports via the callbacks below.
 */
export class AudioEngine {
  private readonly audio: HTMLAudioElement

  onTimeUpdate: ((position: number) => void) | null = null
  onEnded: (() => void) | null = null
  onError: ((message: string) => void) | null = null
  onDurationChange: ((duration: number) => void) | null = null

  constructor() {
    this.audio = new Audio()
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
}

let instance: AudioEngine | null = null

export function getAudioEngine(): AudioEngine {
  if (!instance) instance = new AudioEngine()
  return instance
}
