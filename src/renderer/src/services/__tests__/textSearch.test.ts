import { afterEach, describe, expect, it } from 'vitest'
import { matchesAllTerms, scoreAllTerms, setExactMatching } from '../textSearch'

// The exact mode is a module-wide preference (see textSearch.ts), so a test
// that turns it on has to turn it back off for the next one.
afterEach(() => setExactMatching(false))

describe('matchesAllTerms', () => {
  it('matches a query split across two different fields', () => {
    // The reported bug: this used to require one single field to contain
    // the whole string, so neither "Michael Jackson" (artist) nor "Bad"
    // (title) alone would combine into a match.
    expect(matchesAllTerms('Michael Jackson Bad', ['Bad', 'Michael Jackson', 'Album'])).toBe(true)
  })

  it('still matches when the whole query sits in one field', () => {
    expect(matchesAllTerms('Michael Jackson', ['Bad', 'Michael Jackson', 'Album'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesAllTerms('MICHAEL bad', ['Bad', 'Michael Jackson'])).toBe(true)
  })

  it('is order-independent — a word can match any field regardless of position', () => {
    expect(matchesAllTerms('Jackson Bad', ['Bad', 'Michael Jackson'])).toBe(true)
    expect(matchesAllTerms('Bad Jackson', ['Bad', 'Michael Jackson'])).toBe(true)
  })

  it('requires every word to match somewhere — a genuine miss still fails', () => {
    expect(matchesAllTerms('Michael Jackson Thriller', ['Bad', 'Michael Jackson'])).toBe(false)
  })

  it('treats an empty or whitespace-only query as matching everything', () => {
    expect(matchesAllTerms('', ['Bad', 'Michael Jackson'])).toBe(true)
    expect(matchesAllTerms('   ', ['Bad', 'Michael Jackson'])).toBe(true)
  })

  it('ignores null/undefined fields instead of throwing', () => {
    expect(matchesAllTerms('Bad', ['Bad', null, undefined])).toBe(true)
  })

  it('collapses repeated whitespace between words', () => {
    expect(matchesAllTerms('Michael   Jackson', ['Bad', 'Michael Jackson'])).toBe(true)
  })

  describe('accent-insensitivity', () => {
    // The reported bug: "La Revolution" (typed without the accent) found
    // nothing against a title actually stored as "La Rèvolution".
    it('finds an accented title from an unaccented query', () => {
      expect(matchesAllTerms('La Revolution', ['La Rèvolution', 'Some Artist', 'Some Album'])).toBe(
        true,
      )
    })

    it('finds an unaccented title from an accented query too', () => {
      expect(matchesAllTerms('Rèvolution', ['La Revolution', 'Some Artist', 'Some Album'])).toBe(
        true,
      )
    })

    it('matches regardless of which specific accent is used', () => {
      expect(matchesAllTerms('cafe', ['Café'])).toBe(true)
      expect(matchesAllTerms('resume', ['Résumé'])).toBe(true)
      expect(matchesAllTerms('naive', ['Naïve'])).toBe(true)
    })
  })

  describe('fuzzy tolerance', () => {
    it('still matches a substring in the middle of a word', () => {
      // The behaviour the filter always had, kept: a prefix test alone would
      // lose it.
      expect(matchesAllTerms('onder', ['Wonderwall'])).toBe(true)
    })

    it('folds punctuation and apostrophes, not only accents', () => {
      expect(matchesAllTerms('dont stop', ["Don't Stop"])).toBe(true)
      expect(matchesAllTerms('ac dc', ['AC/DC'])).toBe(true)
    })

    it('accepts a misspelled word when it is close enough', () => {
      expect(matchesAllTerms('beattles', ['The Beatles', 'Hey Jude'])).toBe(true)
      expect(matchesAllTerms('metalica', ['Metallica', 'Nothing Else Matters'])).toBe(true)
    })

    it('accepts a word with a missing letter', () => {
      // Where the bigram coefficient collapsed, Jaro-Winkler holds: the
      // reported case.
      expect(matchesAllTerms('erth song', ['Earth Song', 'Michael Jackson'])).toBe(true)
    })

    it('still matches a fragment from the middle of a word', () => {
      expect(matchesAllTerms('rth song', ['Earth Song', 'Michael Jackson'])).toBe(true)
    })

    it('rejects a short word that merely looks similar', () => {
      // "oasis" against "basis" scores 0.75, under the floor, and a word this
      // short is left to the substring test.
      expect(matchesAllTerms('oasis', ['Basis'])).toBe(false)
      expect(matchesAllTerms('bush', ['Push'])).toBe(false)
    })
  })
})

describe('scoreAllTerms', () => {
  it('rates an exact field above a word in a longer one, and both above a substring', () => {
    const exact = scoreAllTerms('players', [{ text: 'Players' }])
    const word = scoreAllTerms('players', [{ text: 'Players Club' }])
    const inside = scoreAllTerms('players', [{ text: 'Overplayers' }])

    expect(exact).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(0)
  })

  it('weighs the fields it is given, so a title beats a shared word elsewhere', () => {
    const titleMatch = scoreAllTerms('players', [{ text: 'Players', weight: 2 }, { text: 'X' }])
    const otherMatch = scoreAllTerms('players', [{ text: 'X', weight: 2 }, { text: 'Players' }])

    expect(titleMatch).toBeGreaterThan(otherMatch)
  })

  it('is 0 when a word matches nowhere, so it doubles as the match test', () => {
    expect(scoreAllTerms('players moon', [{ text: 'Players' }])).toBe(0)
  })

  it('is 0 for an empty query', () => {
    expect(scoreAllTerms('   ', [{ text: 'Players' }])).toBe(0)
  })

  it('keeps fragments but drops a misspelling in exact mode', () => {
    // A prefix or a substring still matches - only the near-match is gone.
    expect(scoreAllTerms('wonder', [{ text: 'Wonderwall' }], { exact: true })).toBeGreaterThan(0)
    expect(scoreAllTerms('onder', [{ text: 'Wonderwall' }], { exact: true })).toBeGreaterThan(0)
    expect(scoreAllTerms('beattles', [{ text: 'The Beatles' }], { exact: true })).toBe(0)
    // An exact field still outranks a word in a longer one.
    expect(scoreAllTerms('players', [{ text: 'Players' }], { exact: true })).toBeGreaterThan(
      scoreAllTerms('players', [{ text: 'Players Club' }], { exact: true }),
    )
  })
})

describe('exact mode', () => {
  it('drops the misspelling match app-wide, keeping fragments', () => {
    setExactMatching(true)

    expect(matchesAllTerms('wonder', ['Wonderwall'])).toBe(true)
    expect(matchesAllTerms('nell', ['Nelly'])).toBe(true)
    expect(matchesAllTerms('beattles', ['The Beatles'])).toBe(false)
  })

  it('follows an explicit exact option, which a view switch passes', () => {
    expect(matchesAllTerms('beattles', ['The Beatles'], { exact: true })).toBe(false)
    expect(matchesAllTerms('beattles', ['The Beatles'], { exact: false })).toBe(true)
  })
})
