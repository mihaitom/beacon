import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSongColumnsStore } from '../songColumns'
import { DEFAULT_SONG_COLUMNS } from '@/services/library/songColumns'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

const KEY = 'beacon.song-columns'

describe('songColumns store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('starts on the set the views used to hard-code between them', () => {
    expect(useSongColumnsStore().columns).toEqual(DEFAULT_SONG_COLUMNS)
  })

  it('toggles a column on and off, persisting each time', () => {
    const store = useSongColumnsStore()

    store.toggle('bpm')
    expect(store.columns).toContain('bpm')

    store.toggle('bpm')
    expect(store.columns).not.toContain('bpm')
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).not.toContain('bpm')
  })

  it('keeps an empty selection rather than falling back to the defaults', () => {
    // Every optional column off is a deliberate table - title, time,
    // rating - not a cleared setting.
    const store = useSongColumnsStore()

    store.setColumns([])
    store.reloadForAccount()

    expect(store.columns).toEqual([])
  })

  it('drops a column this build does not have, and never stores it twice', () => {
    localStorage.setItem(KEY, JSON.stringify(['album', 'album', 'warpFactor']))
    const store = useSongColumnsStore()

    store.reloadForAccount()

    expect(store.columns).toEqual(['album'])
  })

  it('falls back to the defaults for storage holding something else entirely', () => {
    localStorage.setItem(KEY, 'not json')
    const store = useSongColumnsStore()

    store.reloadForAccount()

    expect(store.columns).toEqual(DEFAULT_SONG_COLUMNS)
  })

  it("refuses a structural column - those are not the menu's to switch off", () => {
    const store = useSongColumnsStore()

    // A real column key, just not one the menu offers - nothing in the UI
    // asks for this, which is exactly why the store has to answer it.
    store.toggle('title')

    expect(store.columns).toEqual(DEFAULT_SONG_COLUMNS)
  })

  it('reset goes back to the default set', () => {
    const store = useSongColumnsStore()
    store.setColumns(['path'])

    store.reset()

    expect(store.columns).toEqual(DEFAULT_SONG_COLUMNS)
  })

  it('pushes the selection to the account sync', async () => {
    const store = useSongColumnsStore()

    store.setColumns(['album', 'bpm'])

    // Through a dynamic import (see the store's own comment on the circular
    // import that forces it), so it lands a microtask later.
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ songColumns: ['album', 'bpm'] }),
    )
  })

  it('a push failure does not throw back at the caller', async () => {
    vi.mocked(pushAccountSettings).mockRejectedValueOnce(new Error('network down'))
    const store = useSongColumnsStore()

    expect(() => store.toggle('bpm')).not.toThrow()
    await vi.waitFor(() => expect(pushAccountSettings).toHaveBeenCalled())
  })
})
