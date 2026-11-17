/** Dispatch table between Remote Control's wire protocol (routes/remote.py,
 * connect/static/remote/js/*) and Beacon's existing playback/library stores —
 * every command below maps onto an action that already exists for the
 * desktop UI; this module only translates. */

import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { recordDeviceVolume, setVolume, volumeScope } from '@/services/volumeControl'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import { useFanartStore } from '@/stores/fanart'
import { useLyricsStore } from '@/stores/lyrics'
import { speakerKey, useEqualizerStore } from '@/stores/equalizer'
import { useLightsStore } from '@/stores/lights'
import { discoverBridges, getLights, type LightsUpdate } from '@/services/connect/lights'
import { PartyRefusal, usePartyStore } from '@/stores/party'
import { getArtistArt, fanartSource } from '@/services/connect/fanart'
import { EQ_PRESET_NAMES, EQ_PRESETS, sanitizeSetting } from '@/services/equalizer'
import type { Album, Artist, Playlist, Song } from '@/types/library'
import type { DeviceType, DiscoveredDevice } from '@/services/connect/types'
import { faviconSizeStep, RADIO_FAVICON_CACHE_VERSION } from '@/services/connect/radio'
import { matchesAllTerms } from '@/services/textSearch'

export interface RemoteSong {
  id: string
  title: string
  artist: string
  album: string
  /** Where the album's name leads (the phone's album page); null where
   * the server gave the song no album id. */
  album_id: string | null
  cover_art_url: string | null
  /** For an integration, which builds the /remote/cover-art URL itself with
   * its own key - cover_art_url is relative to the phone app's origin. */
  cover_art_id: string | null
  duration: number
  starred: boolean
  /** Where the artist's name leads (the phone's artist page); null where
   * the server gave the song no artist id. */
  artist_id: string | null
}

/** Deliberately NOT SubsonicClient.coverArtUrl() rewritten in place (an
 * earlier version of this did exactly that) — that URL carries the real
 * CONNECT_TOKEN as a query param (unavoidable for an <img src>, see
 * services/subsonic/client.ts), and shipping it to the phone would hand out
 * the same full API access CONNECT_TOKEN gives the trusted desktop process.
 * routes/remote.py's /cover-art serves the image itself under the phone's
 * own password instead.
 *
 * Without any credential, and relative: the phone is served by connect
 * itself, so the path resolves against the right origin in every build, and
 * the phone adds its own password (connect/static/remote/js/art.js). Baking
 * this app's copy of the password in made every image disappear once the
 * app had reloaded, because that copy is deliberately not recoverable
 * (see stores/remoteControl.ts) while the phone's own stays valid. */
function remoteCoverArtUrl(coverArtId: string | null): string | null {
  if (!coverArtId) return null
  const params = new URLSearchParams({ id: coverArtId })
  const sessionId = useAuthStore().sessionId
  if (sessionId) params.set('session', sessionId)
  return `/remote/cover-art?${params.toString()}`
}

/** Same reasoning as remoteCoverArtUrl() above, for internet radio station
 * logos — routes/remote.py's /radio-favicon re-exports routes/radio.py's
 * fetch-and-relay logic under the phone's password instead of CONNECT_TOKEN.
 *
 * `hint` is Radio Browser's own favicon field, carried by a station played
 * straight out of the discover dialog — which has no homepage at all, so
 * the hint is the only thing there is to resolve from. The desktop has
 * always passed both (see radioFaviconRequest); the phone used to send
 * neither and simply showed a fallback icon for those stations. */
export function remoteRadioFaviconUrl(
  homePageUrl: string | null,
  minSize = 0,
  hint: string | null = null,
): string | null {
  if (!homePageUrl && !hint) return null
  const params = new URLSearchParams({ url: homePageUrl ?? '' })
  if (hint) params.set('hint', hint)
  // Rounded to the same steps the desktop asks for (see faviconSizeStep), so
  // the phone shares the backend's already-resolved answer for a station
  // instead of making it look the station up again under a size of its own.
  const step = faviconSizeStep(minSize)
  if (step > 0) params.set('min_size', String(step))
  // Same handler, so the same stale-cache problem — see RADIO_FAVICON_CACHE_VERSION.
  params.set('v', RADIO_FAVICON_CACHE_VERSION)
  return `/remote/radio-favicon?${params.toString()}`
}

