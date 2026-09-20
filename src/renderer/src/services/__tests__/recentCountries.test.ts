import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  COUNTRY_DIVIDER,
  RECENT_COUNTRY_LIMIT,
  loadRecentCountries,
  pinRecentCountries,
  saveRecentCountries,
  withRecentCountry,
} from '../recentCountries'

const OPTIONS = [
  { name: 'Austria', code: 'AT' },
  { name: 'Germany', code: 'DE' },
  { name: 'Spain', code: 'ES' },
]

describe('recentCountries', () => {
  beforeEach(() => {
    // accountScopedKey() reaches for the auth store to namespace the key;
    // without an active Pinia every read and write here throws and is
    // swallowed, which would make these tests pass for the wrong reason.
    setActivePinia(createPinia())
    localStorage.clear()
  })

  describe('withRecentCountry', () => {
    it('puts the newest pick first', () => {
      expect(withRecentCountry(['DE'], 'ES')).toEqual(['ES', 'DE'])
    })

    it('moves a repeated pick up rather than listing it twice', () => {
      expect(withRecentCountry(['DE', 'ES'], 'ES')).toEqual(['ES', 'DE'])
    })

    it('leaves the list alone for an empty pick', () => {
      // A picker's clear button is not a country somebody chose.
      expect(withRecentCountry(['DE'], '')).toEqual(['DE'])
      expect(withRecentCountry(['DE'], null)).toEqual(['DE'])
    })

    it('caps the list, so the pinned block cannot push the rest off screen', () => {
      const many = ['A', 'B', 'C', 'D', 'E', 'F'].reduce(
        (codes, code) => withRecentCountry(codes, code),
        [] as string[],
      )
      expect(many).toHaveLength(RECENT_COUNTRY_LIMIT)
      expect(many[0]).toBe('F')
    })
  })

  describe('pinRecentCountries', () => {
    it('hands back the plain list when nothing was picked before', () => {
      // No divider either - there is nothing to divide.
      expect(pinRecentCountries(OPTIONS, [])).toEqual(OPTIONS)
    })

    it('moves recent countries up and marks the break', () => {
      const items = pinRecentCountries(OPTIONS, ['ES'])
      expect(items).toEqual([OPTIONS[2], COUNTRY_DIVIDER, OPTIONS[0], OPTIONS[1]])
    })

    it('keeps the order the recent list is in', () => {
      const items = pinRecentCountries(OPTIONS, ['ES', 'AT'])
      expect(items.slice(0, 2)).toEqual([OPTIONS[2], OPTIONS[0]])
    })

    it('lists a recent country once, not twice', () => {
      // Copying instead of moving would draw two rows as selected, and
      // typing would turn the same country up twice.
      const names = pinRecentCountries(OPTIONS, ['ES']).map((item) => item.name)
      expect(names.filter((name) => name === 'Spain')).toHaveLength(1)
    })

    it('ignores a code no longer in the directory', () => {
      expect(pinRecentCountries(OPTIONS, ['XX'])).toEqual(OPTIONS)
    })
  })

  describe('storage', () => {
    it('reads back what was stored', () => {
      saveRecentCountries(['ES', 'DE'])
      expect(loadRecentCountries()).toEqual(['ES', 'DE'])
    })

    it('starts empty rather than throwing on unreadable storage', () => {
      localStorage.setItem('beacon.radioDiscoverRecentCountries', '{not json')
      expect(loadRecentCountries()).toEqual([])
    })

    it('ignores a stored value of the wrong shape', () => {
      localStorage.setItem('beacon.radioDiscoverRecentCountries', '"DE"')
      expect(loadRecentCountries()).toEqual([])
    })

    it('drops empty entries', () => {
      localStorage.setItem('beacon.radioDiscoverRecentCountries', '["DE","",null]')
      expect(loadRecentCountries()).toEqual(['DE'])
    })

    it('caps what it reads back, however long the stored list is', () => {
      saveRecentCountries(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
      expect(loadRecentCountries()).toHaveLength(RECENT_COUNTRY_LIMIT)
    })
  })
})
