import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useConnectStore } from '../connect'
import { usePlaybackStore } from '../playback'
import { useRadioMetadataStore } from '../radioMetadata'
import { getAudioEngine } from '@/services/audioEngine'
import * as radioMetadata from '@/services/connect/radioMetadata'
import { makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))
// Reaches for navigator.mediaSession, which jsdom has no implementation of
// — and what it wires is covered by services/mediaSession.ts's own tests.
vi.mock('@/services/mediaSession', () => ({ initMediaSession: vi.fn() }))
vi.mock('@/services/connect/radioMetadata', () => ({
  startRadioMetadataWatch: vi.fn(),
  stopRadioMetadataWatch: vi.fn(),
  fetchRadioMetadata: vi.fn().mockResolvedValue(null),
  fetchRadioTitleHistory: vi.fn().mockResolvedValue({ url: null, history: [] }),
  searchRadioTitleHistory: vi.fn().mockResolvedValue({ url: null, history: [] }),
  RADIO_TITLE_PAGE_SIZE: 200,
}))

/** What the poll actually reads off the element — how far ahead it has
 * buffered, which is what a new title is held back by — plus the one call
 * the playback store's init() makes on the way to starting the poll
 * interval these tests run on. */
let engine: { bufferedAhead: number; setVolume: ReturnType<typeof vi.fn> }

function castTo(): void {
  useConnectStore().status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })
}

