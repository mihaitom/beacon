import { describe, expect, it } from 'vitest'
import { matchesAllTerms } from '../textSearch'

describe('matchesAllTerms', () => {
  it('matches a query split across two different fields', () => {
    // The reported bug: this used to require one single field to contain
    // the whole string, so neither "Michael Jackson" (artist) nor "Bad"
    // (title) alone would combine into a match.
    expect(matchesAllTerms('Michael Jackson Bad', 'Bad', 'Michael Jackson', 'Album')).toBe(true)
  })

  it('still matches when the whole query sits in one field', () => {
    expect(matchesAllTerms('Michael Jackson', 'Bad', 'Michael Jackson', 'Album')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesAllTerms('MICHAEL bad', 'Bad', 'Michael Jackson')).toBe(true)
  })

  it('is order-independent — a word can match any field regardless of position', () => {
    expect(matchesAllTerms('Jackson Bad', 'Bad', 'Michael Jackson')).toBe(true)
    expect(matchesAllTerms('Bad Jackson', 'Bad', 'Michael Jackson')).toBe(true)
  })

  it('requires every word to match somewhere — a genuine miss still fails', () => {
    expect(matchesAllTerms('Michael Jackson Thriller', 'Bad', 'Michael Jackson')).toBe(false)
  })

  it('treats an empty or whitespace-only query as matching everything', () => {
    expect(matchesAllTerms('', 'Bad', 'Michael Jackson')).toBe(true)
    expect(matchesAllTerms('   ', 'Bad', 'Michael Jackson')).toBe(true)
  })

  it('ignores null/undefined fields instead of throwing', () => {
    expect(matchesAllTerms('Bad', 'Bad', null, undefined)).toBe(true)
  })

  it('collapses repeated whitespace between words', () => {
    expect(matchesAllTerms('Michael   Jackson', 'Bad', 'Michael Jackson')).toBe(true)
  })
})