/** A Fanart.tv image for the phone, under its own password. The app's copy
 * of the URL carries CONNECT_TOKEN (see services/connect/fanart.ts), which
 * the phone must never receive - routes/remote.py's /fanart serves the
 * bytes under the phone credential instead. */
function remoteFanartUrl(proxiedUrl: string | null): string | null {
  const source = proxiedUrl ? fanartSource(proxiedUrl) : null
  return source ? `/remote/fanart?url=${encodeURIComponent(source)}` : null
}

export function toRemoteSong(song: Song): RemoteSong {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    album_id: song.albumId || null,
    cover_art_url: remoteCoverArtUrl(song.coverArtId),
    cover_art_id: song.coverArtId ?? null,
    duration: song.duration,
    starred: song.starred,
    artist_id: song.artistId || null,
  }
}

/** What an album row on the phone needs, and nothing more. */
function toRemoteAlbum(album: Album) {
  return {
    id: album.id,
    name: album.name,
    artist: album.artist,
    artist_id: album.artistId || null,
    year: album.year,
    starred: album.starred,
    cover_art_url: remoteCoverArtUrl(album.coverArtId),
    cover_art_id: album.coverArtId ?? null,
  }
}

/** What a playlist row on the phone needs, including the two fields that
 * decide which section it belongs to (see isOwnedBy). */
function toRemotePlaylist(playlist: Playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    song_count: playlist.songCount,
    duration: playlist.duration,
    owner: playlist.owner,
    public: playlist.public,
    smart: playlist.smart,
    owned_by_user: playlist.ownedByUser ?? null,
    changed: playlist.changed,
    comment: playlist.comment ?? null,
    cover_art_url: remoteCoverArtUrl(playlist.coverArtId),
    cover_art_id: playlist.coverArtId ?? null,
  }
}

/** What an artist row on the phone needs. The photo goes through the same
 * /remote/cover-art proxy as a cover: the server's own image URL carries its
 * credentials (see remoteCoverArtUrl). */
function toRemoteArtist(artist: Artist) {
  return {
    id: artist.id,
    name: artist.name,
    album_count: artist.albumCount,
    starred: artist.starred,
    cover_art_url: remoteCoverArtUrl(artist.coverArtId),
    cover_art_id: artist.coverArtId ?? null,
  }
}

async function resolveSong(songId: string): Promise<Song | null> {
  const library = useLibraryStore()
  const cached = library.allSongs.find((t) => t.id === songId)
  if (cached) return cached
  try {
    return await library.client().getSong(songId)
  } catch (error) {
    console.error('[remoteControl] Failed to resolve song', songId, error)
    return null
  }
}

