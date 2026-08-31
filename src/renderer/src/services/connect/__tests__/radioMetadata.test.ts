import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import {
  fetchRadioMetadata,
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
    it('resolves to the title the backend reports', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ title: 'Artist - Track' })

      await expect(fetchRadioMetadata()).resolves.toBe('Artist - Track')
      expect(fetchConnect).toHaveBeenCalledWith('/radio-metadata')
    })

    it('resolves to null when nothing has been seen yet', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ title: null })

      await expect(fetchRadioMetadata()).resolves.toBeNull()
    })
  })
})
