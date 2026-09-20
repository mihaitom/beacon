import { describe, it, expect, vi } from 'vitest'
import {
  bestMatch,
  coreTitle,
  playlistSongIds,
  resolveTracks,
  type ResolvedTrack,
} from '../lastfmMatcher'
import type { LastfmTrack } from '@/services/connect/lastfm'
import type { Song } from '@/types/library'

function song(title: string, artist: string, id = `${artist}:${title}`): Song {
  return {
    id,
    title,
    artist,
    artistId: '',
    album: '',
    albumId: '',
    duration: 0,
    trackNumber: null,
    discNumber: null,
    year: null,
    genre: null,
    coverArtId: null,
    starred: false,
    rating: 0,
    playCount: 0,
    format: null,
    bitRate: null,
    replayGain: {},
  } as Song
}

function lastfm(title: string, artist: string): LastfmTrack {
  return { title, artist, mbid: '' }
}

describe('coreTitle', () => {
  it('strips bracketed additions', () => {
    expect(coreTitle('Praise You (Radio Edit)')).toBe('Praise You')
    expect(coreTitle('Blue Monday [12" Version]')).toBe('Blue Monday')
  })

  it('strips a trailing version suffix', () => {
    expect(coreTitle('Blue Monday - Remastered 2016')).toBe('Blue Monday')
    expect(coreTitle('Wish You Were Here - Live')).toBe('Wish You Were Here')
  })

  it('leaves a title that merely contains a hyphen alone', () => {
    // The suffix rule keys on edition words, not on the hyphen itself -
    // stripping every "- x" would cut real titles in half.
    expect(coreTitle('Ob-La-Di, Ob-La-Da')).toBe('Ob-La-Di, Ob-La-Da')
    expect(coreTitle('Sgt. Pepper - Reprise')).toBe('Sgt. Pepper - Reprise')
  })
})

describe('bestMatch', () => {
  it('finds the song despite a version suffix on one side', () => {
    const candidates = [song('Praise You', 'Fatboy Slim')]
    const match = bestMatch(candidates, 'Praise You (Radio Edit)', 'Fatboy Slim')
    expect(match?.song.title).toBe('Praise You')
  })

  it('matches when the file credits only the lead artist', () => {
    const candidates = [song('Cold Heart', 'Elton John')]
    const match = bestMatch(candidates, 'Cold Heart', 'Elton John & Dua Lipa')
    expect(match?.song.artist).toBe('Elton John')
  })

  it('matches when Last.fm credits only the lead artist', () => {
    const candidates = [song('Cold Heart', 'Elton John & Dua Lipa')]
    expect(bestMatch(candidates, 'Cold Heart', 'Elton John')).not.toBeNull()
  })

  it('rejects the right title by the wrong artist', () => {
    // A cover or a same-named song is the failure mode that puts a
    // stranger's track in the playlist.
    const candidates = [song('Hurt', 'Nine Inch Nails')]
    expect(bestMatch(candidates, 'Hurt', 'Christina Aguilera')).toBeNull()
  })

  it('rejects a different song by the right artist', () => {
    const candidates = [song('Come As You Are', 'Nirvana')]
    expect(bestMatch(candidates, 'Smells Like Teen Spirit', 'Nirvana')).toBeNull()
  })

  it('prefers the right artist over a closer title', () => {
    const candidates = [
      song('Yesterday', 'Boyz II Men'),
      song('Yesterday - Remastered 2009', 'The Beatles'),
    ]
    const match = bestMatch(candidates, 'Yesterday', 'The Beatles')
    expect(match?.song.artist).toBe('The Beatles')
  })

  it('prefers the real artist over a tribute act with the closer title', () => {
    // The tribute band's title is a perfect match and the real artist's is
    // only a version of it, so the artist has to outweigh the title for
    // this to come out right.
    const candidates = [
      song('Creep', 'Radiohead Tribute Band'),
      song('Creep (Acoustic)', 'Radiohead'),
    ]
    const match = bestMatch(candidates, 'Creep', 'Radiohead')
    expect(match?.song.artist).toBe('Radiohead')
  })

  it('prefers the exact title over a stripped-down one by the same artist', () => {
    // Both reduce to the same core title, so the full-title comparison is
    // what has to break the tie - otherwise asking for the remix can
    // return the original.
    const candidates = [song('Ray Of Light', 'Madonna'), song('Ray Of Light (Remix)', 'Madonna')]
    const match = bestMatch(candidates, 'Ray Of Light (Remix)', 'Madonna')
    expect(match?.song.title).toBe('Ray Of Light (Remix)')
  })

  it('reports a confident pick as exact and a judgement call as close', () => {
    const exact = bestMatch([song('Believe', 'Cher')], 'Believe', 'Cher')
    expect(exact?.confidence).toBe('exact')

    // Right title, artist Last.fm spells differently enough to be unsure.
    const close = bestMatch([song('Africa', 'TOTO')], 'Africa', 'Toto (Band)')
    expect(close?.confidence).toBe('close')
  })

  it('returns null for an empty candidate list', () => {
    expect(bestMatch([], 'Anything', 'Anyone')).toBeNull()
  })
})

