import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import {
  availableSegments,
  inSegment,
  loadPlaylistSort,
  savePlaylistSort,
  sortPlaylists,
} from '../playlistBrowse'
import type { Playlist } from '@/types/library'

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: id,
    songCount: 1,
    duration: 60,
    coverArtId: null,
    public: false,
    owner: 'me',
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
    ...overrides,
  }
}

const ids = (playlists: Playlist[]) => playlists.map((playlist) => playlist.id)

describe('sortPlaylists', () => {
  it('sorts by each figure in the direction asked for', () => {
    const list = [
      makePlaylist('short', { songCount: 3, duration: 100 }),
      makePlaylist('long', { songCount: 2, duration: 900 }),
    ]

    expect(ids(sortPlaylists(list, { key: 'songCount', direction: 'desc' }))).toEqual([
      'short',
      'long',
    ])
    expect(ids(sortPlaylists(list, { key: 'duration', direction: 'desc' }))).toEqual([
      'long',
      'short',
    ])
    expect(ids(sortPlaylists(list, { key: 'duration', direction: 'asc' }))).toEqual([
      'short',
      'long',
    ])
  })

  it('compares names the way people read them', () => {
    const list = [makePlaylist('Mix 10'), makePlaylist('mix 2'), makePlaylist('Ärger')]

    expect(ids(sortPlaylists(list, { key: 'name', direction: 'asc' }))).toEqual([
      'Ärger',
      'mix 2',
      'Mix 10',
    ])
  })

  it('puts a playlist without a usable date last, whichever way round', () => {
    const list = [
      makePlaylist('none'),
      makePlaylist('broken', { changed: 'not a date' }),
      makePlaylist('old', { changed: '2026-01-01T00:00:00Z' }),
      makePlaylist('new', { changed: '2026-06-01T00:00:00Z' }),
    ]

    expect(ids(sortPlaylists(list, { key: 'changed', direction: 'desc' }))).toEqual([
      'new',
      'old',
      'broken',
      'none',
    ])
    expect(ids(sortPlaylists(list, { key: 'changed', direction: 'asc' }))).toEqual([
      'old',
      'new',
      'broken',
      'none',
    ])
  })

  it('breaks a tie by name and leaves the original list alone', () => {
    const list = [makePlaylist('b'), makePlaylist('a')]

    expect(ids(sortPlaylists(list, { key: 'songCount', direction: 'desc' }))).toEqual(['a', 'b'])
    expect(ids(list)).toEqual(['b', 'a'])
  })
})

describe('segments', () => {
  it('files a playlist by what the server says about ownership', () => {
    const bridged = makePlaylist('x', { owner: '', ownedByUser: true })
    const other = makePlaylist('y', { owner: 'anna' })

    expect(inSegment(bridged, 'mine', 'me')).toBe(true)
    expect(inSegment(bridged, 'shared', 'me')).toBe(false)
    expect(inSegment(other, 'mine', 'me')).toBe(false)
    expect(inSegment(other, 'shared', 'me')).toBe(true)
  })

  it('counts a smart playlist from someone else as smart too', () => {
    expect(inSegment(makePlaylist('x', { owner: 'anna', smart: true }), 'smart', 'me')).toBe(true)
    expect(inSegment(makePlaylist('y'), 'smart', 'me')).toBe(false)
  })

  it('only offers the groups that have something in them', () => {
    expect(availableSegments([makePlaylist('a')], 'me')).toEqual([])
    expect(availableSegments([makePlaylist('a', { smart: true })], 'me')).toEqual([
      'all',
      'mine',
      'smart',
    ])
    expect(availableSegments([makePlaylist('a', { owner: 'anna' })], 'me')).toEqual([
      'all',
      'mine',
      'shared',
    ])
  })
})

describe('the remembered order', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts on the most recently edited', () => {
    expect(loadPlaylistSort()).toEqual({ key: 'changed', direction: 'desc' })
  })

  it('reads back what was saved', () => {
    savePlaylistSort({ key: 'name', direction: 'desc' })

    expect(loadPlaylistSort()).toEqual({ key: 'name', direction: 'desc' })
  })

  it('ignores a stored value it does not know', () => {
    localStorage.setItem(
      accountScopedKey('beacon.playlistSort'),
      JSON.stringify({ key: 'nope', direction: 'asc' }),
    )

    expect(loadPlaylistSort()).toEqual({ key: 'changed', direction: 'desc' })
  })
})
