import { describe, expect, it } from 'vitest'
import { canManagePlaylist, isOwnedBy } from '../playlistOwnership'
import type { Playlist } from '@/types/library'

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'p1',
    name: 'Mix',
    songCount: 0,
    duration: 0,
    coverArtId: null,
    public: false,
    owner: '',
    changed: null,
    readonly: false,
    smart: false,
    songs: [],
    ...overrides,
  }
}

describe('isOwnedBy', () => {
  it('compares the owner name where that is all the server sends', () => {
    expect(isOwnedBy(makePlaylist({ owner: 'thomas' }), 'thomas')).toBe(true)
    expect(isOwnedBy(makePlaylist({ owner: 'anna' }), 'thomas')).toBe(false)
  })

  it('takes the bridge at its word when it says, whatever the names', () => {
    // Plex names no owner, and the login may not even know the user's name.
    expect(isOwnedBy(makePlaylist({ ownedByUser: true }), '')).toBe(true)
    // Someone else's playlist shared on Jellyfin, also without a name.
    expect(isOwnedBy(makePlaylist({ ownedByUser: false }), '')).toBe(false)
  })
})

describe('canManagePlaylist', () => {
  const owned = (owner: string) => ({ owner }) as Playlist

  it('lets the owner manage their own', () => {
    expect(canManagePlaylist(owned('me'), 'me', { playlistAdmin: false })).toBe(true)
  })

  it("keeps someone else out of another person's", () => {
    expect(canManagePlaylist(owned('anna'), 'me', { playlistAdmin: false })).toBe(false)
  })

  it("lets a Navidrome admin manage anyone's", () => {
    expect(canManagePlaylist(owned('anna'), 'me', { playlistAdmin: true })).toBe(true)
  })
})
