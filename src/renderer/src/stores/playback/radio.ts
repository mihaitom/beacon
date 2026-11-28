/** Radio: stations, and song or artist radio built from the library. */
import { getAudioEngine } from '@/services/audioEngine'
import { useLibraryStore } from '../library'
import { useConnectStore } from '../connect'
import { useAuthStore } from '../auth'
import { useRadioSettingsStore } from '../radioSettings'
import { useRadioMetadataStore } from '../radioMetadata'
import { useAudioMuseStore } from '../audiomuse'
import { sonicMix, sonicMood, sonicTheme, type SonicMixRequest } from '@/services/connect/audiomuse'
import * as connectPlayback from '@/services/connect/playback'
import type { Artist, RadioStation, Song } from '@/types/library'
import { getLocalMix } from '@/services/playback/localMix'
import { startRadioMetadataWatch, stopRadioMetadataWatch } from '@/services/connect/radioMetadata'
import {
  localRadioStreamUrl,
  newRadioConnectionId,
  resolveRadioStreamUrl,
} from '@/services/connect/radio'
import { registerRadioBrowserClick } from '@/services/connect/radioBrowser'
import { radioBrowserIdFor } from '@/services/radioBrowserLinks'
import { notifyPlexPassRequired, localRadioChangeGuard, positionTracker } from './shared'
import { runtime } from './shared'
import type { PlaybackContext } from './context'

export interface RadioActions {
  startSongRadio(song: Song): Promise<void>
  startArtistRadio(artist: Artist): Promise<void>
  startDiscoveryRadio(song: Song): Promise<void>
  startMoodMix(mood: string): Promise<void>
  startThemeMix(theme: string): Promise<void>
  playRadioStation(station: RadioStation): Promise<void>
  leaveRadio(): void
  startLocalRadio(streamUrl: string): void
  reconnectRadio(): void
}

// As many songs as a radio starts with when AudioMuse-AI picks them. Enough
// for a couple of hours; Autoplay carries on from there if it is on.
const SONIC_RADIO_LENGTH = 50

/** AudioMuse-AI's songs for a radio, or null when it cannot answer and the
 * media server should be asked instead. */
async function sonicRadio(request: SonicMixRequest): Promise<Song[] | null> {
  const audiomuse = useAudioMuseStore()
  if (!audiomuse.usable()) return null
  try {
    const songs = await sonicMix({ n: SONIC_RADIO_LENGTH, ...request })
    return songs.length ? songs : null
  } catch (error) {
    console.warn('[playback] AudioMuse radio failed, using the media server:', error)
    audiomuse.reset()
    return null
  }
}

/** Plays `song` followed by `similar` - or, when `song` is the one already
 * playing, keeps it going and replaces only what comes after. */
async function playFromSong(this: PlaybackContext, song: Song, similar: Song[]): Promise<void> {
  const rest = similar.filter((t) => t.id !== song.id)
  // From the song that is playing, the music carries on: only what
  // comes after it is replaced.
  if (!this.preview && this.currentSong?.id === song.id) {
    this.replaceQueueAfterCurrent(rest)
    return
  }
  // peek: a server-picked mix, unlike playSongList()'s other, more
  // direct callers (clicking a song/album/playlist you were already
  // looking at) — see peekQueueDrawer()'s own comment for why that
  // distinction is what actually decides whether a call site peeks.
  await this.playSongList([song, ...rest], 0, true, true)
}

