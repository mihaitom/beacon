import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { HOME_TOP_SONGS, useLibraryStore } from '../library'
import { makeSong } from './fixtures'

function ids(songs: { id: string }[]): string[] {
  return songs.map((song) => song.id)
}

describe('library mostPlayedSongs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('ranks the catalogue by plays, most first', () => {
    const library = useLibraryStore()
    library.allSongs = [
      makeSong('a', { playCount: 3 }),
      makeSong('b', { playCount: 9 }),
      makeSong('c', { playCount: 5 }),
    ]

    expect(ids(library.mostPlayedSongs)).toEqual(['b', 'c', 'a'])
  })

  it('leaves out songs that were never played', () => {
    const library = useLibraryStore()
    library.allSongs = [makeSong('heard', { playCount: 1 }), makeSong('unheard')]

    expect(ids(library.mostPlayedSongs)).toEqual(['heard'])
  })

  it('stops at what Home has room for', () => {
    const library = useLibraryStore()
    library.allSongs = Array.from({ length: HOME_TOP_SONGS + 5 }, (_, i) =>
      makeSong(`s${i}`, { playCount: i + 1 }),
    )

    expect(library.mostPlayedSongs).toHaveLength(HOME_TOP_SONGS)
    expect(library.mostPlayedSongs[0]!.id).toBe(`s${HOME_TOP_SONGS + 4}`)
  })

  it('moves a song up as soon as a play of it is counted', () => {
    const library = useLibraryStore()
    library.allSongs = [makeSong('a', { playCount: 2 }), makeSong('b', { playCount: 2 })]
    expect(ids(library.mostPlayedSongs)).toEqual(['a', 'b'])

    library.notePlayed(library.allSongs[1]!)

    expect(ids(library.mostPlayedSongs)).toEqual(['b', 'a'])
  })

  it('leaves the catalogue in its own order', () => {
    const library = useLibraryStore()
    library.allSongs = [makeSong('a', { playCount: 1 }), makeSong('b', { playCount: 7 })]

    void library.mostPlayedSongs

    expect(ids(library.allSongs)).toEqual(['a', 'b'])
  })
})
