/** Dispatch table between Remote Control's wire protocol (routes/remote.py,
 * connect/static/remote/js/*) and Beacon's existing playback/library stores —
 * every command below maps onto an action that already exists for the
 * desktop UI; this module only translates. */

import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useAuthStore } from '@/stores/auth'
import { useAutoplayStore } from '@/stores/autoplay'
import type { Song } from '@/types/library'
import type { DeviceType, DiscoveredDevice } from '@/services/connect/types'
import { RADIO_FAVICON_CACHE_VERSION } from '@/services/connect/radio'

export interface RemoteSong {
  id: string
  title: string
  artist: string
  album: string
  cover_art_url: string | null
  duration: number
}

/** Base URL for the phone-facing image endpoints below — same address the
 * pairing QR code itself points at (LAN-reachable in Electron, this page's
 * own origin in the web/Docker build). Returns null while that isn't known
 * yet or the phone password hasn't been generated this session (see
 * stores/remoteControl.ts's needsRegenerate) — callers degrade to "no
 * artwork" rather than build a URL that can't actually authenticate. */
function remoteMediaBase(): { origin: string; password: string } | null {
  const remoteControl = useRemoteControlStore()
  if (!remoteControl.password) return null
  if (window.api) {
    if (!remoteControl.lanIp || !remoteControl.port) return null
    return {
      origin: `http://${remoteControl.lanIp}:${remoteControl.port}`,
      password: remoteControl.password,
    }
  }
  return { origin: window.location.origin, password: remoteControl.password }
}

/** Deliberately NOT SubsonicClient.coverArtUrl() rewritten in place (an
 * earlier version of this did exactly that) — that URL carries the real
 * CONNECT_TOKEN as a query param (unavoidable for an <img src>, see
 * services/subsonic/client.ts), and shipping it to the phone would hand out
 * the same full API access CONNECT_TOKEN gives the trusted desktop process,
 * defeating the entire point of the phone having its own narrower password.
 * routes/remote.py's /cover-art redirects to a properly-scoped, LAN-reachable
 * URL instead — this only ever needs the coverArtId and this session's
 * connect session id (not a secret, just an identifier), not the token. */
function remoteCoverArtUrl(coverArtId: string | null): string | null {
  if (!coverArtId) return null
  const base = remoteMediaBase()
  if (!base) return null
  const auth = useAuthStore()
  const params = new URLSearchParams({ id: coverArtId, password: base.password })
  if (auth.sessionId) params.set('session', auth.sessionId)
  return `${base.origin}/remote/cover-art?${params.toString()}`
}

/** Same reasoning as remoteCoverArtUrl() above, for internet radio station
 * logos — routes/remote.py's /radio-favicon re-exports routes/radio.py's
 * fetch-and-relay logic under the phone's password instead of CONNECT_TOKEN. */
export function remoteRadioFaviconUrl(homePageUrl: string | null, minSize = 0): string | null {
  if (!homePageUrl) return null
  const base = remoteMediaBase()
  if (!base) return null
  const params = new URLSearchParams({ url: homePageUrl, password: base.password })
  if (minSize > 0) params.set('min_size', String(minSize))
  // Same handler, so the same stale-cache problem — see RADIO_FAVICON_CACHE_VERSION.
  params.set('v', RADIO_FAVICON_CACHE_VERSION)
  return `${base.origin}/remote/radio-favicon?${params.toString()}`
}

export function toRemoteSong(song: Song): RemoteSong {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    cover_art_url: remoteCoverArtUrl(song.coverArtId),
    duration: song.duration,
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
    case 'play':
    case 'pause':
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
      // Mirrors PlayerBar.vue's own slider-swap logic exactly (single
      // active cast target -> that device's volume; anything else -> local)
      // — previously this always called playback.setVolume(), which is
      // silently inaudible while casting (adjusts an <audio> element
      // nobody's listening to). With 2+ active targets there's no single
      // "the" volume to set here either, same as PlayerBar.vue's local
      // slider going disabled in that case — see devices-request/
      // set-device-volume below for per-device control instead.
      const targets = connect.activeTargets
      if (targets.length === 1) {
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
    case 'play-playlist': {
      const playlist = await library.fetchPlaylist(String(payload.playlistId))
      const startIndex = typeof payload.startIndex === 'number' ? payload.startIndex : 0
      // peek: this runs on the desktop process actually holding the queue
      // (see peekQueueDrawer()'s own comment) — the phone sending this
      // command has no queue drawer of its own to peek into.
      await playback.playSongList(playlist.songs, startIndex, true, playlist.songs.length > 1)
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
        // force=true, always — playback.castTo()'s force=false path routes
        // through connect.withTakeoverHandling(), which *swallows* a
        // device_in_use conflict into `connect.pendingTakeover` instead of
        // throwing (the desktop's takeover-confirm dialog reacts to that
        // state; the phone has no UI for it, so that call would just silently
        // no-op here). The phone already saw "in use by X" in the device
        // list before picking it (see devices-request below), so checking a
        // claimed device is explicit intent to take over — no separate
        // confirm step — the same outcome a desktop user gets by confirming
        // that dialog.
        // applyTargets() reconciles instead of replacing, so picking a
        // second speaker on the phone joins it rather than dropping the
        // first — the same fix the desktop picker needed. force=true still
        // applies to the fresh-cast path inside it; see below for why the
        // phone always takes over.
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

  switch (type) {
    case 'songs-request': {
      if (!library.allSongsLoaded) await library.fetchAllSongs()
      const search = String(payload.search ?? '')
        .trim()
        .toLowerCase()
      const filtered = search
        ? library.allSongs.filter(
            (t) =>
              t.title.toLowerCase().includes(search) || t.artist.toLowerCase().includes(search),
          )
        : library.allSongs
      const offset = Number(payload.offset ?? 0)
      const limit = Number(payload.limit ?? 50)
      return {
        items: filtered.slice(offset, offset + limit).map(toRemoteSong),
        total: filtered.length,
      }
    }
    case 'playlists-request': {
      await library.fetchPlaylists()
      return {
        items: library.playlists.map((p) => ({
          id: p.id,
          name: p.name,
          song_count: p.songCount,
          cover_art_url: remoteCoverArtUrl(p.coverArtId),
        })),
      }
    }
    case 'playlist-request': {
      const playlist = await library.fetchPlaylist(String(payload.playlistId))
      return {
        playlist: {
          id: playlist.id,
          name: playlist.name,
          cover_art_url: remoteCoverArtUrl(playlist.coverArtId),
        },
        songs: playlist.songs.map(toRemoteSong),
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
          favicon_url: remoteRadioFaviconUrl(s.homePageUrl, 32),
        })),
      }
    }
    case 'devices-request': {
      const connect = useConnectStore()
      await connect.refreshDevices()
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
      // Matches DeviceListItem.vue's own VOLUME_CAPABLE_TYPES — AirPlay/RAOP
      // has no per-device volume endpoint (see connect/routes/volume.py).
      const volumeCapableTypes = new Set<DeviceType>(['sonos', 'chromecast', 'dlna'])
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
