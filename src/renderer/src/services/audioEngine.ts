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

// MediaError.MEDIA_ERR_NETWORK — hardcoded rather than read off the global,
// which jsdom does not define. The only one of the four MediaError codes
// worth an automatic reconnect: the browser had already established the
// stream was playable and lost the connection while fetching more of it,
// exactly what a cellular dead spot looks like. The other three (aborted,
// decode, src-not-supported) would just fail the same way again.
const MEDIA_ERR_NETWORK = 2

// How many times reconnectOnDrop() below retries a dropped connection
// before giving up and reporting a real error, and how the wait between
// attempts grows (1s, 2s, 4s, 8s, capped at 8s) — long enough to ride out a
// few-second tunnel or dead spot without hammering the server on a
// connection that isn't coming back.
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_RECONNECT_DELAY_SECONDS = 8

/** Whether the local <audio> element may be routed through a Web Audio
 * graph at all — which is what buys the visualizer and ReplayGain, and what
 * costs playback while the screen is locked.
 *
 * WebKit counts an element tapped by createMediaElementSource() as Web
 * Audio playback and suspends it when the screen locks or the page goes to
 * the background, where a plain media element is allowed to carry on (with
 * lock-screen controls, see services/mediaSession.ts). Confirmed against
 * Navidrome's own web player on 2026-08-28: it builds a context only when
 * ReplayGain is set to album/track (ui/src/audioplayer/Player.jsx), plays
 * on through a screen lock with the default 'none', and stops doing so the
 * moment ReplayGain is switched on. Feishin has the same trade behind a
 * "use web audio" setting.
 *
 * `pointer: coarse` rather than a viewport width: this is about the kind of
 * device, not the size of the window. It picks out phones and tablets
 * (including an iPad in landscape, which is wide enough to be reading as a
 * desktop layout) while leaving a narrow desktop browser window — and a
 * touch laptop, which has a fine pointer too — with the visualizer they
 * have no reason to lose. Electron is never affected: window.api only
 * exists there, nothing locks a desktop app's audio away, and the check is
 * the same idiom stores/auth.ts uses to tell the two builds apart. */
function webAudioAllowed(): boolean {
  try {
    if (window.api) return true
    return !window.matchMedia('(pointer: coarse)').matches
  } catch {
    // Older browser without matchMedia, or a stubbed-out one: keep the
    // long-standing behaviour rather than silently dropping features.
    return true
  }
}

export class AudioEngine {
  private readonly audio: HTMLAudioElement
  private audioContext: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private volumeNode: GainNode | null = null
  // Undoes the pending 'loadedmetadata' retry armed by load() below, so a
  // newer load()/seek() is never overwritten by the previous one's
  // late-arriving start position.
  private cancelStartPositionRetry: (() => void) | null = null
  // Reconnect bookkeeping for reconnectOnDrop() below: the url and position
  // to resume from, how many attempts have been made since the last
  // successful 'playing', and the pending backoff timer (if any).
  private reconnectUrl: string | null = null
  private lastKnownPosition = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  onTimeUpdate: ((position: number) => void) | null = null
  onEnded: (() => void) | null = null
  onError: ((message: string) => void) | null = null
  onDurationChange: ((duration: number) => void) | null = null
  /** How far the *currently playing* stretch of audio is buffered ahead of
   * the playhead, in the same seconds as onTimeUpdate — what the seek bar
   * paints as the lighter "buffered but not yet played" band alongside the
   * played/unplayed one it already drew. See reportBuffered() for why this
   * is the end of the buffered range containing currentTime rather than
   * just the last one. */
  onBufferedChange: ((end: number) => void) | null = null
  /** Fires around reconnectOnDrop() below — true the moment a dropped
   * connection starts (re)trying, false once it either lands ('playing') or
   * gives up (onError below). Deliberately a separate signal from onError:
   * a song's own reconnect stays silent on purpose (see reconnectOnDrop()'s
   * own comment) and this callback is only acted on for radio (see
   * stores/playback.ts's own onReconnectStateChange, which no-ops unless
   * playbackStore.radioStation is set) — a live station has no "buffered
   * ahead" cushion a song's own bigger local buffer rides out, so a dropped
   * connection there is audible right away, and was previously reported as
   * nothing worse than "Live" ticking straight through it. */
  onReconnectStateChange: ((reconnecting: boolean) => void) | null = null

