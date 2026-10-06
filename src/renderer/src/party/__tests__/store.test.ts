import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePartyGuestStore } from '../store'
import { PartyApiError, partyApi, type GuestSnapshot } from '../api'

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
    current_song: {
      id: 'a',
      title: 'A',
      artist: 'X',
      album: null,
      duration: 200,
      cover: null,
    },
    radio: null,
    upcoming: [],
    me: { name: 'Anna' },
    limits: { max_pending: 3, pending: 1 },
    skip: { enabled: true, votes: 0, needed: 2, mine: false },
    ...overrides,
  }
}

class FakeEventSource {
  static CLOSED = 2
  readyState = 1
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close() {
    this.readyState = 2
  }
}

describe('party guest store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('EventSource', FakeEventSource)
    history.replaceState(null, '', '/party/')
  })

  afterEach(() => {
    usePartyGuestStore().stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('works out the position from the server clock, not its own', () => {
    const store = usePartyGuestStore()
    vi.spyOn(Date, 'now').mockReturnValue(500_000) // this device: 500s
    store.applySnapshot(snapshot({ position: 10, position_at: 1000 }))
    // Four seconds later on this device is four seconds later on the server.
    store.now = 504
    expect(store.position).toBeCloseTo(14)
  })

  it('holds the position while paused and never runs past the end', () => {
    const store = usePartyGuestStore()
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    store.applySnapshot(snapshot({ playing: false, position: 42 }))
    store.now += 30
    expect(store.position).toBe(42)
    store.applySnapshot(snapshot({ position: 199, duration: 200 }))
    store.now += 30
    expect(store.position).toBe(200)
  })

  it('only fetches lyrics when they change, and shows them for their own song only', async () => {
    const store = usePartyGuestStore()
    const lyrics = vi
      .spyOn(partyApi, 'lyrics')
      .mockResolvedValue({ song_id: 'a', synced: true, offset: 0, lines: [{ time: 0, text: 'x' }] })
    store.applySnapshot(snapshot({ lyrics_key: 'a:1' }))
    store.applySnapshot(snapshot({ lyrics_key: 'a:1', position: 12 }))
    await vi.waitFor(() => expect(store.lyrics).not.toBeNull())
    expect(lyrics).toHaveBeenCalledTimes(1)
    expect(store.currentLyrics?.song_id).toBe('a')
    store.applySnapshot(
      snapshot({ current_song: { ...snapshot().current_song!, id: 'b' }, lyrics_key: 'a:1' }),
    )
    expect(store.currentLyrics).toBeNull()
  })

  it('does not ask again for lyrics it has when their key flickers', async () => {
    const store = usePartyGuestStore()
    const lyrics = vi
      .spyOn(partyApi, 'lyrics')
      .mockResolvedValue({ song_id: 'a', synced: true, offset: 0, lines: [{ time: 0, text: 'x' }] })
    store.applySnapshot(snapshot({ lyrics_key: 'a:1' }))
    await vi.waitFor(() => expect(store.lyrics).not.toBeNull())
    store.applySnapshot(snapshot({ lyrics_key: null }))
    store.applySnapshot(snapshot({ lyrics_key: 'a:1' }))
    store.applySnapshot(snapshot({ lyrics_key: null }))
    store.applySnapshot(snapshot({ lyrics_key: 'a:1' }))
    await Promise.resolve()
    expect(lyrics).toHaveBeenCalledTimes(1)
    expect(store.currentLyrics?.song_id).toBe('a')
  })

  it('takes the invite token out of the address and asks for a name', async () => {
    history.replaceState(null, '', '/party/#t=abc_DEF-1')
    vi.spyOn(partyApi, 'state').mockRejectedValue(new PartyApiError(401, 'Not joined'))
    const store = usePartyGuestStore()
    await store.start()
    expect(store.phase).toBe('join')
    expect(store.inviteToken).toBe('abc_DEF-1')
    expect(window.location.hash).toBe('')
  })

  it('without a token, asks to scan again rather than offering a join that cannot work', async () => {
    vi.spyOn(partyApi, 'state').mockRejectedValue(new PartyApiError(401, 'Not joined'))
    const store = usePartyGuestStore()
    await store.start()
    expect(store.phase).toBe('message')
    expect(store.message).toBe('rescan')
  })

  it('says the party is over when there is none', async () => {
    vi.spyOn(partyApi, 'state').mockRejectedValue(new PartyApiError(404, ''))
    const store = usePartyGuestStore()
    await store.start()
    expect(store.message).toBe('ended')
  })

  it('goes straight in for a guest who joined before', async () => {
    history.replaceState(null, '', '/party/#t=abc')
    vi.spyOn(partyApi, 'state').mockResolvedValue(snapshot())
    const join = vi.spyOn(partyApi, 'join')
    const store = usePartyGuestStore()
    await store.start()
    expect(store.phase).toBe('app')
    expect(join).not.toHaveBeenCalled()
  })

  it('counts the wishes left', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(snapshot({ limits: { max_pending: 3, pending: 3 } }))
    expect(store.wishesLeft).toBe(0)
  })
})
