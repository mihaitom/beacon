import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { heardAt, usePartyGuestStore } from '../store'
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
    listen: { enabled: false, epoch: null, timeline: [] },
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

  it('says a lyrics fetch is running until the latest one has answered', async () => {
    const store = usePartyGuestStore()
    const answers: Array<(value: Awaited<ReturnType<typeof partyApi.lyrics>>) => void> = []
    vi.spyOn(partyApi, 'lyrics').mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    )
    const lines = { synced: true, offset: 0, lines: [{ time: 0, text: 'x' }] }

    store.applySnapshot(snapshot({ lyrics_key: 'c:1' }))
    expect(store.lyricsLoading).toBe(true)
    store.applySnapshot(snapshot({ lyrics_key: 'c:2' }))
    answers[0]!({ song_id: 'a', ...lines })
    await Promise.resolve()
    expect(store.lyricsLoading).toBe(true)

    answers[1]!({ song_id: 'a', ...lines })
    await vi.waitFor(() => expect(store.lyricsLoading).toBe(false))
  })

  it('stops saying lyrics are coming once their key goes away', () => {
    const store = usePartyGuestStore()
    vi.spyOn(partyApi, 'lyrics').mockReturnValue(new Promise(() => {}))

    store.applySnapshot(snapshot({ lyrics_key: 'd:1' }))
    store.applySnapshot(snapshot({ lyrics_key: null }))

    expect(store.lyricsLoading).toBe(false)
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

  it('picks up a fresh invitation pasted onto a page that already showed the end', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(partyApi, 'state').mockRejectedValueOnce(new PartyApiError(404, ''))
    await store.start()
    expect(store.message).toBe('ended')
    // Only the fragment changes, so the browser does not reload the page.
    vi.spyOn(partyApi, 'state').mockRejectedValue(new PartyApiError(401, 'Not joined'))
    history.replaceState(null, '', '/party/#t=new_TOKEN-1')
    window.dispatchEvent(new Event('hashchange'))
    await vi.waitFor(() => expect(store.phase).toBe('join'))
    expect(store.inviteToken).toBe('new_TOKEN-1')
    expect(window.location.hash).toBe('')
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

describe('listening along', () => {
  const songA = { id: 'a', title: 'A', artist: 'X', album: null, duration: 200, cover: null }
  const songB = { id: 'b', title: 'B', artist: 'Y', album: null, duration: 180, cover: null }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function listening(timeline: GuestSnapshot['listen']['timeline'], current = songB) {
    const store = usePartyGuestStore()
    store.applySnapshot(
      snapshot({
        current_song: { ...current, wished_by: 'Ben' },
        listen: { enabled: true, epoch: 'e1', timeline },
      }),
    )
    store.listenState = 'playing'
    return store
  }

  it('maps the stream time heard onto a song and a position', () => {
    const timeline = [
      { at: 0, song: songA, position: 30, playing: true },
      { at: 170, song: songB, position: 0, playing: true },
    ]
    expect(heardAt(timeline, 100)).toEqual({ song: songA, position: 130, playing: true })
    expect(heardAt(timeline, 175)).toEqual({ song: songB, position: 5, playing: true })
    expect(heardAt(timeline, -1)).toBeNull()
  })

  it('holds the position of a paused stretch and never runs past the song', () => {
    expect(heardAt([{ at: 0, song: songA, position: 50, playing: false }], 90)?.position).toBe(50)
    expect(heardAt([{ at: 0, song: songA, position: 190, playing: true }], 60)?.position).toBe(200)
  })

  it('shows what the guest hears, not what the host has moved on to', () => {
    const store = listening([
      { at: 0, song: songA, position: 0, playing: true },
      { at: 200, song: songB, position: 0, playing: true },
    ])
    store.listenTime = 195
    expect(store.displaySong?.id).toBe('a')
    expect(store.position).toBeCloseTo(195)
    expect(store.displayDuration).toBe(200)
    store.listenTime = 202
    // The host's copy, which knows who wished for it.
    expect(store.displaySong?.wished_by).toBe('Ben')
  })

  it("falls back to the host's view until the stream time is known", () => {
    const store = listening([{ at: 0, song: songA, position: 0, playing: true }])
    store.listenTime = null
    expect(store.displaySong?.id).toBe('b')
  })

  it('keeps the lyrics of the song still being heard', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(partyApi, 'lyrics')
      .mockResolvedValueOnce({
        song_id: 'a',
        synced: true,
        offset: 0,
        lines: [{ time: 0, text: 'a' }],
      })
      .mockResolvedValueOnce({
        song_id: 'b',
        synced: true,
        offset: 0,
        lines: [{ time: 0, text: 'b' }],
      })
    store.applySnapshot(snapshot({ current_song: songA, lyrics_key: 'a:1' }))
    await vi.waitFor(() => expect(store.lyrics?.song_id).toBe('a'))
    const timeline = [
      { at: 0, song: songA, position: 0, playing: true },
      { at: 200, song: songB, position: 0, playing: true },
    ]
    store.applySnapshot(
      snapshot({
        current_song: songB,
        lyrics_key: 'b:1',
        listen: { enabled: true, epoch: 'e1', timeline },
      }),
    )
    await vi.waitFor(() => expect(store.lyrics?.song_id).toBe('b'))
    store.listenState = 'playing'
    store.listenTime = 198
    expect(store.currentLyrics?.lines[0]?.text).toBe('a')
  })

  it('stops when the host switches listening along off', () => {
    const store = listening([])
    const stop = vi.spyOn(store, 'stopListening')
    store.applySnapshot(snapshot({ listen: { enabled: false, epoch: null, timeline: [] } }))
    expect(stop).toHaveBeenCalled()
  })
})

describe('the wish buttons', () => {
  const song = { id: 'w1', title: 'W', artist: null, album: null, duration: 180, cover: null }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('is ticked straight away, and again once the song plays it is not', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(partyApi, 'wish').mockResolvedValue({ success: true })
    store.applySnapshot(snapshot())
    await store.wish(song)
    expect(store.isWished('w1')).toBe(true)

    // The wish shows up in what is coming up...
    store.applySnapshot(
      snapshot({ upcoming: [{ ...song, request: { name: 'Anna', mine: true, id: 'r1' } }] }),
    )
    expect(store.isWished('w1')).toBe(true)
    // ...and leaves it once it is playing: the button can be used again.
    store.applySnapshot(snapshot({ current_song: song, upcoming: [] }))
    expect(store.isWished('w1')).toBe(false)
  })

  it('is no longer ticked once withdrawn', () => {
    const store = usePartyGuestStore()
    store.applySnapshot(
      snapshot({ upcoming: [{ ...song, request: { name: 'Anna', mine: true, id: 'r1' } }] }),
    )
    expect(store.isWished('w1')).toBe(true)
    store.applySnapshot(snapshot({ upcoming: [] }))
    expect(store.isWished('w1')).toBe(false)
  })

  it("is not ticked for somebody else's wish", () => {
    const store = usePartyGuestStore()
    store.applySnapshot(
      snapshot({ upcoming: [{ ...song, request: { name: 'Ben', mine: false } }] }),
    )
    expect(store.isWished('w1')).toBe(false)
  })

  it('gives up on a wish no snapshot ever showed', async () => {
    const store = usePartyGuestStore()
    vi.spyOn(partyApi, 'wish').mockResolvedValue({ success: true })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await store.wish(song)
    now.mockReturnValue(1_000_000 + 11_000)
    expect(store.isWished('w1')).toBe(false)
  })
})