  constructor() {
    this.audio = new Audio()
    // Without this, getAnalyser() below would tap a "tainted" source (even
    // same-origin-looking requests can differ by port/scheme) and only
    // ever read back silence — connect's CORSMiddleware (main.py) already
    // allows the app's own origin, so this is safe to set unconditionally.
    this.audio.crossOrigin = 'anonymous'
    // Explicit rather than relying on the browser default: an omitted
    // `preload` leaves some browsers (mobile Chrome on cellular in
    // particular) buffering only just enough to start, which turns a
    // several-second reception gap into an audible dropout even though
    // routes/local_stream.py's ffmpeg pipeline is already sending as fast
    // as it can and would happily fill a much bigger buffer.
    this.audio.preload = 'auto'
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
    if (webAudioAllowed()) {
      try {
        this.setupAnalyser()
      } catch (error) {
        console.error('[audio-engine] Failed to set up analyser:', error)
      }
    }
    this.audio.addEventListener('timeupdate', () => {
      this.lastKnownPosition = this.audio.currentTime
      this.onTimeUpdate?.(this.audio.currentTime)
    })
    this.audio.addEventListener('ended', () => {
      this.onEnded?.()
    })
    // A successful reconnect lands here, same as any other stream actually
    // starting to play — resetting the count is what lets the *next* drop
    // get the same five attempts rather than picking up where this one left
    // off. Also the "we're not reconnecting anymore" half of
    // onReconnectStateChange — fired unconditionally (not just after a
    // real drop) since a plain, non-reconnect play() starting normally is
    // exactly the "not reconnecting" state that callback describes too.
    this.audio.addEventListener('playing', () => {
      this.reconnectAttempts = 0
      this.onReconnectStateChange?.(false)
    })
    this.audio.addEventListener('error', () => {
      const code = (this.audio.error as { code?: number } | null)?.code
      if (code === MEDIA_ERR_NETWORK && this.reconnectUrl !== null) {
        this.reconnectOnDrop()
        return
      }
      this.reconnectUrl = null
      this.onError?.(this.audio.error?.message ?? 'Playback error')
    })
    this.audio.addEventListener('durationchange', () => {
      if (Number.isFinite(this.audio.duration)) this.onDurationChange?.(this.audio.duration)
    })
    // 'progress' is what fires as the browser actually receives more of the
    // stream — 'timeupdate' only moves with playback and would report a
    // buffered end that hasn't advanced in seconds. 'seeked' covers landing
    // on a spot that was already buffered from an earlier stretch of the
    // same file, which needs no new network activity and so fires no
    // 'progress' of its own.
    this.audio.addEventListener('progress', () => {
      this.reportBuffered()
    })
    this.audio.addEventListener('seeked', () => {
      this.reportBuffered()
    })
  }

