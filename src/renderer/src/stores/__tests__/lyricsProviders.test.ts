import { beforeEach, describe, expect, it } from 'vitest'
import { LYRIC_PROVIDERS, useLyricsProvidersStore } from '../lyricsProviders'
import { setActivePinia, createPinia } from 'pinia'

describe('lyricsProviders store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('defaults to every provider enabled — opt-out, not opt-in', () => {
    const store = useLyricsProvidersStore()

    expect(store.enabled).toEqual([...LYRIC_PROVIDERS])
  })

  it('persists a selection across store instances', () => {
    useLyricsProvidersStore().setEnabled(['lrclib.net', 'NetEase'])

    setActivePinia(createPinia())
    expect(useLyricsProvidersStore().enabled).toEqual(['lrclib.net', 'NetEase'])
  })

  it('respects a deliberately emptied-out selection instead of falling back to the default', () => {
    useLyricsProvidersStore().setEnabled([])

    setActivePinia(createPinia())
    expect(useLyricsProvidersStore().enabled).toEqual([])
  })

  it('falls back to the default on a corrupted value rather than trusting it', () => {
    localStorage.setItem('beacon.lyrics-providers', 'not json')
    expect(useLyricsProvidersStore().enabled).toEqual([...LYRIC_PROVIDERS])
  })

  it('filters out entries this build does not recognize', () => {
    // e.g. a future version adding a fourth provider, then an older build
    // reading storage it wrote.
    localStorage.setItem(
      'beacon.lyrics-providers',
      JSON.stringify(['lrclib.net', 'Genius', 'NetEase']),
    )
    expect(useLyricsProvidersStore().enabled).toEqual(['lrclib.net', 'NetEase'])
  })

  it('falls back to the default when nothing in a stored array is recognized', () => {
    // Not the same as a deliberate empty selection (see the test above) —
    // this is a stored value with nothing this build can make sense of at
    // all, e.g. every entry from a future/foreign build.
    localStorage.setItem('beacon.lyrics-providers', JSON.stringify(['Genius', 'Foo']))
    expect(useLyricsProvidersStore().enabled).toEqual([...LYRIC_PROVIDERS])
  })

  it('lists every provider connect actually supports', () => {
    expect(LYRIC_PROVIDERS).toEqual(['lrclib.net', 'NetEase', 'SimpMusic'])
  })
})