export async function handleRemoteCommand(
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const playback = usePlaybackStore()
  const library = useLibraryStore()
  const connect = useConnectStore()

  switch (type) {
    // Directional, unlike toggle-play: an automation sends "pause" without
    // knowing the current state, and a toggle would start playback that was
    // already paused. Same guard as services/mediaSession.ts.
    case 'play':
      if (!playback.isPlaying) await playback.togglePlay()
      return
    case 'pause':
      if (playback.isPlaying) await playback.togglePlay()
      return
    case 'toggle-play':
      await playback.togglePlay()
      return
    case 'next':
      await playback.playNext()
      return
    case 'previous':
      await playback.playPrevious()
      return
    case 'seek':
      await playback.seek(Number(payload.position))
      return
    case 'volume': {
      // Mirrors PlayerBar.vue's own slider-swap logic exactly (one active
      // cast target -> that device's volume; several -> the master over
      // them; none -> local) — previously this always called
      // playback.setVolume(), which is silently inaudible while casting
      // (adjusts an <audio> element nobody's listening to).
      const targets = connect.activeTargets
      if (targets.length > 1) {
        const rounded = Math.round(Number(payload.volume) * 100)
        await setVolume(volumeScope(), rounded)
        useRemoteControlStore().reportDeviceVolume(rounded)
      } else if (targets.length === 1) {
        const rounded = Math.round(Number(payload.volume) * 100)
        await connect.setDeviceVolume(targets[0]!.type, targets[0]!.name, rounded)
        // Updates remoteControl's device_volume cache immediately instead of
        // leaving the phone's slider showing the pre-change value until
        // startDeviceVolumePoll()'s next tick — see reportDeviceVolume()'s
        // own comment.
        useRemoteControlStore().reportDeviceVolume(rounded)
      } else if (targets.length === 0) {
        playback.setVolume(Number(payload.volume))
      }
      return
    }
    case 'set-device-volume': {
      const deviceType = payload.deviceType as DeviceType
      const name = String(payload.name)
      const rounded = Number(payload.volume)
      await connect.setDeviceVolume(deviceType, name, rounded)
      // So the master and this window's own sliders follow.
      recordDeviceVolume({ type: deviceType, name }, rounded)
      const targets = connect.activeTargets
      if (targets.length === 1 && targets[0]!.type === deviceType && targets[0]!.name === name) {
        useRemoteControlStore().reportDeviceVolume(rounded)
      }
      return
    }
    case 'shuffle':
      playback.toggleShuffle()
      return
    case 'repeat':
      playback.cycleRepeatMode()
      return
    case 'autoplay': {
      // Through the playback store, not the autoplay one directly: while
      // casting this has to reach connect too, or the backend keeps topping
      // the queue up from the value it still holds.
      playback.setAutoplayEnabled(!useAutoplayStore().enabled)
      return
    }
    case 'queue-jump':
      await playback.playAtIndex(Number(payload.index))
      return
    case 'queue-remove':
      playback.removeFromQueue(Number(payload.index))
      return
    case 'queue-reorder':
      playback.reorderQueue(Number(payload.from), Number(payload.to))
      return
    // The phone doesn't know which song the mix has locked in as next, so
    // it names the target and the store works out the position.
    case 'queue-move': {
      const where = payload.where === 'end' ? 'end' : 'next'
      if (!playback.moveInQueue(Number(payload.index), where)) {
        throw new Error('This song cannot be moved there')
      }
      return
    }
    case 'play-song': {
      const song = await resolveSong(String(payload.songId))
      if (song) await playback.playSongList([song])
      return
    }
    case 'queue-add': {
      const song = await resolveSong(String(payload.songId))
      if (song) playback.addToQueue([song])
      return
    }
    case 'queue-next': {
      const song = await resolveSong(String(payload.songId))
      if (song) playback.queueNext([song])
      return
    }
    case 'party-wish': {
      const song = await resolveSong(String(payload.songId))
      if (!song) throw new PartyRefusal('not-found')
      usePartyStore().wish(
        song,
        String(payload.guestId),
        String(payload.guestName),
        Number(payload.maxPending),
      )
      return
    }
    case 'party-withdraw':
      usePartyStore().withdraw(String(payload.requestId), String(payload.guestId))
      return
    // The speaker's curve, from the phone's Now Playing. `target` is the
    // speaker being cast to; null would mean this device's own curve.
    case 'set-equalizer': {
      const setting = sanitizeSetting(payload.setting)
      const target = payload.target as { type: DeviceType; name: string } | null | undefined
      if (target?.type && target.name) {
        useEqualizerStore().setSpeaker({ type: target.type, name: target.name }, setting)
      } else {
        useEqualizerStore().setLocal(setting)
      }
      return
    }
    // Hue lights, from the phone's Now Playing. Pairing waits on the
    // bridge's button, which is why it is a command (45s budget) rather
    // than a query.
    case 'lights-pair':
      await useLightsStore().pair(String(payload.host))
      return
    case 'lights-forget':
      await useLightsStore().forget()
      return
    // The app's "Hear it now": restart the current song where it is, so a
    // curve that would otherwise wait for the next track is heard.
    case 'equalizer-apply': {
      if (playback.currentSong && !playback.radioStation) {
        await playback.startCurrent(playback.localPosition)
      }
      return
    }
    // Set rather than toggled: the phone says what it saw and wants, so a
    // second tap arriving late cannot undo the first one.
    case 'set-favorite': {
      const songId = String(payload.songId)
      // The queue's own object where it is there, so the player bar's heart
      // and the next snapshot change along with it.
      const song = playback.queue.find((s) => s.id === songId) ?? (await resolveSong(songId))
      if (song && song.starred !== (payload.favorite === true)) {
        await library.toggleFavorite('song', song)
      }
      return
    }
    // Albums and artists carry the same heart as a song; the phone sends
    // what it wants rather than "toggle", for the reason set-favorite does.
    case 'set-favorite-album': {
      const albumId = String(payload.albumId)
      const album =
        library.albums.find((a) => a.id === albumId) ?? (await library.fetchAlbum(albumId))
      if (album.starred !== (payload.favorite === true)) {
        await library.toggleFavorite('album', album)
      }
      return
    }
    case 'set-favorite-artist': {
      const artist = await library.client().getArtist(String(payload.artistId))
      if (artist.starred !== (payload.favorite === true)) {
        await library.toggleFavorite('artist', artist)
      }
      return
    }
    case 'play-song-radio': {
      const song = await resolveSong(String(payload.songId))
      if (song) await playback.startSongRadio(song)
      return
    }
    case 'play-artist-radio': {
      try {
        const artist = await library.client().getArtist(String(payload.artistId))
        await playback.startArtistRadio(artist)
      } catch (error) {
        console.error('[remoteControl] Failed to start artist radio', error)
      }
      return
    }
    case 'play-artist-songs': {
      // The artist page's most played songs, the rest following the tapped
      // one as on the app's own artist page. Fetched again, and found by
      // id, for the reason play-favorites below gives.
      const artist = await library.fetchArtist(String(payload.artistId))
      const songs = await library.fetchTopSongsForArtist(artist)
      const songId = String(payload.songId)
      const startIndex = Number(payload.startIndex)
      const position =
        songs[startIndex]?.id === songId ? startIndex : songs.findIndex((s) => s.id === songId)
      if (position < 0) return
      await playback.playSongList(songs, position)
      return
    }
    case 'play-album': {
      // Natural track order, pinFirst false — an album is a deliberately
      // sequenced work rather than a pile of songs, the same call
      // AlbumsView.vue and the mobile library make. peek for the same
      // reason play-playlist does below.
      const album = await library.fetchAlbum(String(payload.albumId))
      if (!album.songs.length) return
      // The album page's own track taps name their position; every other
      // caller (a row, a shelf) starts at the top.
      const startIndex = typeof payload.startIndex === 'number' ? payload.startIndex : 0
      await playback.playSongList(
        album.songs,
        Math.min(Math.max(0, startIndex), album.songs.length - 1),
        false,
        album.songs.length > 1,
      )
      return
    }
    // Home's song lists. The phone sends the ids it is showing rather than
    // naming a server-side list, so a rerolled Rediscover and a Home that
    // moved on between the fetch and the tap both play what was on screen.
    case 'play-songs': {
      const ids = Array.isArray(payload.songIds) ? payload.songIds.map(String) : []
      const songs = (await Promise.all(ids.map((id) => resolveSong(id)))).filter(
        (song): song is Song => song !== null,
      )
      if (!songs.length) return
      const requested = Number(payload.startIndex ?? 0)
      const start = Number.isFinite(requested)
        ? Math.min(Math.max(0, requested), songs.length - 1)
        : 0
      // pinFirst true for a list somebody picked a song from (Home's top
      // songs); false for "play all", which is the list's own order.
      await playback.playSongList(songs, start, payload.pinFirst !== false, songs.length > 1)
      return
    }
    // A Home shelf's "play all": one album after the other, in shelf order,
    // as the app's own playAllAlbums() concatenates them.
    case 'play-albums': {
      const ids = Array.isArray(payload.albumIds) ? payload.albumIds.map(String) : []
      const albums = await Promise.all(ids.map((id) => library.fetchAlbum(id)))
      const songs = albums.flatMap((album) => album.songs)
      if (!songs.length) return
      await playback.playSongList(songs, 0, false, songs.length > 1)
      return
    }
    case 'play-playlist': {
      const playlist = await library.fetchPlaylist(String(payload.playlistId))
      const startIndex = typeof payload.startIndex === 'number' ? payload.startIndex : 0
      // peek: this runs on the desktop process actually holding the queue
      // (see peekQueueDrawer()'s own comment) — the phone sending this
      // command has no queue drawer of its own to peek into.
      await playback.playSongList(playlist.songs, startIndex, true, playlist.songs.length > 1)
      return
    }
    case 'play-favorites': {
      // Fetched again rather than trusting the list the phone was shown:
      // a star toggled on the desktop since then shifts every index after
      // it, so the id the phone tapped is what decides where to start.
      await library.fetchStarred()
      const songs = library.starred.songs
      const songId = String(payload.songId)
      const startIndex = Number(payload.startIndex)
      const position =
        songs[startIndex]?.id === songId ? startIndex : songs.findIndex((s) => s.id === songId)
      if (position < 0) return
      await playback.playSongList(songs, position, true, songs.length > 1)
      return
    }
    case 'play-radio-station': {
      if (!library.radioStations.length) await library.fetchRadioStations()
      const station = library.radioStations.find((s) => s.id === payload.stationId)
      if (station) await playback.playRadioStation(station)
      return
    }
    case 'cast-to-many': {
      // Replaces the *entire* active target set with `targets` — the
      // phone's device picker (devices.js) is a proper multi-select (each
      // row a checkbox, an explicit "Done" button applies the result), so
      // "what's checked when I hit Done" is the complete desired set, not
      // an incremental add like the desktop's ConnectDevicePicker.vue
      // ("+N more") happens to be — simpler mental model for a picker that
      // doesn't stay open with live state the way the desktop's does.
      const raw = (payload.targets as { deviceType: string; name: string }[] | undefined) ?? []
      if (raw.length === 0) {
        await connect.stopAll()
        return
      }
      const targets = raw.map((t) => ({ type: t.deviceType as DeviceType, name: t.name }))
      try {
        // force=true, always. Without it the conflict-handling path applies:
        // it *swallows* a device_in_use into `connect.pendingTakeover`
        // instead of throwing, which is right for the desktop (its
        // takeover-confirm dialog reacts to that state) and useless here —
        // the phone has no such UI, so the request would silently do
        // nothing while a confirm dialog it can't see waits on the desktop.
        // The phone already saw "in use by X" in the device list before
        // picking it (see devices-request below), so checking a claimed
        // device is explicit intent to take over — no separate confirm
        // step — the same outcome a desktop user gets by confirming that
        // dialog. applyTargets() passes this through to both of its paths,
        // the fresh cast and the per-device joins of an edit; it used to
        // reach only the former, which is how a phone-side device switch
        // could still end up parked on a confirm dialog over on the
        // desktop.
        //
        // applyTargets() also reconciles instead of replacing, so picking a
        // second speaker on the phone joins it rather than dropping the
        // first — the same fix the desktop picker needed.
        await playback.applyTargets(targets, true)
      } catch (error) {
        console.error('[remoteControl] Failed to update cast targets:', error)
      }
      return
    }
    case 'resume-interrupted': {
      // The phone's counterpart to the desktop toast: an explicit "yes,
      // carry on" from a person, which is exactly the signal beacon cannot
      // derive for itself (see connect/routes/stream.py's
      // _mark_disconnected_if_not_reconnected).
      try {
        await playback.resumeAfterInterruption()
      } catch (error) {
        console.error('[remoteControl] Failed to resume after interruption:', error)
      }
      return
    }
    case 'cast-stop': {
      await connect.stopAll()
      return
    }
    default:
      console.warn('[remoteControl] Unknown command type:', type)
  }
}

