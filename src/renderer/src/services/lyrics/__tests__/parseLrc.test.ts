import { describe, expect, it } from 'vitest'
import { fromStructuredLyrics, parseLyrics } from '../parseLrc'

const NUL = '\u0000'

describe('fromStructuredLyrics', () => {
  it('keeps timed lines in order, in seconds', () => {
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: true,
      line: [
        { start: 16310, value: 'second' },
        { start: 13000, value: 'first' },
      ],
    })

    expect(parsed.synced).toBe(true)
    expect(parsed.lines).toEqual([
      { time: 13, text: 'first' },
      { time: 16.31, text: 'second' },
    ])
  })

  it('strips the NUL an ID3 tag leaves behind, keeping its line as a blank', () => {
    // Every server tested passes it through for a USLT tag - Navidrome and
    // Jellyfin alike (2026-08-27). The character has to go; the line does
    // not, because a timed line with no text is how LRC ends the previous
    // line's highlight.
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: true,
      line: [
        { start: 186760, value: 'Come on, phy-phy-phy-physical' },
        { start: 187860, value: NUL },
      ],
    })

    expect(parsed.lines).toEqual([
      { time: 186.76, text: 'Come on, phy-phy-phy-physical' },
      { time: 187.86, text: '' },
    ])
  })

  it('keeps a mid-song instrumental break as its own blank line', () => {
    // Otherwise a single "Yeah" at 0:13 stays highlighted until the next
    // sung line at 0:27 - which is exactly what lrclib's own blank line
    // between them exists to prevent.
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: true,
      line: [
        { start: 13420, value: 'Yeah' },
        { start: 14810, value: ' ' },
        { start: 26950, value: "I've been tryna call" },
      ],
    })

    expect(parsed.lines.map((line) => line.text)).toEqual(['Yeah', '', "I've been tryna call"])
  })

  it('drops blank lines from untimed lyrics, where they carry no timing', () => {
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: false,
      line: [{ value: 'just words' }, { value: NUL }, { value: '   ' }],
    })

    expect(parsed.lines).toEqual([{ time: 0, text: 'just words' }])
  })

  it('leaves a song with nothing but that line with no lines at all', () => {
    // Which is what makes the caller fall back to a third-party lookup
    // instead of showing one blank line as if they were the lyrics.
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: true,
      line: [{ start: 0, value: NUL }],
    })

    expect(parsed.lines).toEqual([])
  })
})

describe('parseLyrics', () => {
  it('reads LRC timestamps into seconds', () => {
    const parsed = parseLyrics('[00:13.00] first\n[00:16.31] second')

    expect(parsed.synced).toBe(true)
    expect(parsed.lines).toEqual([
      { time: 13, text: 'first' },
      { time: 16.31, text: 'second' },
    ])
  })

  it('falls back to plain lines when nothing is timed', () => {
    const parsed = parseLyrics('just words\n\nand more')

    expect(parsed.synced).toBe(false)
    expect(parsed.lines).toEqual([
      { time: 0, text: 'just words' },
      { time: 0, text: 'and more' },
    ])
  })
})

