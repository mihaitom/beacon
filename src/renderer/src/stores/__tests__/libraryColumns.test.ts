import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { sanitizeColumns, useLibraryColumnsStore } from '../libraryColumns'
import { DEFAULT_ALBUM_COLUMNS } from '@/services/library/albumColumns'
import { DEFAULT_ARTIST_COLUMNS } from '@/services/library/artistColumns'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('libraryColumns store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('starts each list on its defaults', () => {
    const store = useLibraryColumnsStore()
    expect(store.album).toEqual(DEFAULT_ALBUM_COLUMNS)
    expect(store.artist).toEqual(DEFAULT_ARTIST_COLUMNS)
  })

  it('toggles one list without touching the other, and remembers it', async () => {
    const store = useLibraryColumnsStore()

    store.toggle('album', 'releaseType')
    store.toggle('album', 'genre')

    expect(store.album).toContain('releaseType')
    expect(store.album).not.toContain('genre')
    expect(store.artist).toEqual(DEFAULT_ARTIST_COLUMNS)

    setActivePinia(createPinia())
    expect(useLibraryColumnsStore().album).toEqual(store.album)
  })

  it('syncs the choice with the account', async () => {
    useLibraryColumnsStore().toggle('artist', 'rating')
    await vi.waitFor(() => expect(pushAccountSettings).toHaveBeenCalled())

    expect(pushAccountSettings).toHaveBeenCalledWith({
      artistColumns: DEFAULT_ARTIST_COLUMNS.filter((key) => key !== 'rating'),
    })
  })

  it('ignores a column it does not know', () => {
    const store = useLibraryColumnsStore()
    store.toggle('artist', 'releaseType')
    expect(store.artist).toEqual(DEFAULT_ARTIST_COLUMNS)
    expect(sanitizeColumns('album', ['year', 'bogus', 'year', 3])).toEqual(['year'])
  })

  it('goes back to the defaults on reset', () => {
    const store = useLibraryColumnsStore()
    store.setColumns('album', [])
    expect(store.album).toEqual([])

    store.reset('album')
    expect(store.album).toEqual(DEFAULT_ALBUM_COLUMNS)
  })
})