export async function resolveRemoteQuery(
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const library = useLibraryStore()
  const playback = usePlaybackStore()

  switch (type) {
    case 'songs-request': {
      if (!library.allSongsLoaded) await library.fetchAllSongs()
      const search = String(payload.search ?? '').trim()
      const filtered = search
        ? library.allSongs.filter((t) =>
            matchesAllTerms(search, [t.title, t.artist], { exact: true }),
          )
        : library.allSongs
      const offset = Number(payload.offset ?? 0)
      const limit = Number(payload.limit ?? 50)
      return {
        items: filtered.slice(offset, offset + limit).map(toRemoteSong),
        total: filtered.length,
      }
    }
    case 'albums-request': {
      if (!library.albums.length) await library.fetchAlbums()
      const search = String(payload.search ?? '').trim()
      const filtered = search
        ? library.albums.filter((a) => matchesAllTerms(search, [a.name, a.artist], { exact: true }))
        : library.albums
      const offset = Number(payload.offset ?? 0)
      const limit = Number(payload.limit ?? 50)
      return {
        items: filtered.slice(offset, offset + limit).map(toRemoteAlbum),
        total: filtered.length,
      }
    }
    case 'album-request': {
      try {
        const album = await library.fetchAlbum(String(payload.albumId))
        return {
          album: toRemoteAlbum(album),
          songs: album.songs.map(toRemoteSong),
        }
      } catch {
        return { album: null, songs: [] }
      }
    }
    case 'artists-request': {
      if (!library.artists.length) await library.fetchArtists()
      const search = String(payload.search ?? '').trim()
      const filtered = search
        ? library.artists.filter((a) => matchesAllTerms(search, [a.name], { exact: true }))
        : library.artists
      const offset = Number(payload.offset ?? 0)
      const limit = Number(payload.limit ?? 50)
      return {
        items: filtered.slice(offset, offset + limit).map(toRemoteArtist),
        total: filtered.length,
      }
    }
    case 'artist-request': {
      // The phone's artist page, the same two halves as the app's own on a
      // phone (MobileArtistDetailView.vue): most played songs, then the
      // albums newest first.
      try {
        const artist = await library.fetchArtist(String(payload.artistId))
        const songs = await library.fetchTopSongsForArtist(artist)
        const albums = [...artist.albums].sort((a, b) => {
          if (a.year == null) return b.year == null ? 0 : 1
          if (b.year == null) return -1
          return b.year - a.year
        })
        return {
          artist: toRemoteArtist(artist),
          songs: songs.map(toRemoteSong),
          albums: albums.map(toRemoteAlbum),
        }
      } catch {
        return { artist: null, songs: [], albums: [] }
      }
    }
    case 'home-request': {
      // The phone's Home, from the same stores HomeView.vue reads (see
      // composables/homeShelves.ts). Each shelf is allowed to fail on its
      // own: one unavailable list must not take the whole page down.
      const auth = useAuthStore()
      // Discover deliberately uses plain random albums rather than the
      // similar-artist lookup the app runs: that one takes seconds through
      // MusicBrainz/ListenBrainz and fills a second shelf for artists the
      // remote has no page for.
      const shelves = await Promise.allSettled([
        library.fetchRecentlyPlayedAlbums(12),
        library.client().getAlbumList2('newest', 15),
        library.fetchRandomAlbums(15),
        (async () => {
          await library.fetchAllSongs()
          return library.mostPlayedSongs
        })(),
        auth.capabilities.playHistoryStats
          ? library.fetchRediscoverSongs(30)
          : Promise.resolve([] as Song[]),
      ])
      const shelf = <T>(index: number): T[] => {
        const result = shelves[index]
        return result?.status === 'fulfilled' ? (result.value as T[]) : []
      }
      return {
        recent: shelf<Album>(0).map(toRemoteAlbum),
        newest: shelf<Album>(1).map(toRemoteAlbum),
        discover: shelf<Album>(2).map(toRemoteAlbum),
        top_songs: shelf<Song>(3).map(toRemoteSong),
        rediscover: shelf<Song>(4).map(toRemoteSong),
      }
    }
    // Home's Discover shelf's own reroll: a fresh draw from the library,
    // without touching the shelves around it.
    case 'discover-request': {
      const albums = await library.fetchRandomAlbums(15)
      return { items: albums.map(toRemoteAlbum) }
    }
    case 'backdrop-request': {
      // The artist photo Now Playing shows behind everything. Off when the
      // installation switched Fanart.tv off; null when this artist has none,
      // which leaves the phone showing the blurred cover instead.
      const songId = String(payload.songId ?? '')
      const song = songId ? await resolveSong(songId) : playback.currentSong
      if (!song || !useFanartStore().enabled) {
        return { source: null, backgrounds: [], is_artist: false }
      }
      try {
        const art = await getArtistArt(song.artist)
        const source = remoteFanartUrl(art?.background ?? null)
        if (!source) return { source: null, backgrounds: [], is_artist: false }
        return {
          source,
          backgrounds: (art?.backgrounds ?? [])
            .map(remoteFanartUrl)
            .filter((url): url is string => url !== null),
          is_artist: true,
        }
      } catch {
        return { source: null, backgrounds: [], is_artist: false }
      }
    }
    case 'lyrics-request': {
      // The same store the app's own Now Playing panel reads, so a song
      // already looked at there costs the phone nothing.
      const songId = String(payload.songId ?? '')
      const song = songId ? await resolveSong(songId) : playback.currentSong
      if (!song) {
        return {
          song_id: null,
          synced: false,
          lines: [],
          credits: [],
          source: null,
          offset: 0,
          loading: false,
          error: false,
        }
      }
      const lyrics = useLyricsStore()
      // Started, not awaited: a provider lookup takes longer than the
      // phone's query budget, so this answers "still loading" and the
      // phone asks again shortly (see routes/remote.py's QUERY_TIMEOUT).
      if (lyrics.songId !== song.id && !lyrics.loading) void lyrics.ensureLoaded(song)
      const ready = lyrics.songId === song.id
      return {
        song_id: song.id,
        synced: ready && lyrics.synced,
        lines: ready ? lyrics.lines : [],
        credits: ready ? lyrics.credits : [],
        source: ready ? lyrics.source : null,
        offset: ready ? lyrics.offset : 0,
        loading: ready ? lyrics.loading : true,
        error: ready && lyrics.error,
      }
    }
    case 'equalizer-request': {
      // Only the speakers being cast to: the phone cannot hear this
      // device's own curve, and the button is only offered while casting.
      const equalizer = useEqualizerStore()
      const targets = useConnectStore().activeTargets.map(({ type, name }) => ({ type, name }))
      return {
        targets,
        settings: Object.fromEntries(
          targets.map((target) => [speakerKey(target), equalizer.speaker(target)]),
        ),
        presets: equalizer.presets,
        built_in: EQ_PRESET_NAMES.map((name) => ({ name, gains: EQ_PRESETS[name] })),
      }
    }
    case 'lights-request': {
      // null rather than an unanswered query: connect being unable to reach
      // the bridge is a normal outcome the dialog reports, not a timeout.
      try {
        return await getLights()
      } catch {
        return null
      }
    }
    case 'lights-discover-request': {
      try {
        return { bridges: await discoverBridges() }
      } catch {
        return null
      }
    }
    case 'lights-update-request': {
      // Through the store, so the desktop's own lights button and dialog
      // see the change too. Its answer is the state after connect's reply,
      // which is what the phone shows.
      try {
        const lights = useLightsStore()
        await lights.update(payload.update as LightsUpdate)
        return lights.lights
      } catch {
        return null
      }
    }
    case 'playlists-request': {
      await library.fetchPlaylists()
      return {
        // The phone groups the list into "mine / shared by me / shared with
        // me" itself, as the app's own Playlists page does - the owner
        // is only meaningful next to the signed-in account's name.
        username: useAuthStore().username,
        items: library.playlists.map(toRemotePlaylist),
      }
    }
    case 'playlist-request': {
      const playlist = await library.fetchPlaylist(String(payload.playlistId))
      return {
        playlist: {
          id: playlist.id,
          name: playlist.name,
          comment: playlist.comment ?? null,
          cover_art_url: remoteCoverArtUrl(playlist.coverArtId),
          cover_art_id: playlist.coverArtId ?? null,
        },
        songs: playlist.songs.map(toRemoteSong),
      }
    }
    case 'favorites-request': {
      // Songs, albums and artists, as the phone shell's library shows them
      // with its heart filter on (see MobileLibraryView.vue).
      await library.fetchStarred()
      return {
        songs: library.starred.songs.map(toRemoteSong),
        albums: library.starred.albums.map(toRemoteAlbum),
        artists: library.starred.artists.map(toRemoteArtist),
      }
    }
    case 'radio-request': {
      if (!library.radioStations.length) await library.fetchRadioStations()
      return {
        items: library.radioStations.map((s) => ({
          id: s.id,
          name: s.name,
          // min_size matters, not just cosmetic — see remoteRadioFaviconUrl's
          // default-0 comment: without it, routes/radio.py's _select() tries
          // the *smallest* candidate first, which is very often a Safari
          // "mask-icon" (a deliberately monochrome, unstyled SVG meant to be
          // recolored by Safari itself, not a real logo — see
          // routes/radio.py's own _ICON_RELS comment). Matches RadioView.vue's
          // own faviconUrl(homePageUrl, 32) for this same list-row use.
          favicon_url: remoteRadioFaviconUrl(s.homePageUrl, 32, s.favicon ?? null),
          // What favicon_url is built from, for an integration to build it
          // itself - see cover_art_id on RemoteSong.
          home_page_url: s.homePageUrl ?? null,
          favicon_hint: s.favicon ?? null,
        })),
      }
    }
    case 'devices-request': {
      const connect = useConnectStore()
      // A plain open takes whatever the last sweep found; the sheet's own
      // rescan button asks for a real one, the same distinction
      // ConnectDevicePicker.vue's rescan makes with refreshDevices(true).
      await connect.refreshDevices(payload.rescan === true)
      // Same grouping/order as the desktop's ConnectDevicePicker.vue
      // (TYPE_ORDER) — Sonos/AirPlay first as this app's best-supported
      // targets, DLNA last. Unlike that first attempt at this endpoint,
      // `needs_pairing` devices are *included* now (only excluded before,
      // which is why AirPlay speakers that hadn't been paired yet from the
      // desktop just silently never showed up on the phone at all) — the
      // phone can't run the actual pairing handshake (that needs a PIN
      // dialog wired to /pair/airplay, which only exists in the desktop's
      // AirplayPairingDialog.vue), so `needs_pairing` travels through for
      // the UI to grey the row out with a hint instead of pretending the
      // device isn't there.
      const typeOrder: DeviceType[] = ['sonos', 'airplay', 'chromecast', 'dlna']
      // Matches connectStore.isVolumeCapable() (see connect/routes/volume.py).
      const volumeCapableTypes = new Set<DeviceType>(['sonos', 'airplay', 'chromecast', 'dlna'])
      const flatten = (
        type: DeviceType,
        list: DiscoveredDevice[],
      ): {
        type: DeviceType
        name: string
        in_use_by_name: string | null
        needs_pairing: boolean
        volume_capable: boolean
      }[] =>
        [...list]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({
            type,
            name: d.name,
            in_use_by_name: d.in_use_by_name ?? null,
            needs_pairing: !!d.needs_pairing,
            volume_capable: volumeCapableTypes.has(type),
          }))
      const byType: Record<DeviceType, DiscoveredDevice[]> = {
        sonos: connect.devices.sonos,
        airplay: connect.devices.airplay,
        chromecast: connect.devices.chromecast,
        dlna: connect.devices.dlna,
      }
      return { items: typeOrder.flatMap((type) => flatten(type, byType[type])) }
    }
    case 'device-volume-request': {
      const connect = useConnectStore()
      const volume = await connect.getDeviceVolume(
        payload.deviceType as DeviceType,
        String(payload.name),
      )
      return { volume }
    }
    default:
      console.warn('[remoteControl] Unknown query type:', type)
      return { items: [] }
  }
}
