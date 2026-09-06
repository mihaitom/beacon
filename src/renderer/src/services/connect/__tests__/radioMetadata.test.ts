import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import {
  fetchRadioMetadata,
  fetchRadioTitleHistory,
  RADIO_TITLE_PAGE_SIZE,
  startRadioMetadataWatch,
  stopRadioMetadataWatch,
} from '../radioMetadata'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

describe('radioMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('startRadioMetadataWatch', () => {
    it('posts the stream url to /radio-metadata/start', () => {
      vi.mocked(fetchConnect).mockResolvedValue({ status: 'ok' })

      startRadioMetadataWatch('https://station.example/stream')

      expect(fetchConnect).toHaveBeenCalledWith('/radio-metadata/start', {
        method: 'POST',
        body: { url: 'https://station.example/stream' },
      })
    })

    it('never throws when the request itself fails', () => {
      vi.mocked(fetchConnect).mockRejectedValue(new Error('unreachable'))

      expect(() => startRadioMetadataWatch('https://station.example/stream')).not.toThrow()
    })
  })

  describe('stopRadioMetadataWatch', () => {
    it('posts to /radio-metadata/stop', () => {
      vi.mocked(fetchConnect).mockResolvedValue({ status: 'ok' })

      stopRadioMetadataWatch()

      expect(fetchConnect).toHaveBeenCalledWith('/radio-metadata/stop', { method: 'POST' })
    })

    it('never throws when the request itself fails', () => {
      vi.mocked(fetchConnect).mockRejectedValue(new Error('unreachable'))

      expect(() => stopRadioMetadataWatch()).not.toThrow()
    })
  })

  describe('fetchRadioMetadata', () => {
    it('resolves to the title, log and stream info the backend reports', async () => {
      const history = [{ title: 'Artist - Track', at: 1_757_000_000 }]
      vi.mocked(fetchConnect).mockResolvedValue({
        title: 'Artist - Track',
        history,
        bitrate: 320,
        codec: 'MP3',
      })

      await expect(fetchRadioMetadata()).resolves.toEqual({
        title: 'Artist - Track',
        history,
        bitrate: 320,
        codec: 'MP3',
      })
      expect(fetchConnect).toHaveBeenCalledWith('/radio-metadata')
    })

    it('resolves to an empty log when nothing has been seen yet', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({
        title: null,
        history: [],
        bitrate: null,
        codec: null,
      })

      await expect(fetchRadioMetadata()).resolves.toEqual({
        title: null,
        history: [],
        bitrate: null,
        codec: null,
      })
    })

    it('asks only for what is newer than the entry it already holds', async () => {
      // The whole point of the delta: a poll every 8s used to carry the
      // entire log back each time.
      vi.mocked(fetchConnect).mockResolvedValue({ title: null, history: [] })

      await fetchRadioMetadata(1_757_000_000.5)

      expect(fetchConnect).toHaveBeenCalledWith('/radio-metadata?since=1757000000.5')
    })

    it('survives a backend too old to send a log or stream info at all', async () => {
      // The desktop app bundles its own connect, but a browser client can
      // be talking to a Beacon server that hasn't been updated yet — an
      // absent field must read as "no history"/"nothing declared", not as
      // undefined reaching the components that render them.
      vi.mocked(fetchConnect).mockResolvedValue({ title: 'Artist - Track' })

      await expect(fetchRadioMetadata()).resolves.toEqual({
        title: 'Artist - Track',
        history: [],
        bitrate: null,
        codec: null,
      })
    })
  })

  describe('fetchRadioTitleHistory', () => {
    it('asks for one page older than the oldest entry held', async () => {
      const page = [{ title: 'Artist - Older', at: 1_756_000_000 }]
      vi.mocked(fetchConnect).mockResolvedValue({ history: page })

      await expect(fetchRadioTitleHistory(1_757_000_000.5)).resolves.toEqual(page)

      expect(fetchConnect).toHaveBeenCalledWith(
        `/radio-metadata/history?before=1757000000.5&limit=${RADIO_TITLE_PAGE_SIZE}`,
      )
    })

    it('reads an answer with no history at all as the end of the log', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({})

      await expect(fetchRadioTitleHistory(1_757_000_000)).resolves.toEqual([])
    })
  })
})
