import { describe, expect, it } from 'vitest'
import {
  newGroup,
  newRule,
  parseRules,
  problems,
  serializeRules,
  withField,
  withOperator,
  type GroupNode,
  type RuleNode,
  type SmartRules,
} from '../smartRules'

function roundTrip(json: unknown): Record<string, unknown> {
  return serializeRules(parseRules(json))
}

function rule(overrides: Partial<RuleNode>): RuleNode {
  return { ...newRule(), ...overrides }
}

function onlyRule(rules: SmartRules): RuleNode {
  expect(rules.children).toHaveLength(1)
  return rules.children[0] as RuleNode
}

describe('reading and writing back', () => {
  it('gives back exactly what it read when every rule is one it knows', () => {
    const json = {
      all: [
        { contains: { genre: 'jazz' } },
        { is: { loved: true } },
        { inTheLast: { lastplayed: 30 } },
        { inTheRange: { year: [1955, 1965] } },
        { before: { dateadded: '2020-01-01' } },
        { isMissing: { albumartist: true } },
        { notInPlaylist: { id: 'pl-1' } },
        { any: [{ gt: { rating: 3 } }, { lt: { playcount: 2 } }] },
      ],
      sort: '-lastplayed',
      limit: 100,
      refreshDelay: '1d',
    }

    expect(roundTrip(json)).toEqual(json)
  })

  it('keeps a rule it cannot edit exactly as it came', () => {
    const unknownField = { contains: { mood: 'calm' } }
    const unknownOperator = { soundsLike: { title: 'x' } }
    const json = { any: [unknownField, unknownOperator, { is: { loved: true } }] }

    const rules = parseRules(json)

    expect(rules.children.map((node) => node.type)).toEqual(['opaque', 'opaque', 'rule'])
    expect(roundTrip(json)).toEqual(json)
  })

  it('keeps a group nested deeper than the editor shows as one opaque rule', () => {
    const deep = { any: [{ is: { loved: true } }, { all: [{ gt: { year: 2000 } }] }] }
    const json = { all: [{ is: { compilation: false } }, deep] }

    const group = parseRules(json).children[1] as GroupNode

    expect(group.type).toBe('group')
    expect(group.children.map((node) => node.type)).toEqual(['rule', 'opaque'])
    expect(roundTrip(json)).toEqual(json)
  })

  it('keeps an object holding two rules at once whole, rather than splitting it', () => {
    // Navidrome reads every key of such an object as its own rule.
    const json = { all: [{ is: { loved: true }, gt: { year: 1990 } }] }

    expect(parseRules(json).children[0]!.type).toBe('opaque')
    expect(roundTrip(json)).toEqual(json)
  })

  it('keeps every top-level setting it does not use', () => {
    const json = {
      all: [{ is: { loved: true } }],
      limitPercent: 10,
      offset: 5,
      somethingNewer: { a: 1 },
    }

    expect(roundTrip(json)).toEqual(json)
  })

  it('reads keys in any case, as Navidrome does', () => {
    const rules = parseRules({ ALL: [{ InTheLast: { LastPlayed: 30 } }], Limit: 20 })

    expect(rules.conjunction).toBe('all')
    expect(onlyRule(rules)).toMatchObject({ field: 'lastplayed', operator: 'inTheLast', value: 30 })
    expect(rules.limit).toBe(20)
  })

  it('gives an empty set of rules for a playlist that has none', () => {
    expect(parseRules(null)).toMatchObject({ conjunction: 'all', children: [], sort: null })
    expect(parseRules(undefined).children).toEqual([])
  })
})

describe('values of the wrong shape', () => {
  it.each([
    ['a year written as text', { gt: { year: '1990' } }],
    ['a range of three', { inTheRange: { year: [1, 2, 3] } }],
    ['a date in another format', { before: { dateadded: '01.02.2020' } }],
    ['a yes/no written as text', { is: { loved: 'true' } }],
    ['a negative number of days', { inTheLast: { lastplayed: -3 } }],
    ['"has no value" turned around', { isMissing: { genre: false } }],
    ['"has no value" on a field Navidrome refuses it for', { isMissing: { title: true } }],
    ['an operator the field does not offer', { contains: { filetype: 'mp' } }],
    ['a playlist named by path', { inPlaylist: { path: 'Favourites.nsp' } }],
    ['the playlist pseudo-field used as a field', { is: { playlist: 'pl-1' } }],
  ])('keeps %s opaque instead of changing it', (_label, rule) => {
    const json = { all: [rule] }

    expect(parseRules(json).children[0]!.type).toBe('opaque')
    expect(roundTrip(json)).toEqual(json)
  })
})