describe('the radio metadata store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    engine = { bufferedAhead: 0, setVolume: vi.fn() }
    vi.mocked(getAudioEngine).mockReturnValue(
      engine as unknown as ReturnType<typeof getAudioEngine>,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A station playing, with the 8s poll interval running behind it — that
   * interval lives in the playback store's init(), which is what drives
   * poll() below. `titleLog` seeds what this client already holds, since
   * both paging and searching are about a log that is already on screen. */
  function playChillFm(titleLog: radioMetadata.RadioTitleEntry[] = []) {
    const playback = usePlaybackStore()
    playback.init()
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }
    const radioMeta = useRadioMetadataStore()
    radioMeta.titleLog = titleLog
    return { playback, radioMeta }
  }

  /** One poll cycle: the interval init() started, plus the fetch it
   * awaits. */
  async function poll() {
    await vi.advanceTimersByTimeAsync(8000)
    await flushPromises()
  }

  describe('the now-playing tag against what is audible', () => {
    it('holds a new title back by what the element has buffered ahead', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1 }],
        bitrate: 128,
        codec: 'MP3',
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      // Not yet: those 15 seconds are still in the buffer, unheard.
      expect(radioMeta.nowPlaying).toBeNull()
      // ...while what describes the station rather than a moment in it is
      // applied straight away.
      expect(radioMeta.codec).toBe('MP3')

      await vi.advanceTimersByTimeAsync(15_000)

      expect(radioMeta.nowPlaying).toBe('Artist - Track')
    })

    it('shows it straight away when nothing is buffered ahead', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(radioMeta.nowPlaying).toBe('Artist - Track')
    })

    it("does not hold anything while casting, where the buffer is the speaker's", async () => {
      const { radioMeta } = playChillFm()
      castTo()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(radioMeta.nowPlaying).toBe('Artist - Track')
    })

    it('does not re-arm the hold on every poll reporting the same title', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 10
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      // The poll runs every 8s, so a 10s hold sees one more answer with the
      // same title before it lands. Re-arming on that would push the title
      // back for as long as the station keeps playing it.
      await poll()
      await poll()
      await vi.advanceTimersByTimeAsync(2500)

      expect(radioMeta.nowPlaying).toBe('Artist - Track')
    })

    it('asks for the whole first page, then only for what is newer', async () => {
      // Started for its side effects alone — this one watches the requests
      // rather than the store they land in.
      playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(undefined)

      await poll()

      // The entry it already holds, so the backend has nothing to repeat.
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(1000)
    })

    it('puts a delta on top of the log rather than replacing it', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - First',
        history: [{ title: 'Artist - First', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Second',
        history: [{ title: 'Artist - Second', at: 2000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      expect(radioMeta.titleLog.map((e) => e.title)).toEqual(['Artist - Second', 'Artist - First'])
    })

    it('keeps re-offering a held entry until it is actually applied', async () => {
      // A held title is not in the log, so `since` still names the entry
      // below it and the backend keeps handing the same one back. That is
      // what saves keeping a pending buffer of entries on this side.
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 20
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Held',
        history: [{ title: 'Artist - Held', at: 2000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      expect(radioMeta.titleLog).toEqual([])
      await poll()
      expect(radioMetadata.fetchRadioMetadata).toHaveBeenLastCalledWith(undefined)

      await vi.advanceTimersByTimeAsync(20_000)

      expect(radioMeta.titleLog.map((e) => e.title)).toEqual(['Artist - Held'])
    })

    it('never lets the same entry into the log twice', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()
      await poll()

      expect(radioMeta.titleLog).toHaveLength(1)
    })

    it('treats a short first page as the whole log, with nothing older to fetch', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [{ title: 'Artist - Track', at: 1000 }],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(radioMeta.titleLogComplete).toBe(true)
    })

    it('leaves the door open for older pages when the first one is full', async () => {
      const { radioMeta } = playChillFm()
      engine.bufferedAhead = 0
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track 0',
        history: Array.from({ length: 200 }, (_, i) => ({
          title: `Artist - Track ${i}`,
          at: 100_000 - i,
        })),
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })

      await poll()

      expect(radioMeta.titleLogComplete).toBe(false)
    })

    it('drops a held title when the station changes under it', async () => {
      const { playback, radioMeta } = playChillFm()
      engine.bufferedAhead = 15
      vi.mocked(radioMetadata.fetchRadioMetadata).mockResolvedValue({
        url: 'https://stream.example/chill',
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
        relayBitrate: null,
        relayReason: null,
        relayContentType: null,
      })
      await poll()

      playback.radioStation = {
        id: 'r2',
        name: 'Other FM',
        streamUrl: 'https://stream.example/other',
        homePageUrl: null,
      }
      radioMeta.nowPlaying = null
      await vi.advanceTimersByTimeAsync(15_000)

      expect(radioMeta.nowPlaying).toBeNull()
    })
  })

  describe('searching the title log', () => {
    it('asks the backend rather than filtering the pages it happens to hold', async () => {
      // The whole point: the entry somebody looks for is usually one they
      // have not scrolled to. A local filter could never find it.
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Oasis - Wonderwall', at: 500 }],
      })

      await radioMeta.search('wonder')

      expect(radioMetadata.searchRadioTitleHistory).toHaveBeenCalledWith('wonder')
      expect(radioMeta.searchResults.map((e) => e.title)).toEqual(['Oasis - Wonderwall'])
      // The log itself is untouched, so dropping the search costs no fetch.
      expect(radioMeta.titleLog.map((e) => e.title)).toEqual(['Artist - Newest'])
    })

    it('drops the search on an empty query instead of searching for nothing', async () => {
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Oasis - Wonderwall', at: 500 }],
      })
      await radioMeta.search('wonder')
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockClear()

      await radioMeta.search('   ')

      expect(radioMetadata.searchRadioTitleHistory).not.toHaveBeenCalled()
      expect(radioMeta.searchQuery).toBe('')
      expect(radioMeta.searchResults).toEqual([])
    })

    it('lets the newest search win, however the answers are ordered', async () => {
      // One request per keystroke past the debounce: "wond" going out
      // before "wonder" must not land after it.
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      const resolvers: ((page: radioMetadata.RadioTitleHistoryPage) => void)[] = []
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve)),
      )

      const stale = radioMeta.search('wond')
      const fresh = radioMeta.search('wonder')
      resolvers[1]!({
        url: 'https://stream.example/chill',
        history: [{ title: 'Oasis - Wonderwall', at: 500 }],
      })
      await fresh
      resolvers[0]!({
        url: 'https://stream.example/chill',
        history: [{ title: 'Stevie Wonder - Superstition', at: 400 }],
      })
      await stale

      expect(radioMeta.searchResults.map((e) => e.title)).toEqual(['Oasis - Wonderwall'])
    })

    it('throws away results the backend built for a different station', async () => {
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/other',
        history: [{ title: 'Other FM - Wonderwall', at: 500 }],
      })

      await radioMeta.search('wonder')

      expect(radioMeta.searchResults).toEqual([])
    })

    it('forgets a search when the station changes', async () => {
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Oasis - Wonderwall', at: 500 }],
      })
      await radioMeta.search('wonder')

      radioMeta.reset()

      expect(radioMeta.searchQuery).toBe('')
      expect(radioMeta.searchResults).toEqual([])
    })

    it('reports a search still being out, so an empty list does not read as no matches', async () => {
      const { radioMeta } = playChillFm([{ title: 'Artist - Newest', at: 3000 }])
      let resolvePage: (page: radioMetadata.RadioTitleHistoryPage) => void = () => {}
      vi.mocked(radioMetadata.searchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => (resolvePage = resolve)),
      )

      const pending = radioMeta.search('wonder')
      expect(radioMeta.searchPending).toBe(true)

      resolvePage({ url: 'https://stream.example/chill', history: [] })
      await pending

      expect(radioMeta.searchPending).toBe(false)
    })
  })

  describe('paging back through the title log', () => {
    it('appends the page before the oldest entry it holds', async () => {
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })

      await radioMeta.loadOlder()

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledWith(2000)
      expect(radioMeta.titleLog.map((e) => e.title)).toEqual([
        'Artist - Newest',
        'Artist - Oldest held',
        'Artist - Older',
      ])
    })

    it('stops asking once a page comes back shorter than a full one', async () => {
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })

      await radioMeta.loadOlder()
      expect(radioMeta.titleLogComplete).toBe(true)

      await radioMeta.loadOlder()

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledTimes(1)
    })

    it('keeps going while a page comes back full', async () => {
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: Array.from({ length: 200 }, (_, i) => ({
          title: `Artist - Old ${i}`,
          at: 1000 - i,
        })),
      })

      await radioMeta.loadOlder()

      expect(radioMeta.titleLogComplete).toBe(false)
    })

    it('never has two pages of the same log in flight at once', async () => {
      // The scroll handler fires on every scroll event and leans on this
      // rather than throttling itself - see RadioTitleLog.vue's onScroll().
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      let resolvePage: (page: radioMetadata.RadioTitleHistoryPage) => void = () => {}
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => (resolvePage = resolve)),
      )

      const first = radioMeta.loadOlder()
      await radioMeta.loadOlder()
      resolvePage({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await first

      expect(radioMetadata.fetchRadioTitleHistory).toHaveBeenCalledTimes(1)
      expect(radioMeta.titleLog).toHaveLength(3)
    })

    it('throws away a page that arrives after the station has changed', async () => {
      const { playback, radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      let resolvePage: (page: radioMetadata.RadioTitleHistoryPage) => void = () => {}
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockImplementation(
        () => new Promise((resolve) => (resolvePage = resolve)),
      )

      const pending = radioMeta.loadOlder()
      playback.radioStation = {
        id: 'r2',
        name: 'Other FM',
        streamUrl: 'https://stream.example/other',
        homePageUrl: null,
      }
      radioMeta.reset()
      resolvePage({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await pending

      expect(radioMeta.titleLog).toEqual([])
    })

    it('throws away a page the backend built for a different station', async () => {
      // Same window as the poll's own url check: this client is on the new
      // station while the backend, for a moment, still is not.
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/other',
        history: [{ title: 'Other FM - Older', at: 1000 }],
      })

      await radioMeta.loadOlder()

      expect(radioMeta.titleLog).toHaveLength(2)
      // Nor does it count as having reached the beginning of this
      // station's log — the next scroll asks again.
      expect(radioMeta.titleLogComplete).toBe(false)
    })

    it('asks nothing at all when no station is playing', async () => {
      // A log without a station behind it, so this really is the station
      // that stops the request rather than there being nothing to page
      // back from.
      const radioMeta = useRadioMetadataStore()
      radioMeta.titleLog = [{ title: 'Artist - Newest', at: 3000 }]

      await radioMeta.loadOlder()

      expect(radioMetadata.fetchRadioTitleHistory).not.toHaveBeenCalled()
    })

    it('lets a failed page be retried by the next scroll', async () => {
      const { radioMeta } = playChillFm([
        { title: 'Artist - Newest', at: 3000 },
        { title: 'Artist - Oldest held', at: 2000 },
      ])
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockRejectedValueOnce(
        new Error('unreachable'),
      )

      await radioMeta.loadOlder()

      expect(radioMeta.titleLogComplete).toBe(false)

      vi.mocked(radioMetadata.fetchRadioTitleHistory).mockResolvedValue({
        url: 'https://stream.example/chill',
        history: [{ title: 'Artist - Older', at: 1000 }],
      })
      await radioMeta.loadOlder()

      expect(radioMeta.titleLog).toHaveLength(3)
    })
  })
})
