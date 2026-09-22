import { describe, expect, it } from 'vitest'
import { firstIndexByLetter, indexLetterFor, letterForName } from '../alphabetIndex'

describe('letterForName', () => {
  it('uppercases the leading letter', () => {
    expect(letterForName('zappa')).toBe('Z')
  })

  it('falls back to # for anything that is not a letter', () => {
    expect(letterForName('"A Sound Odyssey" Orchestra')).toBe('#')
    expect(letterForName('01099')).toBe('#')
    expect(letterForName('Ö la Palöma Boys')).toBe('#')
    expect(letterForName('')).toBe('#')
  })
})

describe('indexLetterFor', () => {
  it('uses the server sort name over the display name', () => {
    // Navidrome orders the list by these, so "La Bête Blooms" sits in the B
    // section even though its name reads as L — the bug this exists for.
    expect(indexLetterFor({ name: 'La Bête Blooms', sortName: 'bête blooms' })).toBe('B')
    expect(indexLetterFor({ name: 'The 2 Live Crew', sortName: '2 live crew' })).toBe('#')
    expect(indexLetterFor({ name: 'El DeBarge', sortName: 'de barge' })).toBe('D')
  })

  it('falls back to the name when the server sends no sort name', () => {
    expect(indexLetterFor({ name: 'Zappa' })).toBe('Z')
    expect(indexLetterFor({ name: 'Zappa', sortName: null })).toBe('Z')
    expect(indexLetterFor({ name: 'Zappa', sortName: '' })).toBe('Z')
  })
})

describe('firstIndexByLetter', () => {
  it('records the first index of each letter it is told', () => {
    const items = [
      { letter: 'B' },
      { letter: 'L' },
      { letter: 'B' },
      { letter: '#' },
      { letter: 'L' },
    ]

    const map = firstIndexByLetter(items, (item) => item.letter)

    expect(map.get('B')).toBe(0)
    expect(map.get('L')).toBe(1)
    expect(map.get('#')).toBe(3)
  })
})