describe('resolveTracks', () => {
  it('keeps the order Last.fm returned, not the order lookups finish in', async () => {
    const tracks = [lastfm('One', 'A'), lastfm('Two', 'B'), lastfm('Three', 'C')]
    const search = vi.fn(async (query: string) => {
      // Make the first lookup the slowest, so a naive implementation that
      // pushes results as they arrive would reorder the chart.
      if (query.startsWith('A ')) await new Promise((r) => setTimeout(r, 20))
      const [artist = '', ...rest] = query.split(' ')
      return [song(rest.join(' '), artist)]
    })

    const resolved = await resolveTracks(tracks, search)
    expect(resolved.map((r) => r.track.title)).toEqual(['One', 'Two', 'Three'])
  })

  it('falls back to a title-only search when the combined one finds nothing', async () => {
    const search = vi.fn(async (query: string) =>
      query === 'Roads' ? [song('Roads', 'Portishead')] : [],
    )

    const resolved = await resolveTracks([lastfm('Roads', 'Portishead')], search)
    expect(search).toHaveBeenCalledWith('Portishead Roads', expect.any(Number))
    expect(search).toHaveBeenCalledWith('Roads', expect.any(Number))
    expect(resolved[0]?.match?.song.artist).toBe('Portishead')
  })

  it('does not run the title-only search when the first one already matched', async () => {
    const search = vi.fn(async () => [song('Roads', 'Portishead')])
    await resolveTracks([lastfm('Roads', 'Portishead')], search)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('reports a track the library does not have instead of dropping it', async () => {
    const search = vi.fn(async () => [])
    const resolved = await resolveTracks([lastfm('Obscurity', 'Nobody')], search)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.match).toBeNull()
  })

  it('survives a failing lookup and keeps going', async () => {
    const search = vi.fn(async (query: string) => {
      if (query.startsWith('B ')) throw new Error('server said no')
      const [artist = '', ...rest] = query.split(' ')
      return [song(rest.join(' '), artist)]
    })

    const resolved = await resolveTracks([lastfm('One', 'A'), lastfm('Two', 'B')], search)
    expect(resolved[0]?.match).not.toBeNull()
    expect(resolved[1]?.match).toBeNull()
  })

  it('reports progress once per track', async () => {
    const search = vi.fn(async () => [])
    const onProgress = vi.fn()
    await resolveTracks([lastfm('A', 'X'), lastfm('B', 'Y')], search, onProgress)
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })

  it('stops early when aborted', async () => {
    const signal = { aborted: false }
    const search = vi.fn(async () => {
      signal.aborted = true
      return []
    })
    const tracks = Array.from({ length: 20 }, (_, i) => lastfm(`T${i}`, 'A'))

    const resolved = await resolveTracks(tracks, search, undefined, signal)
    expect(resolved.length).toBeLessThan(tracks.length)
  })
})

describe('playlistSongIds', () => {
  const found = (id: string): ResolvedTrack => ({
    track: lastfm('t', 'a'),
    match: { song: song('t', 'a', id), confidence: 'exact' },
  })

  it('keeps found tracks in order and skips the missing ones', () => {
    const resolved: ResolvedTrack[] = [
      found('1'),
      { track: lastfm('gone', 'nobody'), match: null },
      found('2'),
    ]
    expect(playlistSongIds(resolved)).toEqual(['1', '2'])
  })

  it('lists a song once even when two entries matched it', () => {
    // A single and its album version both charting is normal; the same
    // file twice in the playlist looks like a bug.
    expect(playlistSongIds([found('1'), found('1'), found('2')])).toEqual(['1', '2'])
  })
})