describe('sorting', () => {
  it.each([
    [{ sort: 'year' }, { field: 'year', descending: false }],
    [{ sort: '-playcount' }, { field: 'playcount', descending: true }],
    [{ sort: '+title' }, { field: 'title', descending: false }],
    [
      { sort: 'year', order: 'desc' },
      { field: 'year', descending: true },
    ],
    // Navidrome flips a descending field once more for order: desc.
    [
      { sort: '-year', order: 'DESC' },
      { field: 'year', descending: false },
    ],
    [{ sort: 'random' }, { field: 'random', descending: false }],
  ])('reads %j', (sort, expected) => {
    expect(parseRules({ all: [], ...sort }).sort).toEqual(expected)
  })

  it.each([
    ['several fields', { sort: 'year,title' }],
    ['a field it does not offer', { sort: 'bitrate' }],
    ['an order it does not know', { sort: 'year', order: 'sideways' }],
    ['an order without a field', { order: 'desc' }],
  ])('keeps a sort by %s as written', (_label, sort) => {
    const json = { all: [{ is: { loved: true } }], ...sort }

    expect(parseRules(json).sort).toEqual({ raw: sort })
    expect(roundTrip(json)).toEqual(json)
  })

  it('writes a sort it understood the short way', () => {
    expect(roundTrip({ all: [], sort: 'year', order: 'desc' })).toEqual({
      all: [],
      sort: '-year',
    })
  })
})

describe('limit', () => {
  it('reads no limit for a zero and writes none', () => {
    const rules = parseRules({ all: [], limit: 0 })

    expect(rules.limit).toBeNull()
    expect(serializeRules(rules)).toEqual({ all: [] })
  })

  it('keeps a limit it cannot read as it came', () => {
    expect(roundTrip({ all: [], limit: '50' })).toEqual({ all: [], limit: '50' })
  })
})

describe('editing a rule', () => {
  it('keeps operator and value when the new field has both', () => {
    const before = rule({ field: 'artist', operator: 'contains', value: 'Miles' })

    expect(withField(before, 'album')).toMatchObject({ operator: 'contains', value: 'Miles' })
  })

  it('starts the value over when the new field needs another kind', () => {
    const before = rule({ field: 'artist', operator: 'is', value: 'Miles' })

    expect(withField(before, 'year')).toMatchObject({ field: 'year', operator: 'is', value: null })
  })

  it('falls back to the field’s first operator when it lacks the old one', () => {
    const before = rule({ field: 'artist', operator: 'contains', value: 'Miles' })

    expect(withField(before, 'loved')).toMatchObject({ operator: 'is', value: true })
  })

  it('swaps a number for a range when the operator becomes "between"', () => {
    const before = rule({ field: 'year', operator: 'gt', value: 1990 })

    expect(withOperator(before, 'inTheRange').value).toEqual([null, null])
    expect(withOperator(before, 'lt').value).toBe(1990)
  })

  it('refuses an operator the field does not have', () => {
    const before = rule({ field: 'loved', operator: 'is', value: true })

    expect(withOperator(before, 'contains')).toBe(before)
  })

  it('writes "has no value" the way Navidrome expects it', () => {
    const rules = parseRules({ all: [] })
    rules.children = [withOperator(rule({ field: 'genre' }), 'isMissing')]

    expect(serializeRules(rules)).toEqual({ all: [{ isMissing: { genre: true } }] })
  })
})

describe('problems', () => {
  it('finds none in a complete set of rules', () => {
    const rules = parseRules({
      all: [{ contains: { genre: 'jazz' } }, { any: [{ is: { loved: true } }] }],
    })

    expect(problems(rules)).toEqual([])
  })

  it('wants at least one rule, which Navidrome insists on', () => {
    expect(problems(parseRules({ all: [] }))).toEqual([{ kind: 'noRules' }])
  })

  it('points at a group with nothing in it', () => {
    const rules = parseRules({ all: [] })
    const group = { ...newGroup(), children: [] }
    rules.children = [group]

    expect(problems(rules)).toEqual([{ kind: 'emptyGroup', key: group.key }])
  })

  it.each([
    ['empty text', { field: 'genre', operator: 'contains', value: '  ' }],
    ['a missing number', { field: 'year', operator: 'gt', value: null }],
    ['half a range', { field: 'year', operator: 'inTheRange', value: [1990, null] }],
    ['a range the wrong way round', { field: 'year', operator: 'inTheRange', value: [2000, 1990] }],
    ['no number of days', { field: 'lastplayed', operator: 'inTheLast', value: null }],
    ['no date', { field: 'dateadded', operator: 'before', value: null }],
    ['no playlist', { field: 'playlist', operator: 'inPlaylist', value: null }],
  ] as const)('points at a rule with %s', (_label, overrides) => {
    const rules = parseRules({ all: [] })
    const incomplete = rule(overrides as Partial<RuleNode>)
    rules.children = [incomplete]

    expect(problems(rules)).toEqual([{ kind: 'incomplete', key: incomplete.key }])
  })

  it('takes a rule without a value as complete', () => {
    const rules = parseRules({ all: [{ isPresent: { bpm: true } }] })

    expect(problems(rules)).toEqual([])
  })
})