  /** Reports the end of whichever buffered range currently contains the
   * playhead — not simply the last range reported at all, since a seek can
   * leave an earlier, now-abandoned range sitting in `buffered` alongside
   * the new one actually being fetched. Reporting that stale range's end
   * would draw a buffered band in the wrong place, or one that extends
   * past a gap the playhead would actually stall at. Reports 0 when
   * nothing covers the current position (nothing buffered there yet, most
   * often right after a reconnectOnDrop() retry). */
  private reportBuffered(): void {
    const { buffered, currentTime } = this.audio
    let end = 0
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        end = buffered.end(i)
        break
      }
    }
    this.onBufferedChange?.(end)
  }

  /** Reconnects after a dropped (not merely slow) connection — see
   * MEDIA_ERR_NETWORK's own comment for why only that error code lands
   * here. Retries the same url from the last position timeupdate reported,
   * with a growing backoff, and gives up after MAX_RECONNECT_ATTEMPTS by
   * reporting a real error same as before this existed. Deliberately quiet
   * while retrying — no onError call, so a brief tunnel doesn't flip the
   * UI out of "playing" for what is, from the listener's chair, a
   * half-second gap in the sound. */
  private reconnectOnDrop(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const url = this.reconnectUrl
      this.reconnectUrl = null
      console.error(`[audio-engine] Giving up reconnecting to ${url} after dropped connection`)
      this.onReconnectStateChange?.(false)
      this.onError?.('Playback error: connection lost')
      return
    }
    this.onReconnectStateChange?.(true)
    this.reconnectAttempts++
    const delaySeconds = Math.min(2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_SECONDS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const url = this.reconnectUrl
      if (url === null) return
      this.cancelStartPositionRetry?.()
      this.audio.src = url
      this.applyStartPosition(this.lastKnownPosition)
      this.onBufferedChange?.(0)
      // A rejected play() here needs no handling of its own: a connection
      // that still isn't back fires the element's own 'error' event just
      // as the first attempt did, which re-enters this same method for the
      // next backoff step.
      void this.audio.play().catch(() => {})
    }, delaySeconds * 1000)
  }

  /** Drops any in-flight reconnect attempt — called wherever playback is
   * meant to actually stop, so a backoff timer from a drop several seconds
   * ago never resurrects sound the user (or the next track) already moved
   * on from. */
  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      // Only when a wait/retry was actually cancelled — a plain pause with
      // nothing pending has nothing to clear, and calling this on every
      // pause/stop/load regardless would fire "not reconnecting" far more
      // than the handful of call sites that could actually be mid-backoff.
      this.onReconnectStateChange?.(false)
    }
    this.reconnectUrl = null
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
    this.cancelReconnect()
    this.reconnectUrl = url
    this.reconnectAttempts = 0
    this.lastKnownPosition = startPosition
    this.audio.src = url
    this.applyStartPosition(startPosition)
    this.setReplayGain(gain)
    // Otherwise the seek bar would flash the previous song's buffered band
    // for a moment before the new stream's first 'progress' event corrects
    // it — nothing is buffered on a src that has not started loading yet.
    this.onBufferedChange?.(0)
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
    // Every path that makes sound goes through here, which is also the only
    // place guaranteed to run inside the user gesture that asked for it —
    // see resumeContext()'s own comment for why that matters.
    this.resumeContext()
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

  /** Sets the per-song ReplayGain factor, on its own node ahead of the
   * listener's volume (see setVolume()) — the two multiply together,
   * exactly matching ReplayGain's "gain on top of whatever level you
   * already set" semantics. Assigned rather than ramped, unlike volume:
   * this changes at a song boundary or a settings toggle, not continuously.
   * A no-op if setupAnalyser() below failed (see its comment): losing
   * ReplayGain then is an acceptable degradation, same as losing the
   * visualizer. */
  setReplayGain(multiplier: number): void {
    if (this.gainNode) this.gainNode.gain.value = multiplier
  }

  pause(): void {
    // An explicit pause means "stop", not "give up trying to reconnect and
    // then stop" — without this a backoff timer left over from a drop just
    // before the pause could still land its retry and resume sound the
    // user asked to have paused.
    this.cancelReconnect()
    this.audio.pause()
    this.suspendContext()
  }

  resume(): void {
    this.start()
  }

  stop(): void {
    this.cancelStartPositionRetry?.()
    this.cancelReconnect()
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.suspendContext()
  }

  seek(position: number): void {
    // Takes over from any start position load() is still waiting to apply —
    // otherwise a seek made before metadata arrived would be undone by that
    // retry a moment later.
    this.cancelStartPositionRetry?.()
    this.lastKnownPosition = position
    this.audio.currentTime = position
  }

  /** Applied through the Web Audio graph rather than the element's own
   * `volume`, which iOS makes read-only: writing it there is silently
   * ignored, so the mobile web player's volume slider moved and changed
   * nothing at all. Falls back to the element for a build where the graph
   * failed to come up (see setupAnalyser()) — losing volume control
   * entirely would be a worse degradation than losing the visualizer.
   *
   * Ramped rather than assigned: dragging the slider produces a steady
   * stream of these, and stepping a gain value discontinuously is audible
   * as a click on each one. The time constant is short enough to still
   * read as immediate. */
  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume))
    if (!this.volumeNode || !this.audioContext) {
      this.audio.volume = clamped
      return
    }
    const now = this.audioContext.currentTime
    this.volumeNode.gain.cancelScheduledValues(now)
    this.volumeNode.gain.setTargetAtTime(clamped, now, 0.015)
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

  /** Wakes the analyser graph's context if the browser started it
   * suspended. The constructor builds that graph before anything has been
   * played (see its comment), which means it is created without a user
   * gesture — and a context created that way starts 'suspended' under the
   * autoplay policy. Because createMediaElementSource() routes the whole
   * element through that graph, a suspended context means no sound at all,
   * not merely no visualizer: the element plays, reports positions, fires
   * 'ended', and stays silent throughout.
   *
   * Chromium resumes such a context by itself after the first gesture, so
   * the desktop app and the Chromium-based browsers never showed this;
   * Safari does not, which left the mobile web build silent until someone
   * opened Now Playing, whose visualizer was the only caller that ever
   * resumed it (see getAnalyser() below). Calling it from start() as well
   * is what actually ties the wake-up to pressing play. A no-op on a
   * running context, and on a build where the graph failed to come up at
   * all. */
  private resumeContext(): void {
    if (this.audioContext?.state === 'suspended') void this.audioContext.resume()
  }

  /** The counterpart to resumeContext(): the graph only runs while sound is
   * meant to be coming out of it. Pausing the element on its own leaves the
   * context rendering from a source that has stopped handing it anything,
   * which a renderer is free to cover by repeating the last block it did
   * get — heard once on iOS as the final half-second of a track looping
   * after pause, until the next play sorted it out. Stopping the context
   * removes the situation rather than relying on the renderer's choice, and
   * costs nothing on a platform that handled it correctly anyway, since
   * every path that starts sound resumes it again (see start()). */
  private suspendContext(): void {
    if (this.audioContext?.state === 'running') void this.audioContext.suspend()
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
    // A second node rather than folding the listener's volume into the one
    // above: the two are set independently (a song start writes ReplayGain,
    // the slider writes volume) and sharing a node would mean each one
    // overwriting the other's factor. Last in the chain, so it applies to
    // whatever ReplayGain has already done — the same "on top of the level
    // you set" relationship the two had when volume was still the
    // element's own (see setVolume()).
    this.volumeNode = this.audioContext.createGain()
    source.connect(this.analyserNode)
    this.analyserNode.connect(this.gainNode)
    this.gainNode.connect(this.volumeNode)
    this.volumeNode.connect(this.audioContext.destination)
  }

  /** Whether this device's own playback volume can be changed at all. The
   * element's `volume` is read-only on mobile browsers, so the graph's gain
   * node is the only way to move it there — and on exactly those devices
   * the graph is deliberately absent (see webAudioAllowed()), which leaves
   * the system volume buttons as the only control. Surfaces that offer a
   * volume slider check this rather than showing one that cannot do
   * anything (MobileTransportControls.vue). */
  get canSetVolume(): boolean {
    return this.volumeNode !== null
  }

  /** Whether a local analyser exists to read from at all — false where
   * webAudioAllowed() above declined to build the graph, and where building
   * it failed. NowPlayingView.vue reads this to decide whether offering the
   * visualizer makes sense; casting doesn't go through here (its frequency
   * data comes from the backend, see services/connect/visualizer.ts). */
  get hasAnalyser(): boolean {
    return this.analyserNode !== null
  }

  /** Used by the fullscreen visualizer (AudioVisualizer.vue). Throws if the
   * constructor's setupAnalyser() failed — the caller already handles that
   * (see sampleFrequencies()'s try/catch). */
  getAnalyser(): AnalyserNode {
    if (!this.audioContext || !this.analyserNode) {
      throw new Error('Web Audio analyser unavailable')
    }
    this.resumeContext()
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
