import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import { autoLyrics, searchLyrics } from '../lyrics'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

function queryOf(call: number): URLSearchParams {
  const [path] = vi.mocked(fetchConnect).mock.calls[call]!
  return new URLSearchParams(String(path).split('?')[1])
}

describe('connect lyrics client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchConnect).mockResolvedValue(null)
  })

  it('sends every ISRC a song has, one parameter each', async () => {
    // connect reads `isrc` as a list; joined into one value it would look
    // up a code that doesn't exist.
    await autoLyrics({ name: 'Song', isrc: ['GBSTK0700004', 'USSM19902991'] }, ['lrc.red'])
    await searchLyrics({ name: 'Song', isrc: ['GBSTK0700004'] }, ['lrc.red'])

    expect(queryOf(0).getAll('isrc')).toEqual(['GBSTK0700004', 'USSM19902991'])
    expect(queryOf(1).getAll('isrc')).toEqual(['GBSTK0700004'])
  })

  it('sends no ISRC when the song has none', async () => {
    await autoLyrics({ name: 'Song' }, ['lrc.red'])

    expect(queryOf(0).has('isrc')).toBe(false)
  })
})
