import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { useRemoteControlStore } from '@/stores/remoteControl'
import { useAutoplayStore } from '@/stores/autoplay'
import { useAuthStore } from '@/stores/auth'
import { useGroupVolumeStore } from '@/stores/groupVolume'
import { useFanartStore } from '@/stores/fanart'
import { useEqualizerStore } from '@/stores/equalizer'
import { useLightsStore } from '@/stores/lights'
import { useLyricsStore } from '@/stores/lyrics'
import { PartyRefusal, usePartyStore } from '@/stores/party'
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
import { saveSongSort } from '@/services/library/songBrowse'

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
    it('toggle-play calls playback.togglePlay()', async () => {
      const spy = vi.spyOn(usePlaybackStore(), 'togglePlay').mockResolvedValue()
      await handleRemoteCommand('toggle-play', {})
      expect(spy).toHaveBeenCalledOnce()
    })

    // An automation sends play/pause without knowing the current state.
    it.each([
      ['play', false, 1],
      ['play', true, 0],
      ['pause', true, 1],
      ['pause', false, 0],
    ] as const)('%s while playing=%s toggles %i time(s)', async (type, playing, calls) => {
      const playback = usePlaybackStore()
      vi.spyOn(playback, 'isPlaying', 'get').mockReturnValue(playing)
      const spy = vi.spyOn(playback, 'togglePlay').mockResolvedValue()
      await handleRemoteCommand(type, {})
      expect(spy).toHaveBeenCalledTimes(calls)
    })

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

  it('queue-move moves a song next or to the end, and refuses what the queue refuses', async () => {
    const playback = usePlaybackStore()
    playback.setQueue(
      ['a', 'b', 'c', 'd'].map((id) => makeSong(id)),
      0,
    )

    await handleRemoteCommand('queue-move', { index: '3', where: 'next' })
    expect(playback.queue.map((song) => song.id)).toEqual(['a', 'd', 'b', 'c'])
    await handleRemoteCommand('queue-move', { index: 1, where: 'end' })
    expect(playback.queue.map((song) => song.id)).toEqual(['a', 'b', 'c', 'd'])

    // The song that is playing stays where it is.
    await expect(handleRemoteCommand('queue-move', { index: 0, where: 'end' })).rejects.toThrow()
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

    it('with several active targets, moves them all through the master volume', async () => {
      const connect = useConnectStore()
      connect.status = makeStatus({
        targets: [
          { name: 'A', type: 'sonos', volume_push: true, volume: 20 },
          { name: 'B', type: 'sonos', volume_push: true, volume: 60 },
        ],
      })
      const setVolumeSpy = vi.spyOn(usePlaybackStore(), 'setVolume')
      const setDeviceVolumeSpy = vi.spyOn(connect, 'setDeviceVolume').mockResolvedValue()
      const reportSpy = vi.spyOn(useRemoteControlStore(), 'reportDeviceVolume')

      await handleRemoteCommand('volume', { volume: 0.5 })

      expect(setVolumeSpy).not.toHaveBeenCalled()
      expect(setDeviceVolumeSpy).toHaveBeenCalledWith('sonos', 'A', 50)
      expect(setDeviceVolumeSpy).toHaveBeenCalledWith('sonos', 'B', 50)
      expect(reportSpy).toHaveBeenCalledWith(50)
    })
  })

  describe('group-volume-mode', () => {
    it("switches how the master moves several speakers from the phone's cast sheet", async () => {
      await handleRemoteCommand('group-volume-mode', { mode: 'relative' })
      expect(useGroupVolumeStore().mode).toBe('relative')

      await handleRemoteCommand('group-volume-mode', { mode: 'equal' })
      expect(useGroupVolumeStore().mode).toBe('equal')
    })

    it('ignores a mode it does not know', async () => {
      useGroupVolumeStore().setMode('relative')

      await handleRemoteCommand('group-volume-mode', { mode: 'loud' })

      expect(useGroupVolumeStore().mode).toBe('relative')
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
      changed: null,
      readonly: false,
      smart: false,
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

  describe('set-favorite', () => {
    it("flips the queue's own song when the phone wants the other state", async () => {
      const playback = usePlaybackStore()
      const library = useLibraryStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite', { songId: 'b', favorite: true })

      expect(toggleFavorite).toHaveBeenCalledWith('song', playback.queue[1])
    })

    /** Set, not toggled: a repeated tap must not take the favourite back. */
    it('leaves a song alone that already is what the phone asks for', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a', { starred: true })], 0)
      const toggleFavorite = vi.spyOn(useLibraryStore(), 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite', { songId: 'a', favorite: true })

      expect(toggleFavorite).not.toHaveBeenCalled()
    })

    it('finds a song outside the queue too', async () => {
      const library = useLibraryStore()
      const song = makeSong('x')
      library.allSongs = [song]
      const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite', { songId: 'x', favorite: true })

      expect(toggleFavorite).toHaveBeenCalledWith('song', song)
    })
  })

  describe('set-favorite-album and -artist', () => {
    it('flips an album from the library cache', async () => {
      const library = useLibraryStore()
      const album = { id: 'al1', name: 'Harbor', starred: false } as never
      library.albums = [album]
      const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite-album', { albumId: 'al1', favorite: true })

      expect(toggleFavorite).toHaveBeenCalledWith('album', album)
    })

    it('leaves an album alone that already is what the phone asks for', async () => {
      const library = useLibraryStore()
      library.albums = [{ id: 'al1', name: 'Harbor', starred: true } as never]
      const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite-album', { albumId: 'al1', favorite: true })

      expect(toggleFavorite).not.toHaveBeenCalled()
    })

    it('flips an artist fetched from the server', async () => {
      const library = useLibraryStore()
      const artist = { id: 'ar1', name: 'The Tide', starred: false }
      vi.spyOn(library, 'client').mockReturnValue(
        fakeClient({ getArtist: vi.fn().mockResolvedValue(artist) }),
      )
      const toggleFavorite = vi.spyOn(library, 'toggleFavorite').mockResolvedValue()

      await handleRemoteCommand('set-favorite-artist', { artistId: 'ar1', favorite: true })

      expect(toggleFavorite).toHaveBeenCalledWith('artist', artist)
    })
  })

  describe('play-favorites', () => {
    function stubFavorites(songs: ReturnType<typeof makeSong>[]) {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
        library.starred = { artists: [], albums: [], songs }
      })
      return vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    }

    it('plays the whole list on from the tapped song', async () => {
      const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
      const playSongList = stubFavorites(songs)

      await handleRemoteCommand('play-favorites', { songId: 'b', startIndex: 1 })

      expect(playSongList).toHaveBeenCalledWith(songs, 1, true, true)
    })

    /** A star added on the desktop after the phone fetched its list moves
     * every song behind it one place down. */
    it('goes by the song when the list has shifted since the phone saw it', async () => {
      const songs = [makeSong('new'), makeSong('a'), makeSong('b')]
      const playSongList = stubFavorites(songs)

      await handleRemoteCommand('play-favorites', { songId: 'b', startIndex: 1 })

      expect(playSongList).toHaveBeenCalledWith(songs, 2, true, true)
    })

    it('plays on in the order and through the filter the phone had on', async () => {
      const songs = [
        makeSong('old', { year: 1971, genre: 'Rock' }),
        makeSong('jazz', { year: 1999, genre: 'Jazz' }),
        makeSong('new', { year: 2021, genre: 'Rock' }),
      ]
      const playSongList = stubFavorites(songs)

      await handleRemoteCommand('play-favorites', {
        songId: 'old',
        startIndex: 1,
        sort: { key: 'year', direction: 'desc' },
        filters: { genre: ['Rock'] },
      })

      expect(playSongList).toHaveBeenCalledWith([songs[2], songs[0]], 1, true, true)
    })

    it('does nothing for a song that is no longer a favourite', async () => {
      const playSongList = stubFavorites([makeSong('a')])

      await handleRemoteCommand('play-favorites', { songId: 'gone', startIndex: 0 })

      expect(playSongList).not.toHaveBeenCalled()
    })
  })

  describe('play-artist-songs', () => {
    function stubTopSongs(songs: ReturnType<typeof makeSong>[]) {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchArtist').mockResolvedValue({ id: 'ar1', albums: [] } as never)
      vi.spyOn(library, 'fetchTopSongsForArtist').mockResolvedValue(songs)
      return vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    }

    it("plays the artist's top songs on from the tapped one", async () => {
      const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
      const playSongList = stubTopSongs(songs)

      await handleRemoteCommand('play-artist-songs', {
        artistId: 'ar1',
        songId: 'b',
        startIndex: 1,
      })

      expect(playSongList).toHaveBeenCalledWith(songs, 1)
    })

    it('goes by the song when the ranking has moved since the phone saw it', async () => {
      const songs = [makeSong('b'), makeSong('a')]
      const playSongList = stubTopSongs(songs)

      await handleRemoteCommand('play-artist-songs', {
        artistId: 'ar1',
        songId: 'b',
        startIndex: 1,
      })

      expect(playSongList).toHaveBeenCalledWith(songs, 0)
    })
  })

  describe('play-album', () => {
    it('plays the album in its own track order', async () => {
      const library = useLibraryStore()
      const playback = usePlaybackStore()
      const songs = [makeSong('x'), makeSong('y')]
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ id: 'al1', songs } as never)
      const playSongList = vi.spyOn(playback, 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-album', { albumId: 'al1' })

      // pinFirst false, natural order — an album is a sequenced work, not a
      // pick made row by row. peek because more than one song lands in the
      // queue and the phone has no drawer of its own to reveal.
      expect(playSongList).toHaveBeenCalledWith(songs, 0, false, true)
    })

    it('does not peek the drawer for a single-track album', async () => {
      const library = useLibraryStore()
      const playback = usePlaybackStore()
      const songs = [makeSong('x')]
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ id: 'al1', songs } as never)
      const playSongList = vi.spyOn(playback, 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-album', { albumId: 'al1' })

      expect(playSongList).toHaveBeenCalledWith(songs, 0, false, false)
    })

    it('starts a track from the album page at the position the phone names', async () => {
      const library = useLibraryStore()
      const playback = usePlaybackStore()
      const songs = [makeSong('x'), makeSong('y'), makeSong('z')]
      vi.spyOn(library, 'fetchAlbum').mockResolvedValue({ id: 'al1', songs } as never)
      const playSongList = vi.spyOn(playback, 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-album', { albumId: 'al1', startIndex: 2 })

      expect(playSongList).toHaveBeenCalledWith(songs, 2, false, true)
    })
  })

  describe('play-songs', () => {
    function stubLibrary() {
      const library = useLibraryStore()
      const songs = [makeSong('a'), makeSong('b'), makeSong('c')]
      library.allSongs = songs
      vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
      return songs
    }

    it('plays the ids the phone showed, from the tapped one, keeping it first', async () => {
      const songs = stubLibrary()
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-songs', {
        songIds: songs.map((song) => song.id),
        startIndex: 1,
      })

      expect(playSongList).toHaveBeenCalledWith(songs, 1, true, true)
    })

    it('plays all in the list\u2019s own order for "play all"', async () => {
      const songs = stubLibrary()
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-songs', {
        songIds: songs.map((song) => song.id),
        startIndex: 0,
        pinFirst: false,
      })

      expect(playSongList).toHaveBeenCalledWith(songs, 0, false, true)
    })

    it('drops an id it can no longer resolve instead of playing an empty list', async () => {
      const songs = stubLibrary()
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-songs', { songIds: ['gone', 'b'], startIndex: 1 })

      expect(playSongList).toHaveBeenCalledWith([songs[1]], 0, true, false)
    })

    it('does nothing when the phone sent no playable songs', async () => {
      stubLibrary()
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()

      await handleRemoteCommand('play-songs', { songIds: ['gone'] })

      expect(playSongList).not.toHaveBeenCalled()
    })
  })

  describe('play-albums', () => {
    it('plays a Home shelf album by album, in the shelf\u2019s own order', async () => {
      const library = useLibraryStore()
      const playSongList = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
      vi.spyOn(library, 'fetchAlbum').mockImplementation(
        async (id: string) => ({ id, songs: [makeSong(`${id}-1`), makeSong(`${id}-2`)] }) as never,
      )

      await handleRemoteCommand('play-albums', { albumIds: ['a1', 'a2'] })

      expect(playSongList).toHaveBeenCalledWith(
        [makeSong('a1-1'), makeSong('a1-2'), makeSong('a2-1'), makeSong('a2-2')],
        0,
        false,
        true,
      )
    })
  })

  describe('equalizer', () => {
    it('sets the curve for the speaker the phone names', async () => {
      const equalizer = useEqualizerStore()
      const setSpeaker = vi.spyOn(equalizer, 'setSpeaker').mockImplementation(() => {})

      await handleRemoteCommand('set-equalizer', {
        target: { type: 'sonos', name: 'Kitchen' },
        setting: { enabled: true, gains: [1, 2] },
      })

      expect(setSpeaker).toHaveBeenCalledWith(
        { type: 'sonos', name: 'Kitchen' },
        expect.objectContaining({ enabled: true, gains: expect.arrayContaining([1, 2]) }),
      )
      const setting = setSpeaker.mock.calls[0]![1]
      expect(setting.gains).toHaveLength(10)
    })

    it('restarts the current song where it is for "apply now"', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      const restart = vi.spyOn(playback, 'startCurrent').mockResolvedValue(false)

      await handleRemoteCommand('equalizer-apply', {})

      expect(restart).toHaveBeenCalledWith(playback.localPosition)
    })

    it('does not restart a radio stream, which is never equalized', async () => {
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example',
        homePageUrl: null,
      }
      const restart = vi.spyOn(playback, 'startCurrent').mockResolvedValue(false)

      await handleRemoteCommand('equalizer-apply', {})

      expect(restart).not.toHaveBeenCalled()
    })
  })

  describe('lights', () => {
    it('pairs the bridge the phone names', async () => {
      const pair = vi.spyOn(useLightsStore(), 'pair').mockResolvedValue()

      await handleRemoteCommand('lights-pair', { host: '192.0.2.10' })

      expect(pair).toHaveBeenCalledWith('192.0.2.10')
    })

    it('forgets the bridge when asked', async () => {
      const forget = vi.spyOn(useLightsStore(), 'forget').mockResolvedValue()

      await handleRemoteCommand('lights-forget', {})

      expect(forget).toHaveBeenCalledOnce()
    })
  })

  describe('party', () => {
    it('party-wish hands the resolved song and the guest to the party store', async () => {
      const library = useLibraryStore()
      const song = makeSong('a')
      library.allSongs = [song]
      const wish = vi.spyOn(usePartyStore(), 'wish').mockImplementation(() => {})

      await handleRemoteCommand('party-wish', {
        songId: 'a',
        guestId: 'g1',
        guestName: 'Anna',
        maxPending: 3,
      })

      expect(wish).toHaveBeenCalledWith(song, 'g1', 'Anna', 3)
    })

    it('party-wish refuses a song that cannot be found, rather than doing nothing', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'client').mockReturnValue(
        fakeClient({ getSong: vi.fn().mockRejectedValue(new Error('404')) }),
      )

      // The guest is waiting on an answer; silence would read as success.
      await expect(handleRemoteCommand('party-wish', { songId: 'ghost' })).rejects.toThrow(
        PartyRefusal,
      )
    })

    it('party-withdraw names the request and the guest asking', async () => {
      const withdraw = vi.spyOn(usePartyStore(), 'withdraw').mockImplementation(() => {})

      await handleRemoteCommand('party-withdraw', { requestId: 'r1', guestId: 'g1' })

      expect(withdraw).toHaveBeenCalledWith('r1', 'g1')
    })
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
      const joinSpy = vi.spyOn(connect, 'joinDevice').mockResolvedValue(true)
      const castSpy = vi.spyOn(usePlaybackStore(), 'castTo').mockResolvedValue()

      await handleRemoteCommand('cast-to-many', {
        targets: [
          { deviceType: 'sonos', name: 'Kitchen' },
          { deviceType: 'sonos', name: 'Living Room' },
        ],
      })

      // force=true reaches the join, not just the fresh-cast path: the
      // phone has no takeover dialog, so a conflict swallowed into
      // pendingTakeover would strand this request on a confirmation the
      // phone can never give.
      expect(joinSpy).toHaveBeenCalledWith({ type: 'sonos', name: 'Living Room' }, true)
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

    it('matches the spelling exactly, since the phone has no room for the switch', async () => {
      const library = useLibraryStore()
      library.allSongs = [makeSong('a', { title: 'Hey Jude', artist: 'The Beatles' })]
      library.allSongsLoaded = true

      const exact = (await resolveRemoteQuery('songs-request', { search: 'beatles' })) as {
        items: { id: string }[]
      }
      const misspelled = (await resolveRemoteQuery('songs-request', { search: 'beattles' })) as {
        items: { id: string }[]
      }

      expect(exact.items.map((s) => s.id)).toEqual(['a'])
      expect(misspelled.items).toEqual([])
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

  describe('browsing the library (the remote library view)', () => {
    type Browse = {
      items: { id: string }[]
      total: number
      sort: { key: string; direction: string }
      sort_options: { value: string; label: string }[]
      sections: { key: string; label: string; short: string; offset: number | null }[]
      filters: Record<string, string[]>
      filter_count: number
      filter_fields: {
        field: string
        label: string
        options: { option: string; count: number }[]
      }[]
    }

    function loadSongs(songs: ReturnType<typeof makeSong>[]) {
      const library = useLibraryStore()
      library.allSongs = songs
      library.allSongsLoaded = true
    }

    const songs = () => [
      makeSong('a', { title: 'Alpha', year: 1985, genre: 'Rock' }),
      makeSong('b', { title: 'Bravo', year: 2003, genre: 'Jazz' }),
      makeSong('c', { title: 'Charlie', year: 1989, genre: 'Rock' }),
    ]

    it('sorts by the order the phone picked and starts a section at each decade', async () => {
      loadSongs(songs())

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        sort: { key: 'year', direction: 'desc' },
        locale: 'en',
      })) as Browse

      expect(result.items.map((s) => s.id)).toEqual(['b', 'c', 'a'])
      expect(result.sort).toEqual({ key: 'year', direction: 'desc' })
      expect(result.sections.map(({ key, offset }) => [key, offset])).toEqual([
        ['2000', 0],
        ['1980', 1],
      ])
    })

    it("labels the sections in the phone's language, not the desktop's", async () => {
      loadSongs(songs())
      const request = (locale: string) =>
        resolveRemoteQuery('songs-request', {
          browse: true,
          sort: { key: 'year', direction: 'desc' },
          locale,
        }) as Promise<Browse>

      const [en, de] = await Promise.all([request('en'), request('de')])

      expect(en.sections[0]!.label).toBe('2000s')
      expect(de.sections[0]!.label).toBe('2000er')
      expect(de.sort_options.find((o) => o.value === 'title')?.label).not.toBe(
        en.sort_options.find((o) => o.value === 'title')?.label,
      )
    })

    it('filters the list, keeps every section and counts options over the whole half', async () => {
      loadSongs(songs())

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        sort: { key: 'year', direction: 'desc' },
        filters: { genre: ['Rock'], nonsense: ['x'], year: 'not a list' },
      })) as Browse

      expect(result.items.map((s) => s.id)).toEqual(['c', 'a'])
      expect(result.total).toBe(2)
      expect(result.filters).toEqual({ genre: ['Rock'] })
      expect(result.filter_count).toBe(1)
      expect(result.sections.find((s) => s.key === '2000')?.offset).toBeNull()
      const genre = result.filter_fields.find((f) => f.field === 'genre')
      expect(genre?.options).toEqual([
        expect.objectContaining({ option: 'Rock', count: 2 }),
        expect.objectContaining({ option: 'Jazz', count: 1 }),
      ])
    })

    it('without an order of its own, browses by the one this desktop last used', async () => {
      loadSongs(songs())
      saveSongSort({ key: 'title', direction: 'desc' })

      const result = (await resolveRemoteQuery('songs-request', { browse: true })) as Browse

      expect(result.sort).toEqual({ key: 'title', direction: 'desc' })
      expect(result.items.map((s) => s.id)).toEqual(['c', 'b', 'a'])
    })

    it('starts a newly picked order the way the app does: years newest first', async () => {
      loadSongs(songs())

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        sort: { key: 'year', direction: '' },
      })) as Browse

      expect(result.sort).toEqual({ key: 'year', direction: 'desc' })
    })

    it('reads an order this server has nothing for as the title', async () => {
      loadSongs(songs())

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        sort: { key: 'bogus', direction: 'desc' },
      })) as Browse

      expect(result.sort).toEqual({ key: 'title', direction: 'asc' })
    })

    it('browses the favourites with the heart on', async () => {
      const library = useLibraryStore()
      loadSongs(songs())
      vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
        library.starred = { artists: [], albums: [], songs: [makeSong('fav', { title: 'Zulu' })] }
      })

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        favorites: true,
      })) as Browse

      expect(result.items.map((s) => s.id)).toEqual(['fav'])
    })

    it('pages the sorted list', async () => {
      loadSongs(songs())

      const result = (await resolveRemoteQuery('songs-request', {
        browse: true,
        sort: { key: 'title', direction: 'asc' },
        offset: 1,
        limit: 1,
      })) as Browse

      expect(result.items.map((s) => s.id)).toEqual(['b'])
      expect(result.total).toBe(3)
    })
  })

  describe('search-request', () => {
    function loadLibrary() {
      const library = useLibraryStore()
      library.allSongs = [
        makeSong('s1', { title: 'Moonlight', artist: 'Someone' }),
        makeSong('s2', { title: 'Blue Moon', artist: 'Someone' }),
        makeSong('s3', { title: 'Sunrise', artist: 'Someone' }),
      ]
      library.allSongsLoaded = true
      library.albums = [{ id: 'al1', name: 'Moon Safari', artist: 'Air' }] as never
      library.artists = [{ id: 'ar1', name: 'Moonlight Trio', albumCount: 1 }] as Artist[]
      library.playlists = [{ id: 'p1', name: 'Other' }] as Playlist[]
      library.radioStations = [{ id: 'r1', name: 'Radio Other' }] as RadioStation[]
    }

    it('answers every kind that matches, without fetching what is already loaded', async () => {
      loadLibrary()
      const library = useLibraryStore()
      const fetchAll = vi.spyOn(library, 'fetchAllSongs')

      const result = (await resolveRemoteQuery('search-request', { q: 'moon' })) as {
        sections: { kind: string; items: { id: string }[]; total: number }[]
      }

      expect(fetchAll).not.toHaveBeenCalled()
      expect(result.sections.map((s) => s.kind).sort()).toEqual(['albums', 'artists', 'songs'])
      expect(result.sections.find((s) => s.kind === 'songs')?.total).toBe(2)
    })

    it("pages one kind's every match for its show all", async () => {
      loadLibrary()

      const result = (await resolveRemoteQuery('search-request', {
        q: 'moon',
        kind: 'songs',
        offset: 1,
        limit: 5,
      })) as { items: { id: string }[]; total: number }

      expect(result.total).toBe(2)
      expect(result.items).toHaveLength(1)
    })

    it('answers nothing for an empty query', async () => {
      loadLibrary()

      expect(await resolveRemoteQuery('search-request', { q: '  ' })).toEqual({ sections: [] })
    })
  })

  describe('albums-request', () => {
    function makeAlbum(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        name: `Album ${id}`,
        artist: 'Nobody',
        artistId: 'ar',
        coverArtId: null,
        songCount: 2,
        duration: 300,
        year: 1999,
        genre: null,
        starred: false,
        rating: 0,
        songs: [],
        ...overrides,
      }
    }

    it('fetches the catalog once, filters across name and artist, and paginates', async () => {
      const library = useLibraryStore()
      const albums = [
        makeAlbum('a', { name: 'Harbor Lights' }),
        makeAlbum('b', { name: 'Other', artist: 'The Tide' }),
        makeAlbum('c', { name: 'Unrelated' }),
      ]
      const fetchSpy = vi.spyOn(library, 'fetchAlbums').mockImplementation(async () => {
        library.albums = albums as never
      })

      const result = (await resolveRemoteQuery('albums-request', { search: 'tide' })) as {
        items: { id: string }[]
        total: number
      }

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(result.items).toEqual([expect.objectContaining({ id: 'b' })])
      expect(result.total).toBe(1)
    })

    it('does not re-fetch once the catalog is already loaded', async () => {
      const library = useLibraryStore()
      library.albums = [makeAlbum('a')] as never
      const fetchSpy = vi.spyOn(library, 'fetchAlbums')

      await resolveRemoteQuery('albums-request', {})

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('sends what a row and the album page need', async () => {
      const library = useLibraryStore()
      library.albums = [makeAlbum('a', { name: 'Harbor Lights', artist: 'The Tide' })] as never

      const result = (await resolveRemoteQuery('albums-request', {})) as {
        items: Record<string, unknown>[]
      }

      expect(result.items[0]).toEqual({
        id: 'a',
        name: 'Harbor Lights',
        artist: 'The Tide',
        artist_id: 'ar',
        year: 1999,
        starred: false,
        cover_art_url: null,
        cover_art_id: null,
      })
    })

    it('slices by offset/limit', async () => {
      const library = useLibraryStore()
      library.albums = Array.from({ length: 5 }, (_, i) => makeAlbum(`al${i}`)) as never

      const result = (await resolveRemoteQuery('albums-request', { offset: 2, limit: 2 })) as {
        items: { id: string }[]
        total: number
      }

      expect(result.items.map((a) => a.id)).toEqual(['al2', 'al3'])
      expect(result.total).toBe(5)
    })
  })

  it('playlists-request maps each playlist, including what its section and row need', async () => {
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
        changed: null,
        readonly: false,
        smart: false,
        songs: [],
      },
    ]
    vi.spyOn(library, 'fetchPlaylists').mockResolvedValue()

    const result = await resolveRemoteQuery('playlists-request', {})

    expect(result).toEqual({
      // The phone groups them into "mine / shared by me / shared with me"
      // next to the signed-in account's name, as the app's own page does.
      username: '',
      items: [
        {
          id: 'p1',
          name: 'Chill',
          song_count: 3,
          duration: 100,
          owner: 'me',
          public: false,
          smart: false,
          owned_by_user: null,
          changed: null,
          comment: null,
          cover_art_url: null,
          cover_art_id: null,
        },
      ],
    })
  })

  describe('home-request', () => {
    function makeAlbum(id: string) {
      return {
        id,
        name: `Album ${id}`,
        artist: 'Nobody',
        artistId: 'ar',
        coverArtId: null,
        songCount: 1,
        duration: 1,
        year: 2000,
        genre: null,
        starred: false,
        rating: 0,
        songs: [],
      }
    }

    it('answers all five shelves in one query', async () => {
      const library = useLibraryStore()
      const recent = [makeAlbum('recent')]
      const newest = [makeAlbum('newest')]
      const discover = [makeAlbum('discover')]
      const rediscover = [makeSong('rediscover')]
      library.allSongs = [makeSong('top', { playCount: 9 })]
      vi.spyOn(library, 'fetchRecentlyPlayedAlbums').mockResolvedValue(recent as never)
      vi.spyOn(library, 'fetchRandomAlbums').mockResolvedValue(discover as never)
      vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
      vi.spyOn(library, 'fetchRediscoverSongs').mockResolvedValue(rediscover)
      vi.spyOn(library, 'client').mockReturnValue(
        fakeClient({ getAlbumList2: vi.fn().mockResolvedValue(newest) }),
      )

      const result = (await resolveRemoteQuery('home-request', {})) as {
        recent: { id: string }[]
        newest: { id: string }[]
        discover: { id: string }[]
        top_songs: { id: string }[]
        rediscover: { id: string }[]
      }

      expect(result.recent.map((album) => album.id)).toEqual(['recent'])
      expect(result.newest.map((album) => album.id)).toEqual(['newest'])
      expect(result.discover.map((album) => album.id)).toEqual(['discover'])
      expect(result.top_songs.map((song) => song.id)).toEqual(['top'])
      expect(result.rediscover.map((song) => song.id)).toEqual(['rediscover'])
    })

    it('draws a fresh Discover shelf without replacing the others', async () => {
      const library = useLibraryStore()
      const fetchSpy = vi
        .spyOn(library, 'fetchRandomAlbums')
        .mockResolvedValue([makeAlbum('fresh')] as never)

      const result = (await resolveRemoteQuery('discover-request', {})) as {
        items: { id: string }[]
      }

      expect(fetchSpy).toHaveBeenCalledWith(15)
      expect(result.items.map((album) => album.id)).toEqual(['fresh'])
    })

    it('keeps the shelves that answered when one of them fails', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchRecentlyPlayedAlbums').mockRejectedValue(new Error('offline'))
      vi.spyOn(library, 'fetchRandomAlbums').mockResolvedValue([makeAlbum('discover')] as never)
      vi.spyOn(library, 'fetchAllSongs').mockResolvedValue()
      vi.spyOn(library, 'fetchRediscoverSongs').mockResolvedValue([])
      vi.spyOn(library, 'client').mockReturnValue(
        fakeClient({ getAlbumList2: vi.fn().mockResolvedValue([makeAlbum('newest')]) }),
      )

      const result = (await resolveRemoteQuery('home-request', {})) as {
        recent: unknown[]
        newest: { id: string }[]
        discover: { id: string }[]
      }

      expect(result.recent).toEqual([])
      expect(result.newest.map((album) => album.id)).toEqual(['newest'])
      expect(result.discover.map((album) => album.id)).toEqual(['discover'])
    })
  })

  describe('backdrop-request', () => {
    it('answers null when Fanart.tv is switched off', async () => {
      const library = useLibraryStore()
      library.allSongs = [makeSong('a')]
      useFanartStore().enabled = false

      const result = await resolveRemoteQuery('backdrop-request', { songId: 'a' })

      expect(result).toEqual({ source: null, backgrounds: [], is_artist: false })
    })
  })

  describe('lyrics-request', () => {
    it('returns the lyrics already loaded for the song, with their offset', async () => {
      const library = useLibraryStore()
      library.allSongs = [makeSong('a')]
      const lyrics = useLyricsStore()
      lyrics.songId = 'a'
      lyrics.synced = true
      lyrics.lines = [{ time: 1, text: 'Hello' }]
      lyrics.credits = ['Written by Someone']
      lyrics.offset = 0.4
      lyrics.loading = false
      lyrics.error = false

      const result = (await resolveRemoteQuery('lyrics-request', { songId: 'a' })) as {
        song_id: string
        synced: boolean
        lines: { time: number; text: string }[]
        credits: string[]
        offset: number
        loading: boolean
      }

      expect(result.song_id).toBe('a')
      expect(result.synced).toBe(true)
      expect(result.lines).toEqual([{ time: 1, text: 'Hello' }])
      expect(result.credits).toEqual(['Written by Someone'])
      expect(result.offset).toBe(0.4)
      expect(result.loading).toBe(false)
    })

    it('answers "still loading" instead of the previous song\u2019s lines', async () => {
      const library = useLibraryStore()
      library.allSongs = [makeSong('b')]
      const lyrics = useLyricsStore()
      lyrics.songId = 'a'
      lyrics.lines = [{ time: 0, text: 'Old song' }]
      lyrics.loading = false
      vi.spyOn(lyrics, 'ensureLoaded').mockResolvedValue()

      const result = (await resolveRemoteQuery('lyrics-request', { songId: 'b' })) as {
        lines: unknown[]
        loading: boolean
      }

      expect(result.lines).toEqual([])
      expect(result.loading).toBe(true)
    })
  })

  describe('equalizer-request', () => {
    it('returns the cast targets, their curves and the presets', async () => {
      const connect = useConnectStore()
      vi.spyOn(connect, 'activeTargets', 'get').mockReturnValue([
        { type: 'sonos', name: 'Kitchen' },
      ] as never)
      const equalizer = useEqualizerStore()
      const gains = [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]
      equalizer.speakers['sonos:Kitchen'] = { enabled: true, gains }
      equalizer.presets = [{ name: 'Mine', gains }]

      const result = (await resolveRemoteQuery('equalizer-request', {})) as {
        targets: { type: string; name: string }[]
        settings: Record<string, { enabled: boolean; gains: number[] }>
        presets: { name: string }[]
        built_in: { name: string; gains: number[] }[]
      }

      expect(result.targets).toEqual([{ type: 'sonos', name: 'Kitchen' }])
      expect(result.settings['sonos:Kitchen']!.gains).toEqual(gains)
      expect(result.presets.map((preset) => preset.name)).toEqual(['Mine'])
      expect(result.built_in.find((preset) => preset.name === 'bass')!.gains).toEqual([
        6, 5, 4, 2, 0, 0, 0, 0, 0, 0,
      ])
    })
  })

  describe('lights-update-request', () => {
    it('applies the setting through the store and answers with the new state', async () => {
      const lights = useLightsStore()
      const update = vi.spyOn(lights, 'update').mockImplementation(async (next) => {
        lights.lights = { ...(lights.lights ?? ({} as never)), ...next }
      })
      lights.lights = {
        paired: true,
        enabled: false,
        area_id: 'area-1',
      } as never

      const result = (await resolveRemoteQuery('lights-update-request', {
        update: { enabled: true },
      })) as { enabled: boolean }

      expect(update).toHaveBeenCalledWith({ enabled: true })
      expect(result.enabled).toBe(true)
    })
  })

  describe('artists-request', () => {
    it('fetches the artists once, filters by name and pages them', async () => {
      const library = useLibraryStore()
      const fetchSpy = vi.spyOn(library, 'fetchArtists').mockImplementation(async () => {
        library.artists = [
          { id: 'a', name: 'The Tide', albumCount: 2, coverArtId: 'ar-a' },
          { id: 'b', name: 'Harbor', albumCount: 1, coverArtId: null },
        ] as Artist[]
      })

      const result = (await resolveRemoteQuery('artists-request', { search: 'tide' })) as {
        items: Record<string, unknown>[]
        total: number
      }

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(result.total).toBe(1)
      expect(result.items[0]).toEqual({
        id: 'a',
        name: 'The Tide',
        album_count: 2,
        cover_art_url: expect.stringContaining('/remote/cover-art?id=ar-a'),
        cover_art_id: 'ar-a',
      })
    })
  })

  describe('artist-request', () => {
    it('sends the artist, their top songs and their albums newest first', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchArtist').mockResolvedValue({
        id: 'ar1',
        name: 'The Tide',
        albumCount: 3,
        coverArtId: null,
        albums: [
          { id: 'old', year: 1990 },
          { id: 'undated', year: null },
          { id: 'new', year: 2020 },
        ],
      } as never)
      vi.spyOn(library, 'fetchTopSongsForArtist').mockResolvedValue([makeSong('s1')])

      const result = (await resolveRemoteQuery('artist-request', { artistId: 'ar1' })) as {
        artist: { id: string }
        songs: { id: string }[]
        albums: { id: string }[]
      }

      expect(result.artist.id).toBe('ar1')
      expect(result.songs.map((s) => s.id)).toEqual(['s1'])
      expect(result.albums.map((a) => a.id)).toEqual(['new', 'old', 'undated'])
    })

    it('answers with no artist when it cannot be loaded', async () => {
      vi.spyOn(useLibraryStore(), 'fetchArtist').mockRejectedValue(new Error('gone'))

      const result = await resolveRemoteQuery('artist-request', { artistId: 'ar1' })

      expect(result).toEqual({ artist: null, songs: [], albums: [] })
    })
  })

  describe('favorites-request', () => {
    it('sends the favourite artists too', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
        library.starred = {
          artists: [{ id: 'ar1', name: 'The Tide', albumCount: 1, coverArtId: null } as Artist],
          albums: [],
          songs: [],
        }
      })

      const result = (await resolveRemoteQuery('favorites-request', {})) as {
        artists: { id: string }[]
      }

      expect(result.artists.map((a) => a.id)).toEqual(['ar1'])
    })

    it('sends the favourite songs and albums', async () => {
      const library = useLibraryStore()
      vi.spyOn(library, 'fetchStarred').mockImplementation(async () => {
        library.starred = {
          artists: [],
          albums: [{ id: 'al1', name: 'Blue', artist: 'X', year: 1999, coverArtId: null } as never],
          songs: [makeSong('a')],
        }
      })

      const result = (await resolveRemoteQuery('favorites-request', {})) as {
        songs: { id: string }[]
        albums: { id: string }[]
      }

      expect(result.songs.map((s) => s.id)).toEqual(['a'])
      expect(result.albums.map((a) => a.id)).toEqual(['al1'])
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
      changed: null,
      readonly: false,
      smart: false,
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
    // No homepage and no favicon hint — there is genuinely nothing to
    // resolve a logo from, so the phone draws its fallback icon.
    expect(result).toEqual({
      items: [
        {
          id: 's1',
          name: 'Chill FM',
          favicon_url: null,
          home_page_url: null,
          favicon_hint: null,
        },
      ],
    })
  })

  // An integration cannot use the phone's favicon_url (it carries the phone
  // password), so it gets what that URL is built from.
  it('radio-request passes on what a station logo is resolved from', async () => {
    const library = useLibraryStore()
    library.radioStations = [
      {
        id: 's1',
        name: 'Chill FM',
        streamUrl: 'https://stream.example',
        homePageUrl: 'https://chill.example',
        favicon: 'https://chill.example/logo.png',
      },
    ]

    const result = (await resolveRemoteQuery('radio-request', {})) as {
      items: Record<string, unknown>[]
    }

    expect(result.items[0]).toMatchObject({
      home_page_url: 'https://chill.example',
      favicon_hint: 'https://chill.example/logo.png',
    })
  })

  /** Opening the sheet takes the last sweep's result; its rescan button
   * asks for a real one, which costs seconds. Two different calls, so a
   * phone opening the picker does not pay for a sweep it did not ask
   * for. */
  it('devices-request only sweeps for real when the phone asks it to', async () => {
    const connect = useConnectStore()
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    connect.devices = { sonos: [], airplay: [], chromecast: [], dlna: [] }

    await resolveRemoteQuery('devices-request', {})
    expect(refreshSpy).toHaveBeenLastCalledWith(false)

    await resolveRemoteQuery('devices-request', { rescan: true })
    expect(refreshSpy).toHaveBeenLastCalledWith(true)
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
    // Sorted alphabetically within Sonos.
    expect(result.items[0]).toMatchObject({ type: 'sonos', volume_capable: true })
    // needs_pairing travels through instead of being filtered out (see the
    // function's own comment on why: the phone shows it greyed out with a
    // hint, rather than the device silently never appearing at all).
    expect(result.items.find((d) => d.name === 'Speaker')).toMatchObject({
      type: 'airplay',
      volume_capable: true,
      needs_pairing: true,
    })
    expect(result.items.find((d) => d.name === 'Renderer')).toMatchObject({
      type: 'dlna',
      in_use_by_name: 'Someone',
    })
  })

  /** The sheet offers "Take over" only for a speaker somebody else holds -
   * one this window holds itself is just playing. */
  it('devices-request tells a speaker held elsewhere apart from one held here', async () => {
    const connect = useConnectStore()
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    useAuthStore().sessionId = 'mine'
    connect.devices = {
      sonos: [
        { name: 'Held here', in_use_by_session_id: 'mine', in_use_by_name: 'Me' },
        {
          name: 'Held elsewhere',
          in_use_by_session_id: 'theirs',
          in_use_by_name: 'Anna',
          in_use_by_song: 'One More Time',
        },
        { name: 'Free' },
      ],
      airplay: [],
      chromecast: [],
      dlna: [],
    }

    const result = (await resolveRemoteQuery('devices-request', {})) as {
      items: Record<string, unknown>[]
    }
    const byName = Object.fromEntries(result.items.map((d) => [d.name, d]))

    expect(byName['Held here']).toMatchObject({ claimed: false })
    expect(byName['Held elsewhere']).toMatchObject({
      claimed: true,
      in_use_by_song: 'One More Time',
    })
    expect(byName['Free']).toMatchObject({ claimed: false })
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
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // This app's copy of the phone password is gone after every reload, while
  // the paired phone's stays valid - a URL that needed it went null then,
  // and every cover on the phone turned into a placeholder.
  it('builds cover URLs without the phone password, so a reload cannot take them away', () => {
    useAuthStore().sessionId = 'sess-1'

    const remote = toRemoteSong(makeSong('a', { coverArtId: 'cover1' }))

    expect(useRemoteControlStore().password).toBeNull()
    expect(remote.cover_art_url).toBe('/remote/cover-art?id=cover1&session=sess-1')
  })

  it('never puts the password in a cover URL, even while this app knows it', () => {
    useRemoteControlStore().password = 'secret'

    expect(toRemoteSong(makeSong('a', { coverArtId: 'cover1' })).cover_art_url).not.toContain(
      'secret',
    )
  })

  it('toRemoteSong carries the bare cover id for an integration', () => {
    expect(toRemoteSong(makeSong('a', { coverArtId: 'cover1' })).cover_art_id).toBe('cover1')
  })

  it('remoteRadioFaviconUrl is null with nothing to resolve from, and only adds min_size when given a positive one', () => {
    expect(remoteRadioFaviconUrl(null)).toBeNull()
    expect(remoteRadioFaviconUrl('https://station.example')).toBe(
      `/remote/radio-favicon?url=${encodeURIComponent(
        'https://station.example',
      )}&v=${RADIO_FAVICON_CACHE_VERSION}`,
    )
    // Rounded up to the shared size step, so the phone reuses the answer the
    // desktop's own list row already had the backend resolve.
    expect(remoteRadioFaviconUrl('https://station.example', 32)).toContain('min_size=64')
  })

  it('remoteRadioFaviconUrl passes the station hint along, and works on the hint alone', () => {
    // A station played straight out of the discover dialog has no homepage
    // at all, only Radio Browser's own favicon URL — the desktop resolves
    // those from the hint (see radioFaviconRequest) and the phone used to
    // send neither, which is why it showed a fallback icon for them.
    const fromHintOnly = remoteRadioFaviconUrl(null, 0, 'https://cdn.example/logo.png')
    expect(fromHintOnly).toContain(`hint=${encodeURIComponent('https://cdn.example/logo.png')}`)
    expect(fromHintOnly).toContain('url=&')

    expect(
      remoteRadioFaviconUrl('https://station.example', 0, 'https://cdn.example/l.png'),
    ).toContain(`hint=${encodeURIComponent('https://cdn.example/l.png')}`)
  })
})