export const radioActions: RadioActions & ThisType<PlaybackContext> = {
  /** Song Radio — songs similar to `song`, from AudioMuse-AI when it
   * answers and from the media server otherwise, in a fresh queue with
   * `song` first, so picking it always plays the song you actually
   * clicked, not an arbitrary similar one. */
  async startSongRadio(song: Song): Promise<void> {
    const sonic = await sonicRadio({ method: 'similar', add: [{ id: song.id }] })
    if (sonic) {
      await playFromSong.call(this, song, sonic)
      return
    }
    const { songs: similar, plexPassRequired } = await useLibraryStore()
      .client()
      .getSimilarSongs2(song.id)
    if (plexPassRequired) notifyPlexPassRequired('library.songRadio')
    await playFromSong.call(this, song, similar)
  },

  /** Discovery Radio — songs that sound related to `song` but sit further
   * from the middle of the library, AudioMuse-AI's hyperbolic "niche". No
   * fallback: without AudioMuse it would only be Song Radio again, so the
   * menus offer it only when AudioMuse answers, and a failure is an error
   * for the caller to show. */
  async startDiscoveryRadio(song: Song): Promise<void> {
    const songs = await sonicMix({
      method: 'discovery',
      add: [{ id: song.id }],
      n: SONIC_RADIO_LENGTH,
    })
    if (!songs.length) throw new Error('AudioMuse found nothing to discover from this song')
    await playFromSong.call(this, song, songs)
  },

  /** A mix around one of AudioMuse-AI's moods (Home's mood row). Like
   * Discovery Radio there is nothing to fall back on, so a failure is the
   * caller's to show. */
  async startMoodMix(mood: string): Promise<void> {
    const songs = await sonicMood(mood, SONIC_RADIO_LENGTH)
    if (!songs.length) throw new Error(`AudioMuse found nothing for the mood ${mood}`)
    await this.playSongList(songs, 0, true, true)
    // After playSongList(), whose new queue clears it.
    this.homeMix = `mood:${mood}`
  },

  /** A mix of songs whose lyrics are about one theme (Home's theme row),
   * the same way as a mood mix. */
  async startThemeMix(theme: string): Promise<void> {
    const songs = await sonicTheme(theme, SONIC_RADIO_LENGTH)
    if (!songs.length) throw new Error(`AudioMuse found nothing for the theme ${theme}`)
    await this.playSongList(songs, 0, true, true)
    this.homeMix = `theme:${theme}`
  },

  /** Artist Radio — AudioMuse-AI's blend of the artist when it answers;
   * otherwise the same getSimilarSongs2 endpoint as Song Radio, but
   * `id` here is the artist's own id rather than a song's; Navidrome's
   * recommendation engine accepts either (see SubsonicClient.
   * getSimilarSongs2's docstring). No single "seed" song to pin first
   * like Song Radio does — the whole point here is a mix across the
   * artist's catalog, not one particular song. */
  async startArtistRadio(artist: Artist): Promise<void> {
    // The artist's whole sound as one seed, rather than the media server's
    // guess from tags.
    const sonic = await sonicRadio({ method: 'blend', add: [{ id: artist.id, type: 'artist' }] })
    if (sonic) {
      await this.playSongList(sonic, 0, true, true)
      return
    }
    const { songs, plexPassRequired } = await useLibraryStore().client().getSimilarSongs2(artist.id)
    if (plexPassRequired) notifyPlexPassRequired('library.artistRadio')
    // peek — see startSongRadio()'s identical comment.
    await this.playSongList(songs, 0, true, true)
  },

  async playRadioStation(station: RadioStation): Promise<void> {
    const connect = useConnectStore()
    // A station published as a .m3u/.pls names where its audio really is
    // rather than being it (see services/connect/radio.ts) — resolved
    // once, here, and used for everything below. Deliberately not left to
    // the backend alone even though /play-url resolves it too: the
    // station this store holds has to carry the same URL connect ends up
    // reporting in its status, or reconcileFromStatus() reads every
    // single tick as a station change and rebuilds the station over and
    // over. Costs a round trip only for a URL that actually looks like a
    // playlist.
    // Reported here rather than where a station is found, and against
    // the URL as saved rather than the resolved one below: Radio Browser
    // counts a click as someone *listening*, and this is the one place a
    // station starts playing on purpose (a reconnect or a hand-off back
    // from casting goes straight to the audio engine, so neither
    // double-counts). Silent for a station Beacon has no Radio Browser
    // id for, which is most of them.
    this.preview = null
    const browserId = radioBrowserIdFor(station.streamUrl)
    if (browserId) registerRadioBrowserClick(browserId)

    const streamUrl = await resolveRadioStreamUrl(station.streamUrl)
    // The queue is deliberately left untouched: a station interrupts
    // whatever was lined up rather than throwing it away, so it's still
    // there to pick back up afterwards by clicking a row in it (see
    // playAtIndex(), which is what leaves the station again). currentSong
    // reading null for the duration is what keeps the station, and not
    // the queue's own current entry, showing as what's playing.
    this.radioStation = { ...station, streamUrl }
    useRadioMetadataStore().reset()
    this.radioConnectionLost = false
    // Cleared here rather than left to the first SSE tick — that first
    // tick is itself delayed by however long /play-url's own dispatch
    // takes, and a stale true/false from whatever this session was doing
    // a moment ago (a different station, a track) would otherwise show
    // for that whole gap.
    this.radioBuffering = false
    this.localPosition = 0
    // Radio has no track duration, and nothing else clears what the last
    // track left here (status.current_song is always null for a station).
    // No longer what keeps the elapsed readout honest — positionClamp
    // above does that, on every route to a playing station rather than
    // only this one — but still correct in its own right: leaving a
    // previous track's length sitting in state for anything else to read
    // would be a trap of its own.
    this.duration = 0
    // Same reasoning as startCurrent()'s identical reset() call — without
    // it, extrapolation would keep advancing from the last track's final
    // anchor until the first real radio status tick corrects it.
    positionTracker.reset()
    if (connect.isActive) {
      localRadioChangeGuard.begin(streamUrl)
      try {
        await connectPlayback.playUrl(streamUrl, station.name, {
          targets: connect.activeTargets,
          castDirectly: useRadioSettingsStore().castDirectly,
          // The same setting a song is cast under, both halves — see
          // connect's PlayUrlRequest for what each does to a station. It
          // does nothing at all while castDirectly is on: nothing sits
          // between the station and the device there to convert with.
          ...this.castQualityPayload,
        })
      } finally {
        localRadioChangeGuard.end(streamUrl)
      }
    } else {
      // Which also starts the now-playing watch, in the one mode that
      // still needs one — see startLocalRadio(). It used to be started
      // here for both branches, on the reasoning that the casting branch
      // above starting its own through /play-url made the repeat
      // harmless; that stopped being true once "relayed" became a thing
      // a local player can be as well, since the repeat would then be a
      // second connection to the station rather than a no-op.
      this.startLocalRadio(streamUrl)
    }
    // Both branches: neither has told the backend anything it has
    // finished acting on yet (the cast dispatch above has returned, but
    // a local station's relay only starts when the player opens the
    // stream), and this is what gets the station's log on screen without
    // waiting out an 8s interval on top of that.
    useRadioMetadataStore().startCatchup()
    this.isPlaying = true
  },

  /** Drops whatever radio state is set, if any — the station itself, its
   * "now playing" tag, the buffering indicator and the backend's own ICY
   * watch (see services/connect/radioMetadata.ts). A no-op when no
   * station is playing, so callers that just mean "a song is starting
   * now" can call it unconditionally.
   *
   * Deliberately does not touch the queue, stop the audio engine or tell
   * connect anything: every caller is on its way to starting a song,
   * which replaces the engine's source (or connect's dispatch) on its
   * own a moment later. */
  leaveRadio(): void {
    if (!this.radioStation) return
    stopRadioMetadataWatch()
    this.radioStation = null
    useRadioMetadataStore().reset()
    this.radioConnectionLost = false
    this.radioBuffering = false
  },

  /** Starts this device's own player on `streamUrl` — the single place
   * local radio playback begins.
   *
   * One place, because the decision it makes has two halves that must
   * never be made separately: where the audio comes from, and who reads
   * the station's now-playing tag. Routed through Beacon (the default,
   * see connect/routes/stream.py's /stream/radio-local) both come out of
   * the one connection the backend's relay holds. Straight from the
   * station, the audio is this element's own fetch and the tag needs a
   * second connection of its own (services/connect/radioMetadata.ts).
   * The same switch decides it here as for casting — a browser is one
   * more thing being fed a station, and the trade-off is the same one.
   */
  startLocalRadio(streamUrl: string): void {
    getLocalMix().stop()
    const direct = useRadioSettingsStore().castDirectly
    this.radioConnectionLost = false
    // Whatever was waiting belonged to the connection being replaced -
    // the new one starts with its own buffer and its own tag.
    useRadioMetadataStore().cancelPendingTitle()
    runtime.radioConnectionId = direct ? null : newRadioConnectionId()
    if (direct) {
      getAudioEngine().playLive(streamUrl)
      // The relay reports its own titles through the very same callback
      // this watch feeds (core/session.py's _set_radio_title), so this is
      // the one mode that still needs asking. Starting it alongside a
      // relay would open a second connection to the station to read
      // something already being read — the exact duplication the relay
      // exists to remove.
      startRadioMetadataWatch(streamUrl)
      return
    }
    const auth = useAuthStore()
    getAudioEngine().playLive(
      localRadioStreamUrl(
        auth.apiUrl,
        auth.connectToken,
        auth.sessionId,
        streamUrl,
        // The same setting a song plays under on this device — both
        // halves: the bitrate as a ceiling, and the format as what a
        // conversion comes out as (and what can be passed through
        // untouched). See connect/core/radio_relay.py.
        this.localQuality.format === 'original' ? undefined : this.localQuality.bitrate,
        this.localQuality.format === 'original' ? undefined : this.localQuality.format,
        runtime.radioConnectionId ?? undefined,
      ),
      // The relay holds the station's connection and queues what this
      // device misses while it cannot be reached, so a gap here is
      // something to wait through rather than to reconnect out of — see
      // audioEngine.ts's LIVE_HOLD_SECONDS.
      { holdsConnection: true },
    )
  },

  /** The listener's own "try again" for a station this device stopped
   * reconnecting to on its own (radioConnectionLost). Restarts the live
   * connection from scratch — there is nothing to resume, a station is
   * only ever served from its own edge — which also gives the engine a
   * fresh reconnect ladder, so a station that comes back a minute later
   * is one button press away rather than a hunt through the library.
   *
   * Local playback only, and deliberately so: while casting, the backend
   * relay is what holds the station's connection and it never stops
   * retrying on its own (core/radio_relay.py), so there is no give-up
   * state here for this to answer. */
  reconnectRadio(): void {
    const station = this.radioStation
    if (!station || this.isCasting) return
    // Shown as connecting straight away rather than after the first byte
    // arrives: pressing this and seeing nothing change for several
    // seconds reads as a button that did not work.
    this.radioBuffering = true
    this.startLocalRadio(station.streamUrl)
    this.isPlaying = true
  },
}
