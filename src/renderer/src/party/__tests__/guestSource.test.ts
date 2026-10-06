import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGuestNowPlayingSource } from '../guestSource'
import { usePartyGuestStore } from '../store'
import type { GuestSnapshot, GuestSong } from '../api'

class FakeEventSource {
  static CLOSED = 2
  readyState = 1
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close() {
    this.readyState = 2
  }
}

const SONG: GuestSong = {
  id: 's1',
  title: 'Harbor Lights',
  artist: 'The Tide',
  album: 'Low Water',
  duration: 200,
  cover: '/party/api/cover?id=c1',
}

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    playing: true,
    position: 10,
    duration: 200,
    position_at: 1000,
    casting: false,
    backdrop: false,
    backdrop_index: 0,
    backdrop_count: 0,
    lyrics_key: null,
    current_song: null,
    radio: null,
    upcoming: [],
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 0 },
    skip: { enabled: true, votes: 0, needed: 2, mine: false },
    ...overrides,
  }
}

describe('guest Now Playing source', () => {
  let dispose: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('EventSource', FakeEventSource)
    localStorage.clear()
  })

  afterEach(() => {
    dispose?.()
    vi.unstubAllGlobals()
  })

  it('maps the snapshot to the presentation shape, cover URL included', () => {
    usePartyGuestStore().applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.song?.title).toBe('Harbor Lights')
    expect(built.source.song?.artist).toBe('The Tide')
    expect(built.source.song?.coverUrl).toBe('/party/api/cover?id=c1')
    expect(built.source.song?.coverArtId).toBeNull()
    expect(built.source.panels[0]?.title).toBe('Harbor Lights')
  })

  it('leaves every host-only capability off', () => {
    usePartyGuestStore().applySnapshot(snapshot({ current_song: SONG }))
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.capabilities.seek).toBe(false)
    expect(built.source.capabilities.artistLinks).toBe(false)
    expect(built.source.capabilities.titleLog).toBe(false)
    expect(built.source.capabilities.autoplay).toBe(false)
    expect(built.source.capabilities.debug).toBe(false)
    expect(built.source.capabilities.lyricsTools).toBe(false)
    // Fullscreen stays: it is the presentation's own, not the host's.
    expect(built.source.capabilities.fullscreen).toBe(true)
  })

  it('steps through the artist backgrounds on its own', () => {
    usePartyGuestStore().applySnapshot(
      snapshot({ backdrop: true, backdrop_count: 3, backdrop_index: 1, current_song: SONG }),
    )
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.backdrop.backgrounds).toHaveLength(3)
    expect(built.source.backdrop.index).toBe(1)
    built.source.cycleBackground()
    expect(built.source.backdrop.index).toBe(2)
    expect(built.source.ui.artworkHidden).toBe(true)
  })

  it('takes the position from the party store', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot({ position: 42, current_song: SONG }))
    store.now = store.snapshot!.position_at
    const built = useGuestNowPlayingSource()
    dispose = built.dispose

    expect(built.source.position).toBeCloseTo(42)
  })
})
