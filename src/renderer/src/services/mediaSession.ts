import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'

// OS-level media keys (keyboard multimedia keys, Windows/macOS lock-screen
// controls, and the GNOME/KDE media widget on Linux over MPRIS) all read
// from this one browser-standard API rather than anything Electron- or
// platform-specific, so this one service covers every OS Beacon runs on.
// Guarded by `'mediaSession' in navigator` rather than assumed — desktop
// Chromium/Electron has it, but nothing else here should hard-fail if a
// future web/mobile-browser target doesn't.
//
// Confirmed live (2026-08-20, via `playerctl` on Hyprland/Linux) working
// for *local* playback — MPRIS registered correctly with real
// title/artist/album/length, and remote play/pause genuinely controlled
// it — on both a Chromium-based browser and Firefox/Gecko (Waterfox), so
// this isn't a Chromium-only thing the way an earlier version of this
// comment assumed. NOT exposed at all while casting, on either engine:
// the browser only reports a session to the OS while a real, audible
// <audio>/<video> element is actually playing in the tab, and casting
// sends no audio through one at all (it goes straight to the Sonos/
// Chromecast/AirPlay/DLNA device — see connect/routes/stream.py). A
// silent looping <audio> element could keep a "real" session alive during
// casting too, but that's fragile enough (autoplay policy quirks,
// volume-zero edge cases) to deliberately leave unimplemented — the cast
// target's own controls (its companion app, physical buttons) already
// cover that case. See README.md's FAQ for the user-facing version of
// this same explanation.

// Re-derived on every playbackStore mutation (see initMediaSession()) —
// including ones with nothing to do with the current song (a position
// tick, a queue edit) — so these guard against rebuilding
// MediaMetadata/re-setting playbackState when nothing actually relevant
// changed, the same "cheap to over-call, just no-op internally" shape
// syncCastQueue()'s own $subscribe-driven callers already use elsewhere.
let lastMetadataKey: string | null = null
let lastPlaybackState: MediaSessionPlaybackState | null = null
let lastQueueHandlersSet: boolean | null = null

/** Wrapped per-handler, not once around a whole block: Chromium accepts
 * every action this service registers, but a browser that only partially
 * implements this API (an older or non-Chromium one, were this ever to run
 * in one) shouldn't lose every handler just because one of them threw. */
function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
  try {
    navigator.mediaSession.setActionHandler(action, handler)
  } catch {
    // Not supported by this browser — that one control just doesn't
    // appear on the OS side; the rest still work.
  }
}

function updatePlaybackState(): void {
  const playback = usePlaybackStore()
  const state: MediaSessionPlaybackState = playback.isPlaying ? 'playing' : 'paused'
  if (state === lastPlaybackState) return
  lastPlaybackState = state
  navigator.mediaSession.playbackState = state
}

function updateMetadata(): void {
  const playback = usePlaybackStore()
  const song = playback.currentSong
  const radio = playback.radioStation
  // The station's own ICY "now playing" tag (services/connect/
  // radioMetadata.ts) - shown as the "artist" the same lock-screen/media-
  // widget surfaces this whole service targets would show for a song,
  // since a station has no artist field of its own to put there instead.
  const nowPlaying = radio ? playback.radioNowPlaying : null
  const key = song ? `song:${song.id}` : radio ? `radio:${radio.name}:${nowPlaying ?? ''}` : null
  if (key === lastMetadataKey) return
  lastMetadataKey = key

  if (!song && !radio) {
    navigator.mediaSession.metadata = null
    return
  }

  const artwork: MediaImage[] = []
  if (song?.coverArtId) {
    // One size is enough — unlike <img>'s own srcset-style multi-size use
    // elsewhere, every OS surface this actually renders into (lock screen,
    // media widget) scales a single reasonably-sized image itself; there's
    // no real benefit to offering several like a website favicon set would.
    const url = useLibraryStore().client().coverArtUrl(song.coverArtId, 300)
    if (url) artwork.push({ src: url, sizes: '300x300' })
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song?.title ?? radio?.name ?? '',
    artist: song?.artist ?? nowPlaying ?? '',
    album: song?.album ?? '',
    artwork,
  })
}

/** Registers (or withdraws) the queue-shaped actions, following whether a
 * radio station is what's playing. A live stream has no previous/next track
 * and nothing to seek within — the playback store's own playPrevious()/
 * playNext()/seek() all return early for it — and an action handler is
 * exactly what makes the OS *draw* that button on a lock screen or media
 * widget, so leaving them registered puts skip arrows on a phone's lock
 * screen that do nothing at all. Withdrawing them (null) removes the
 * buttons instead, matching what CenterControls.vue/
 * MobileTransportControls.vue disable in the app's own UI.
 *
 * Kept behind lastQueueHandlersSet: this runs from the same $subscribe as
 * updateMetadata(), i.e. on every playback mutation including the ~4x/sec
 * position tick, and re-registering three handlers that many times a second
 * is work for nothing. */
function updateQueueHandlers(): void {
  const playback = usePlaybackStore()
  const wanted = playback.radioStation == null
  if (wanted === lastQueueHandlersSet) return
  lastQueueHandlersSet = wanted
  setHandler('previoustrack', wanted ? () => void playback.playPrevious() : null)
  setHandler('nexttrack', wanted ? () => void playback.playNext() : null)
  setHandler(
    'seekto',
    wanted
      ? (details) => {
          if (details.seekTime != null) void playback.seek(details.seekTime)
        }
      : null,
  )
}

/** Called once from playbackStore.init() — sets up the action handlers
 * (play/pause/stop map straight onto the same actions PlayerBar.vue's own
 * buttons call; the queue-shaped ones come and go with
 * updateQueueHandlers() above) and a playbackStore subscription that keeps
 * metadata/playbackState/those handlers current from then on. Safe to call from
 * environments without the API (Docker/web on an older or non-Chromium
 * browser) — becomes a no-op rather than throwing. */
export function initMediaSession(): void {
  if (!('mediaSession' in navigator)) return
  const playback = usePlaybackStore()

  // Checked against the current state before ever calling togglePlay() —
  // these are directional (the OS is asking "make it play"/"make it
  // pause"), not a toggle. Chromium is only supposed to invoke 'play' while
  // playbackState is 'paused' and 'pause' while it's 'playing', but a
  // duplicate/delayed action from the OS side (media-widget quirk, a
  // double-fired hardware key) landing after playback already changed
  // direction on its own would otherwise silently do the opposite of what
  // was asked — see the 2026-08-20 incident this guards: a stray extra
  // 'play' while already playing routed into togglePlay()'s connect branch
  // as an unwanted /resume, which is destructive on its own (see that
  // route's own comment) on top of firing in the wrong direction here.
  setHandler('play', () => {
    if (!playback.isPlaying) void playback.togglePlay()
  })
  setHandler('pause', () => {
    if (playback.isPlaying) void playback.togglePlay()
  })
  setHandler('stop', () => {
    if (playback.isPlaying) void playback.togglePlay()
  })

  playback.$subscribe(() => {
    updateMetadata()
    updatePlaybackState()
    updateQueueHandlers()
  })
  updateMetadata()
  updatePlaybackState()
  updateQueueHandlers()
}
