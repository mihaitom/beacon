import { describe, expect, it } from 'vitest'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import italian from '@/i18n/locales/it'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Artist } from '@/types/library'
import { splitDays } from '../dayUnits'
import { PRESETS } from '../presets'
import {
  FIELDS,
  SORT_FIELDS,
  emptyRules,
  operatorsFor,
  problems,
  serializeRules,
  parseRules,
} from '../smartRules'
import { suggestionsFor } from '../suggestions'

describe('splitDays', () => {
  it.each([
    [365, { amount: 1, unit: 'years' }],
    [180, { amount: 6, unit: 'months' }],
    [14, { amount: 2, unit: 'weeks' }],
    [10, { amount: 10, unit: 'days' }],
    [0, { amount: 0, unit: 'days' }],
  ])('reads %i days in the largest unit that fits', (days, expected) => {
    expect(splitDays(days)).toEqual(expected)
  })
})

describe('presets', () => {
  it.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s gives rules Navidrome would accept, and that survive a round trip',
    (_id, preset) => {
      const rules = { ...emptyRules(), ...preset.build() }

      expect(problems(rules)).toEqual([])
      const json = serializeRules(rules)
      expect(serializeRules(parseRules(json))).toEqual(json)
    },
  )
})

describe('suggestionsFor', () => {
  const songs = [
    makeSong('1', { genre: 'Jazz', artist: 'Miles Davis' }),
    makeSong('2', { genre: 'Jazz', artist: 'Bill Evans' }),
    makeSong('3', { genre: 'Rock', artist: 'Miles Davis' }),
    makeSong('4', { genre: null }),
  ]

  it('offers what the library holds, most common first, with a count', () => {
    expect(suggestionsFor('genre', songs, [])).toEqual([
      { value: 'Jazz', count: 2 },
      { value: 'Rock', count: 1 },
    ])
  })

  it('takes album artists from the artist list, which is where the server keeps them', () => {
    const artists = [{ name: 'Miles Davis' }, { name: 'Various Artists' }] as Artist[]

    expect(suggestionsFor('albumartist', songs, artists)).toEqual([
      { value: 'Miles Davis', count: null },
      { value: 'Various Artists', count: null },
    ])
  })

  it('suggests no titles, which nobody picks from a list', () => {
    expect(suggestionsFor('title', songs, [])).toEqual([])
  })

  it('counts a new catalogue afresh', () => {
    expect(suggestionsFor('genre', songs, [])[0]).toEqual({ value: 'Jazz', count: 2 })

    const next = [...songs, makeSong('5', { genre: 'Rock' }), makeSong('6', { genre: 'Rock' })]

    expect(suggestionsFor('genre', next, [])[0]).toEqual({ value: 'Rock', count: 3 })
  })
})

/** The editor builds these keys at runtime (`smartPlaylists.fields.${key}`),
 * which the app-wide key check cannot follow. */
describe('the editor’s names in every language', () => {
  const locales = { de, en, es, fr, it: italian }
  const operators = new Set(FIELDS.flatMap((field) => operatorsFor(field)))

  it.each(Object.entries(locales))(
    '%s names every field, operator and preset',
    (_lang, messages) => {
      const smart = messages.smartPlaylists as unknown as Record<string, Record<string, string>>
      for (const key of [...FIELDS.map((field) => field.key), ...SORT_FIELDS]) {
        expect(smart.fields![key], key).toBeTruthy()
      }
      for (const operator of operators) expect(smart.operators![operator], operator).toBeTruthy()
      for (const preset of PRESETS) expect(smart.presets![preset.id], preset.id).toBeTruthy()
      for (const topic of ['song', 'listening', 'file']) expect(smart.topics![topic]).toBeTruthy()
      for (const unit of ['days', 'weeks', 'months', 'years', 'minutes']) {
        expect(smart.units![unit]).toBeTruthy()
      }
    },
  )
})
