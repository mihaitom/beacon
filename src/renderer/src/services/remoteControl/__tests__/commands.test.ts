import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useAutoplayStore } from '@/stores/autoplay'
import { useAuthStore } from '@/stores/auth'
import {
  handleRemoteCommand,
  resolveRemoteQuery,
  remoteRadioFaviconUrl,
  toRemoteSong,
} from '../commands'
import { makeSong, makeStatus } from '@/stores/__tests__/fixtures'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Playlist, RadioStation, Artist } from '@/types/library'
import { RADIO_FAVICON_CACHE_VERSION } from '@/services/connect/radio'

// library.client() constructs a fresh SubsonicClient per call (see
// stores/library.ts) — spying on a specific instance's method is pointless
// since nothing under test ever sees that instance. Stubbing the whole
// `client()` action to hand back one fixed fake instead lets tests spy on
// *that*.
function fakeClient(overrides: Partial<SubsonicClient> = {}): SubsonicClient {
  return { getSong: vi.fn(), getArtist: vi.fn(), ...overrides } as unknown as SubsonicClient
}

describe('handleRemoteCommand', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('trivial pass-throughs', () => {
    it.each(['play', 'pause', 'toggle-play'] as const)(
      '%s calls playback.togglePlay()',
      async (type) => {
        const spy = vi.spyOn(usePlaybackStore(), 'togglePlay').mockResolvedValue()
        await handleRemoteCommand(type, {})
        expect(spy).toHaveBeenCalledOnce()
      },
    )

    it('next calls playback.playNext()', async () => {
      const spy = vi.spyOn(usePlaybackStore(), 'playNext').mockResolvedValue()
      await handleRemoteCommand('next', {})
      expect(spy).toHaveBeenCalledOnce()
    })

    it('previous calls playback.playPrevious()', async () => {
      const spy = vi.spyOn(usePlaybackStore(), 'playPrevious').mockResolvedValue()
      await handleRemoteCommand('previous', {})
      expect(spy).toHaveBeenCalledOnce()
    })

    it('cast-stop calls connect.stopAll()', async () => {
      const spy = vi.spyOn(useConnectStore(), 'stopAll').mockResolvedValue()
      await handleRemoteCommand('cast-stop', {})
      expect(spy).toHaveBeenCalledOnce()
    })

    it('shuffle toggles shuffle', async () => {
      const playback = usePlaybackStore()
      const spy = vi.spyOn(playback, 'toggleShuffle')
      await handleRemoteCommand('shuffle', {})
      expect(spy).toHaveBeenCalledOnce()
    })

    it('repeat cycles the repeat mode', async () => {
      const playback = usePlaybackStore()
      const spy = vi.spyOn(playback, 'cycleRepeatMode')
      await handleRemoteCommand('repeat', {})
      expect(spy).toHaveBeenCalledOnce()
    })
  })

  it('seek coerces the payload position to a number', async () => {
    const playback = usePlaybackStore()
    const spy = vi.spyOn(playback, 'seek').mockResolvedValue()

    await handleRemoteCommand('seek', { position: '42.5' })

    expect(spy).toHaveBeenCalledWith(42.5)
  })

  it('autoplay flips the current state', async () => {
    const autoplay = useAutoplayStore()
    autoplay.enabled = false

    await handleRemoteCommand('autoplay', {})
    expect(autoplay.enabled).toBe(true)

    await handleRemoteCommand('autoplay', {})
    expect(autoplay.enabled).toBe(false)
  })

  it('queue-jump / queue-remove / queue-reorder coerce their numeric payload fields', async () => {
    const playback = usePlaybackStore()
    const jumpSpy = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()
    const removeSpy = vi.spyOn(playback, 'removeFromQueue')
    const reorderSpy = vi.spyOn(playback, 'reorderQueue')

    await handleRemoteCommand('queue-jump', { index: '2' })
    await handleRemoteCommand('queue-remove', { index: '1' })
    await handleRemoteCommand('queue-reorder', { from: '0', to: '3' })

    expect(jumpSpy).toHaveBeenCalledWith(2)
    expect(removeSpy).toHaveBeenCalledWith(1)
    expect(reorderSpy).toHaveBeenCalledWith(0, 3)
  })

  describe('volume', () => {
    it('sets the local volume with nothing casting', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus()
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume')

      await handleRemoteCommand('volume', { volume: 0.5 })

      expect(setVolumeSpy).toHaveBeenCalledWith(0.5)
    })

    it('with exactly one active cast target, sets its device volume (rounded to a percentage) and reports it back immediately', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
      const setDeviceVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      const reportSpy = vi.spyOn(useRemoteControlStore(), 'reportDeviceVolume')

      await handleRemoteCommand('volume', { volume: 0.42 })

      expect(setDeviceVolumeSpy).toHaveBeenCalledWith('sonos', 'Kitchen', 42)
      expect(reportSpy).toHaveBeenCalledWith(42)
    })

    it('is a no-op with two or more active targets — no single device to represent', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({
        targets: [
          { name: 'A', type: 'sonos' },
          { name: 'B', type: 'sonos' },
        ],
      })
      const playback = usePlaybackStore()
      const setVolumeSpy = vi.spyOn(playback, 'setVolume')
      const setDeviceVolumeSpy = vi.spyOn(connect, 'setDeviceVolume')

      await handleRemoteCommand('volume', { volume: 0.5 })

      expect(setVolumeSpy).not.toHaveBeenCalled()
      expect(setDeviceVolumeSpy).not.toHaveBeenCalled()
    })
  })

  describe('set-device-volume', () => {
    it('sets the named device volume regardless of what is currently active', async () => {
      const connect = useConnectStore()
      const spy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()

      await handleRemoteCommand('set-device-volume', {
        deviceType: 'sonos',
        name: 'Kitchen',
        volume: 30,
      })

      expect(spy).toHaveBeenCalledWith('sonos', 'Kitchen', 30)
    })

    it('only reports the change back to remoteControl when that device is the single active target', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      const reportSpy = vi.spyOn(useRemoteControlStore(), 'reportDeviceVolume')
      connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })

      await handleRemoteCommand('set-device-volume', {
        deviceType: 'sonos',
        name: 'Kitchen',
        volume: 30,
      })
      expect(reportSpy).toHaveBeenCalledWith(30)

      reportSpy.mockClear()
      await handleRemoteCommand('set-device-volume', {
        deviceType: 'sonos',
        name: 'Someone Else',
        volume: 30,
      })
      expect(reportSpy).not.toHaveBeenCalled()
    })
  })

  describe('resolving a song id before acting on it', () => {
    it('play-song uses an already-cached library song without ever hitting the network', async () => {
      const library = useLibraryStore()
      const song = makeSong('a')
      library.allSongs = [song]
      const client = fakeClient()
      vi.spyOn(library, 'client').mockReturnValue(client)
      const playSpy = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-song', { songId: 'a' })

      expect(playSpy).toHaveBeenCalledWith([song])
      expect(client.getSong).not.toHaveBeenCalled()
    })

    it('queue-add falls back to the API for a song not yet in the local cache', async () => {
      const library = useLibraryStore()
      const fetched = makeSong('b')
      const client = fakeClient({ getSong: vi.fn().mockResolvedValue(fetched) })
      vi.spyOn(library, 'client').mockReturnValue(client)
      const addSpy = vi.spyOn(usePlaybackStore(), 'addToQueue')

      await handleRemoteCommand('queue-add', { songId: 'b' })

      expect(client.getSong).toHaveBeenCalledWith('b')
      expect(addSpy).toHaveBeenCalledWith([fetched])
    })

    it('queue-next silently does nothing when the song cannot be resolved anywhere', async () => {
      const library = useLibraryStore()
      const client = fakeClient({ getSong: vi.fn().mockRejectedValue(new Error('404')) })
      vi.spyOn(library, 'client').mockReturnValue(client)
      const queueNextSpy = vi.spyOn(usePlaybackStore(), 'queueNext')

      await handleRemoteCommand('queue-next', { songId: 'ghost' })

      expect(queueNextSpy).not.toHaveBeenCalled()
    })

    it('play-song-radio resolves the song and starts song radio from it', async () => {
      const library = useLibraryStore()
      const song = makeSong('c')
      library.allSongs = [song]
      const spy = vi.spyOn(usePlaybackStore(), 'startSongRadio').mockResolvedValue()

      await handleRemoteCommand('play-song-radio', { songId: 'c' })

      expect(spy).toHaveBeenCalledWith(song)
    })
  })

  it('play-artist-radio resolves the artist then starts artist radio, logging instead of throwing on failure', async () => {
    const library = useLibraryStore()
    const artist: Artist = {
      id: 'art1',
      name: 'The Tide',
      albumCount: 3,
      coverArtId: null,
      imageUrl: null,
      starred: false,
      rating: 0,
      albums: [],
    }
    const client = fakeClient({ getArtist: vi.fn().mockResolvedValue(artist) })
    vi.spyOn(library, 'client').mockReturnValue(client)
    const spy = vi.spyOn(usePlaybackStore(), 'startArtistRadio').mockResolvedValue()

    await handleRemoteCommand('play-artist-radio', { artistId: 'art1' })
    expect(spy).toHaveBeenCalledWith(artist)

    vi.mocked(client.getArtist).mockRejectedValue(new Error('404'))
    await expect(
      handleRemoteCommand('play-artist-radio', { artistId: 'missing' }),
    ).resolves.not.toThrow()
  })

  it('play-playlist fetches the playlist and starts it from the given index, defaulting to 0', async () => {
    const library = useLibraryStore()
    const playlist: Playlist = {
      id: 'p1',
      name: 'Chill',
      songCount: 2,
      duration: 300,
      coverArtId: null,
      public: false,
      owner: 'me',
      songs: [makeSong('a'), makeSong('b')],
    }
    const fetchSpy = vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(playlist)
    const playSpy = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

    await handleRemoteCommand('play-playlist', { playlistId: 'p1', startIndex: 1 })
    expect(fetchSpy).toHaveBeenCalledWith('p1')
    // peek: true, and pinFirst: true (the default) — see commands.ts's own
    // comment on why this peeks the *desktop's* queue drawer.
    expect(playSpy).toHaveBeenCalledWith(playlist.songs, 1, true, true)

    await handleRemoteCommand('play-playlist', { playlistId: 'p1' })
    expect(playSpy).toHaveBeenLastCalledWith(playlist.songs, 0, true, true)
  })

  describe('play-radio-station', () => {
    it('plays the matching station without re-fetching an already-loaded list', async () => {
      const library = useLibraryStore()
      const station: RadioStation = {
        id: 's1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example',
        homePageUrl: null,
      }
      library.radioStations = [station]
      const fetchSpy = vi.spyOn(library, 'fetchRadioStations').mockResolvedValue()
      const playSpy = vi.spyOn(usePlaybackStore(), 'playRadioStation').mockResolvedValue()

      await handleRemoteCommand('play-radio-station', { stationId: 's1' })

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(playSpy).toHaveBeenCalledWith(station)
    })

    it('fetches the list first when it is still empty', async () => {
      const library = useLibraryStore()
      const station: RadioStation = {
        id: 's1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example',
        homePageUrl: null,
      }
      const fetchSpy = vi.spyOn(library, 'fetchRadioStations').mockImplementation(async () => {
        library.radioStations = [station]
      })
      const playSpy = vi.spyOn(usePlaybackStore(), 'playRadioStation').mockResolvedValue()

      await handleRemoteCommand('play-radio-station', { stationId: 's1' })

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(playSpy).toHaveBeenCalledWith(station)
    })
  })

  describe('resume-interrupted', () => {
    it('picks playback back up when the phone asks, and never on its own', async () => {
      const playback = usePlaybackStore()
      const spy = vi.spyOn(playback, 'resumeAfterInterruption').mockResolvedValue()

      await handleRemoteCommand('resume-interrupted', {})

      expect(spy).toHaveBeenCalledOnce()
    })

    it('logs instead of throwing when the device is gone by the time it is tapped', async () => {
      vi.spyOn(usePlaybackStore(), 'resumeAfterInterruption').mockRejectedValue(
        new Error('unreachable'),
      )

      await expect(handleRemoteCommand('resume-interrupted', {})).resolves.not.toThrow()
    })
  })

  describe('cast-to-many', () => {
    it('stops all casting when the target list is empty', async () => {
      const connect = useConnectStore()
      const stopSpy = vi.spyOn(connect, 'stopAll').mockResolvedValue()

      await handleRemoteCommand('cast-to-many', { targets: [] })

      expect(stopSpy).toHaveBeenCalledOnce()
    })

    it('forces a cast to every given target, mapping deviceType onto type', async () => {
      const applySpy = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()

      await handleRemoteCommand('cast-to-many', {
        targets: [{ deviceType: 'sonos', name: 'Kitchen' }],
      })

      // applyTargets(), not castTo(): the phone sends a desired end state,
      // and on a running session castTo() would replace the targets rather
      // than reconcile them. Asserting on castTo() here used to pass either
      // way, since applyTargets() delegates to it when nothing is casting.
      expect(applySpy).toHaveBeenCalledWith([{ type: 'sonos', name: 'Kitchen' }], true)
    })

    it('joins an added device rather than dropping the one already casting', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({ targets: [{ type: 'sonos', name: 'Kitchen' }] })
      const joinSpy = vi.spyOn(connect, 'joinDevice').mockResolvedValue()
      const castSpy = vi.spyOn(usePlaybackStore(), 'castTo').mockResolvedValue()

      await handleRemoteCommand('cast-to-many', {
        targets: [
          { deviceType: 'sonos', name: 'Kitchen' },
          { deviceType: 'sonos', name: 'Living Room' },
        ],
      })

      expect(joinSpy).toHaveBeenCalledWith({ type: 'sonos', name: 'Living Room' })
      expect(castSpy).not.toHaveBeenCalled()
    })

    it('logs instead of throwing when applying the targets fails (e.g. the device went offline)', async () => {
      vi.spyOn(usePlaybackStore(), 'applyTargets').mockRejectedValue(new Error('offline'))

      await expect(
        handleRemoteCommand('cast-to-many', {
          targets: [{ deviceType: 'sonos', name: 'Kitchen' }],
        }),
      ).resolves.not.toThrow()
    })
  })

  it('warns on an unknown command type without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(handleRemoteCommand('not-a-real-command', {})).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('resolveRemoteQuery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('songs-request', () => {
    it('fetches the full library only once, filters case-insensitively across title and artist, and paginates', async () => {
      const library = useLibraryStore()
      const songs = [
        makeSong('a', { title: 'Harbor Lights', artist: 'The Tide' }),
        makeSong('b', { title: 'Other Track', artist: 'Nobody' }),
      ]
      const fetchSpy = vi.spyOn(library, 'fetchAllSongs').mockImplementation(async () => {
        library.allSongs = songs
        library.allSongsLoaded = true
      })

      const result = (await resolveRemoteQuery('songs-request', { search: 'tide' })) as {
        items: { id: string }[]
        total: number
      }

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(result.items).toEqual([expect.objectContaining({ id: 'a' })])
      expect(result.total).toBe(1)
    })

    it('does not re-fetch once the library is already loaded', async () => {
      const library = useLibraryStore()
      library.allSongs = [makeSong('a')]
      library.allSongsLoaded = true
      const fetchSpy = vi.spyOn(library, 'fetchAllSongs')

      await resolveRemoteQuery('songs-request', {})

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('slices by offset/limit', async () => {
      const library = useLibraryStore()
      library.allSongsLoaded = true
      library.allSongs = Array.from({ length: 5 }, (_, i) => makeSong(`s${i}`))

      const result = (await resolveRemoteQuery('songs-request', { offset: 2, limit: 2 })) as {
        items: { id: string }[]
        total: number
      }

      expect(result.items.map((s) => s.id)).toEqual(['s2', 's3'])
      expect(result.total).toBe(5)
    })
  })

  it('playlists-request maps each playlist, including its cover art url', async () => {
    const library = useLibraryStore()
    library.playlists = [
      {
        id: 'p1',
        name: 'Chill',
        songCount: 3,
        duration: 100,
        coverArtId: null,
        public: false,
        owner: 'me',
        songs: [],
      },
    ]
    vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()

    const result = await resolveRemoteQuery('playlists-request', {})

    expect(result).toEqual({
      items: [{ id: 'p1', name: 'Chill', song_count: 3, cover_art_url: null }],
    })
  })

  it('playlist-request fetches one playlist by id and maps its songs', async () => {
    const library = useLibraryStore()
    const playlist: Playlist = {
      id: 'p1',
      name: 'Chill',
      songCount: 1,
      duration: 100,
      coverArtId: null,
      public: false,
      owner: 'me',
      songs: [makeSong('a')],
    }
    vi.spyOn(library, 'fetchPlaylist').mockResolvedValue(playlist)

    const result = (await resolveRemoteQuery('playlist-request', { playlistId: 'p1' })) as {
      playlist: { id: string }
      songs: { id: string }[]
    }

    expect(result.playlist.id).toBe('p1')
    expect(result.songs).toEqual([expect.objectContaining({ id: 'a' })])
  })

  it('radio-request fetches the station list only if empty, and maps favicon urls with min_size 32', async () => {
    const library = useLibraryStore()
    const fetchSpy = vi.spyOn(library, 'fetchRadioStations').mockImplementation(async () => {
      library.radioStations = [
        { id: 's1', name: 'Chill FM', streamUrl: 'https://stream.example', homePageUrl: null },
      ]
    })

    const result = await resolveRemoteQuery('radio-request', {})

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(result).toEqual({ items: [{ id: 's1', name: 'Chill FM', favicon_url: null }] })
  })

  it('devices-request refreshes, then groups/sorts/flattens devices in the fixed Sonos/AirPlay/Chromecast/DLNA order', async () => {
    const connect = useConnectStore()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    connect.devices = {
      sonos: [{ name: 'Zebra' }, { name: 'Alpha' }],
      airplay: [{ name: 'Speaker', needs_pairing: true }],
      chromecast: [],
      dlna: [{ name: 'Renderer', in_use_by_name: 'Someone' }],
    }

    const result = (await resolveRemoteQuery('devices-request', {})) as {
      items: Record<string, unknown>[]
    }

    expect(refreshSpy).toHaveBeenCalledOnce()
    expect(result.items.map((d) => d.name)).toEqual(['Alpha', 'Zebra', 'Speaker', 'Renderer'])
    // Sorted alphabetically within Sonos, and volume-capable (unlike AirPlay).
    expect(result.items[0]).toMatchObject({ type: 'sonos', volume_capable: true })
    // needs_pairing travels through instead of being filtered out (see the
    // function's own comment on why: the phone shows it greyed out with a
    // hint, rather than the device silently never appearing at all).
    expect(result.items.find((d) => d.name === 'Speaker')).toMatchObject({
      type: 'airplay',
      volume_capable: false,
      needs_pairing: true,
    })
    expect(result.items.find((d) => d.name === 'Renderer')).toMatchObject({
      type: 'dlna',
      in_use_by_name: 'Someone',
    })
  })

  it('device-volume-request forwards straight to connect.getDeviceVolume', async () => {
    const connect = useConnectStore()
    vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(55)

    const result = await resolveRemoteQuery('device-volume-request', {
      deviceType: 'sonos',
      name: 'Kitchen',
    })

    expect(result).toEqual({ volume: 55 })
  })

  it('warns and returns an empty item list for an unknown query type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await resolveRemoteQuery('not-a-real-query', {})

    expect(result).toEqual({ items: [] })
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('phone-scoped media URLs (remoteCoverArtUrl / remoteRadioFaviconUrl)', () => {
  const originalApi = window.api

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    window.api = originalApi
  })

  it("toRemoteSong omits cover_art_url until remote control has issued this session's password", () => {
    const remote = toRemoteSong(makeSong('a', { coverArtId: 'cover1' }))
    expect(remote.cover_art_url).toBeNull()
  })

  it('builds a LAN-address URL with id/password/session once Electron remote control is set up', () => {
    window.api = {} as typeof window.api
    const remoteControl = useRemoteControlStore()
    remoteControl.password = 'secret'
    remoteControl.lanIp = '192.168.1.5'
    remoteControl.port = 8080
    useAuthStore().sessionId = 'sess-1'

    const remote = toRemoteSong(makeSong('a', { coverArtId: 'cover1' }))

    expect(remote.cover_art_url).toBe(
      'http://192.168.1.5:8080/remote/cover-art?id=cover1&password=secret&session=sess-1',
    )
  })

  it('stays null in Electron until lanIp/port are known, even with a password already set', () => {
    window.api = {} as typeof window.api
    useRemoteControlStore().password = 'secret'

    expect(toRemoteSong(makeSong('a', { coverArtId: 'cover1' })).cover_art_url).toBeNull()
  })

  it("uses this page's own origin instead of lanIp/port on the web build", () => {
    useRemoteControlStore().password = 'secret'

    const remote = toRemoteSong(makeSong('a', { coverArtId: 'cover1' }))

    expect(remote.cover_art_url).toBe(
      `${window.location.origin}/remote/cover-art?id=cover1&password=secret`,
    )
  })

  it('remoteRadioFaviconUrl is null without a homePageUrl, and only adds min_size when given a positive one', () => {
    useRemoteControlStore().password = 'secret'

    expect(remoteRadioFaviconUrl(null)).toBeNull()
    expect(remoteRadioFaviconUrl('https://station.example')).toBe(
      `${window.location.origin}/remote/radio-favicon?url=${encodeURIComponent(
        'https://station.example',
      )}&password=secret&v=${RADIO_FAVICON_CACHE_VERSION}`,
    )
    // Rounded up to the shared size step, so the phone reuses the answer the
    // desktop's own list row already had the backend resolve.
    expect(remoteRadioFaviconUrl('https://station.example', 32)).toContain('min_size=64')
  })
})
