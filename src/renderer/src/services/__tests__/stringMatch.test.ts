import { describe, expect, it } from 'vitest'
import {
  bigramSimilarity,
  foldDiacritics,
  jaroWinkler,
  normalize,
  similarity,
} from '../stringMatch'

describe('foldDiacritics', () => {
  it('strips combining marks', () => {
    expect(foldDiacritics('Rèvolution')).toBe('Revolution')
  })
})

describe('normalize', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalize('Bohème!  —  Queen')).toBe('boheme queen')
  })

  it('drops apostrophes without splitting the word', () => {
    expect(normalize("Don't Stop")).toBe('dont stop')
  })
})

describe('bigramSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(bigramSimilarity('wonderwall', 'wonderwall')).toBe(1)
  })

  it('scores a misspelling high and a different word low', () => {
    expect(bigramSimilarity('beatles', 'beattles')).toBeGreaterThan(0.9)
    expect(bigramSimilarity('bush', 'push')).toBeLessThan(0.8)
  })
})

describe('similarity', () => {
  it('is 1 for strings differing only in case, accents or punctuation', () => {
    expect(similarity('La Bohème', 'la boheme')).toBe(1)
    expect(similarity("Don't Stop", 'dont stop')).toBe(1)
    expect(similarity('Café!', 'cafe')).toBe(1)
  })

  it('is 0 when either side is empty', () => {
    expect(similarity('', 'Something')).toBe(0)
    expect(similarity('Something', '   ')).toBe(0)
  })

  it('scores a different song well below a spelling variant', () => {
    const variant = similarity('Smells Like Teen Spirit', 'Smells Like Teen Spirit!')
    const different = similarity('Smells Like Teen Spirit', 'Come As You Are')
    expect(variant).toBeGreaterThan(0.9)
    expect(different).toBeLessThan(0.3)
  })
})

describe('jaroWinkler', () => {
  it('stays high for a single missing or extra letter', () => {
    // Where the bigram coefficient collapses (0.57 for earth/erth), this is
    // what the token-level typo match relies on.
    expect(jaroWinkler('earth', 'erth')).toBeGreaterThan(0.9)
    expect(jaroWinkler('beatles', 'beattles')).toBeGreaterThan(0.9)
    expect(jaroWinkler('metallica', 'metalica')).toBeGreaterThan(0.9)
  })

  it('stays low for a different word sharing a tail', () => {
    expect(jaroWinkler('oasis', 'basis')).toBeLessThan(0.9)
    expect(jaroWinkler('bush', 'push')).toBeLessThan(0.9)
  })
})