describe('credits at the top of a lyric sheet', () => {
  it('takes them out of the karaoke flow and hands them over separately', () => {
    // NetEase's own credit block, verbatim from "Bohemian Rhapsody": four
    // lines between 0.000s and 0.075s, 25ms of screen time each. They name
    // the songwriter, composer, arranger and producer, so they are moved
    // rather than dropped - the panel shows them beside the source.
    const parsed = parseLyrics(
      [
        '[00:00.00] 作词 : Freddie Mercury',
        '[00:00.02] 作曲 : Freddie Mercury',
        '[00:00.05] 编曲 : Queen',
        '[00:00.07] 制作人 : Roy Thomas Baker/Queen',
        '[00:00.13] Is this the real life?',
      ].join('\n'),
    )

    // Lyricist and composer are the same man, so those two roles end up on
    // one line — see mergeSameCredits().
    expect(parsed.credits).toEqual([
      '作词/作曲 : Freddie Mercury',
      '编曲 : Queen',
      '制作人 : Roy Thomas Baker/Queen',
    ])
    expect(parsed.lines).toEqual([{ time: 0.13, text: 'Is this the real life?' }])
  })

  it('recognises the English wording too', () => {
    const parsed = parseLyrics('[00:00.00] Written by Someone\n[00:20.00] First line')

    expect(parsed.credits).toEqual(['Written by Someone'])
    expect(parsed.lines).toEqual([{ time: 20, text: 'First line' }])
  })

  it('leaves a sung line alone even when it reads like a credit', () => {
    // Only the front of a sheet is ever examined, so a colon mid-song
    // cannot pull a real line out of the lyrics.
    const parsed = parseLyrics('[00:05.00] First line\n[00:10.00] Chorus : the good part')

    expect(parsed.credits).toEqual([])
    expect(parsed.lines.map((line) => line.text)).toEqual(['First line', 'Chorus : the good part'])
  })

  it('empties a sheet that is nothing but credits', () => {
    // What NetEase returns for a song it has no words for (verified
    // 2026-08-27 on "Drowning in Beauty"): two names, no singing. Showing
    // them as the lyrics is worse than saying there are none - and with no
    // lines left, that is exactly what the caller reports.
    const parsed = parseLyrics('[00:00.00-1] 作词 : Darryl Reid\n[00:00.00-1] 作曲 : Darryl Reid')

    expect(parsed.credits).toEqual(['作词/作曲 : Darryl Reid'])
    expect(parsed.lines).toEqual([])
  })

  it('reports none for an ordinary song', () => {
    const parsed = parseLyrics("[00:13.00] Common love isn't for us")

    expect(parsed.credits).toEqual([])
  })

  it("splits them off from a file's own lyrics as well", () => {
    // Lyrics copied into a tag carry whatever the source put at the top.
    const parsed = fromStructuredLyrics({
      lang: 'xxx',
      synced: true,
      line: [
        { start: 0, value: '作词 : Someone' },
        { start: 13000, value: 'First line' },
      ],
    })

    expect(parsed.credits).toEqual(['作词 : Someone'])
    expect(parsed.lines).toEqual([{ time: 13, text: 'First line' }])
  })
})

describe('timestamp shapes in the wild', () => {
  it('reads a tag with a trailing -N suffix', () => {
    // Reported 2026-08-27: these lines showed up as lyrics, tag and all,
    // because the suffix stopped the timestamp from matching at all.
    const parsed = parseLyrics(
      [
        '[00:00.00-1] 作词 : Darryl Reid',
        '[00:00.00-1] 作曲 : Darryl Reid',
        '[00:12.00] First line',
      ].join('\n'),
    )

    expect(parsed.synced).toBe(true)
    expect(parsed.credits).toEqual(['作词/作曲 : Darryl Reid'])
    expect(parsed.lines).toEqual([{ time: 12, text: 'First line' }])
  })

  it('reads a track past the hour mark', () => {
    const parsed = parseLyrics('[100:05.00] Still going')

    expect(parsed.lines).toEqual([{ time: 6005, text: 'Still going' }])
  })

  it('still reads an ordinary tag', () => {
    expect(parseLyrics('[01:02.50] Line').lines).toEqual([{ time: 62.5, text: 'Line' }])
  })
})

describe('credits naming the same people', () => {
  it('merges them into one line, keeping both roles', () => {
    // Reported 2026-08-27: a song written and composed by the same people
    // showed the identical list of names twice.
    const parsed = parseLyrics(
      [
        '[00:00.00-1] 作词 : FLORENT HUGEL/LORIS CIMINO',
        '[00:00.00-1] 作曲 : FLORENT HUGEL/LORIS CIMINO',
        '[00:12.00] First line',
      ].join('\n'),
    )

    expect(parsed.credits).toEqual(['作词/作曲 : FLORENT HUGEL/LORIS CIMINO'])
  })

  it('keeps credits naming different people apart', () => {
    const parsed = parseLyrics(
      ['[00:00.00] 作词 : Someone', '[00:00.02] 作曲 : Somebody Else', '[00:12.00] Line'].join(
        '\n',
      ),
    )

    expect(parsed.credits).toEqual(['作词 : Someone', '作曲 : Somebody Else'])
  })

  it('drops an outright duplicate that has no role at all', () => {
    const parsed = parseLyrics(
      ['[00:00.00] Written by Someone', '[00:00.02] Written by Someone', '[00:12.00] Line'].join(
        '\n',
      ),
    )

    expect(parsed.credits).toEqual(['Written by Someone'])
  })
})
