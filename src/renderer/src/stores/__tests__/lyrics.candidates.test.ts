import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { makeSong } from './fixtures'
import * as connectLyrics from '@/services/connect/lyrics'
import { useLyricsStore } from '../lyrics'
import type { LyricSearchResult } from '@/services/connect/types'

vi.mock('@/services/connect/lyrics', () => ({
  autoLyrics: vi.fn(),
  getLyricsByRemoteId: vi.fn(),
  searchLyrics: vi.fn(),
}))

function result(id: string): LyricSearchResult {
  return {
    id,
    name: 'A Song',
    artist: 'An Artist',
    source: 'lrclib',
    score: 0.1,
    duration: 180,
    isSync: true,
  }
}

/** The candidate list behind "pick a different match". Landing on the right
 * sheet normally takes several attempts, so what matters here is that the
 * search survives between them. */
describe('lyrics store — held candidates', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(connectLyrics.searchLyrics).mockReset()
    vi.mocked(connectLyrics.searchLyrics).mockResolvedValue({ lrclib: [result('1')] })
  })

  it('asks the providers once and reuses the answer on every later open', async () => {
    // The point of the whole thing: reopening the picker used to re-run
    // three third-party lookups, with a spinner in front of each.
    const song = makeSong('a')
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'

    await lyrics.loadCandidates(song)
    await lyrics.loadCandidates(song)
    await lyrics.loadCandidates(song)

    expect(connectLyrics.searchLyrics).toHaveBeenCalledTimes(1)
    expect(lyrics.candidates).toEqual({ lrclib: [result('1')] })
  })

  it('searches again for a different song', async () => {
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    await lyrics.loadCandidates(makeSong('a'))

    lyrics.songId = 'b'
    await lyrics.loadCandidates(makeSong('b'))

    expect(connectLyrics.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('searches again after the list was dropped on a song change', async () => {
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    await lyrics.loadCandidates(makeSong('a'))

    lyrics.clearCandidates()
    await lyrics.loadCandidates(makeSong('a'))

    expect(connectLyrics.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('does not file one song’s matches under the song that replaced it', async () => {
    // Three providers take long enough for the track to change underneath
    // the search. Keeping the result would hand the wrong song's matches
    // back from the held list, which is worse than the old behaviour of
    // simply re-searching.
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    vi.mocked(connectLyrics.searchLyrics).mockImplementation(async () => {
      lyrics.songId = 'b'
      return { lrclib: [result('1')] }
    })

    await lyrics.loadCandidates(makeSong('a'))

    expect(lyrics.candidates).toBeNull()
    expect(lyrics.candidatesSongId).toBeNull()
  })

  it('retries after a failed search instead of holding on to the failure', async () => {
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    vi.mocked(connectLyrics.searchLyrics).mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await lyrics.loadCandidates(makeSong('a'))
    expect(lyrics.candidates).toEqual({})

    await lyrics.loadCandidates(makeSong('a'))

    expect(connectLyrics.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('keeps the list when a match is picked, so the next try costs nothing', async () => {
    // Picking used to empty it, which both re-ran the search on the next
    // open and left whichever picker was open showing "no matches".
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    vi.mocked(connectLyrics.getLyricsByRemoteId).mockResolvedValue('[00:01.00] a line')
    await lyrics.loadCandidates(makeSong('a'))

    await lyrics.selectCandidate(makeSong('a'), 'lrclib', '1')

    expect(lyrics.candidates).toEqual({ lrclib: [result('1')] })
    expect(lyrics.remoteId).toBe('1')
  })

  it('fills in a candidate’s timed state once its sheet has been fetched', async () => {
    // NetEase's and SimpMusic's search APIs carry no synced/plain signal, so
    // their candidates start as unknown; the fetched sheet settles it.
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    const unknown = { ...result('1'), source: 'SimpMusic', isSync: null }
    vi.mocked(connectLyrics.searchLyrics).mockResolvedValue({ SimpMusic: [unknown] })
    vi.mocked(connectLyrics.getLyricsByRemoteId).mockResolvedValue('[00:01.00] a line')

    await lyrics.loadCandidates(makeSong('a'))
    await lyrics.selectCandidate(makeSong('a'), 'SimpMusic', '1')

    expect(lyrics.candidates?.SimpMusic?.[0]?.isSync).toBe(true)
  })

  it('marks a fetched plain sheet as untimed too', async () => {
    const lyrics = useLyricsStore()
    lyrics.songId = 'a'
    const unknown = { ...result('1'), source: 'SimpMusic', isSync: null }
    vi.mocked(connectLyrics.searchLyrics).mockResolvedValue({ SimpMusic: [unknown] })
    vi.mocked(connectLyrics.getLyricsByRemoteId).mockResolvedValue('just plain words')

    await lyrics.loadCandidates(makeSong('a'))
    await lyrics.selectCandidate(makeSong('a'), 'SimpMusic', '1')

    expect(lyrics.candidates?.SimpMusic?.[0]?.isSync).toBe(false)
  })
})
