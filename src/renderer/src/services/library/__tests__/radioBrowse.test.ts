import { beforeEach, describe, expect, it } from 'vitest'
import type { RadioStationInfo } from '@/services/connect/radio'
import type { RadioStation } from '@/types/library'
import {
  commonTags,
  defaultRadioDirection,
  hasTag,
  heardSections,
  loadRadioSort,
  saveRadioSort,
  sortStations,
  type StationInfoLookup,
} from '../radioBrowse'
import { accountScopedKey } from '@/services/accountKey'
import { createPinia, setActivePinia } from 'pinia'

function station(name: string): RadioStation {
  return { id: name, name, streamUrl: `https://stream.example/${name}`, homePageUrl: null }
}

function lookup(info: Record<string, Partial<RadioStationInfo>>): StationInfoLookup {
  return (s) => (info[s.name] ? ({ lastTitle: null, ...info[s.name] } as RadioStationInfo) : null)
}

const names = (stations: RadioStation[]) => stations.map((s) => s.name)
const heard = (at: number) => ({ lastTitle: { title: 't', at } })

describe('sortStations', () => {
  const none = lookup({})

  it('sorts by name without regard to case, numbers as numbers', () => {
    const stations = [station('b 10'), station('A'), station('b 2')]

    expect(names(sortStations(stations, { key: 'name', direction: 'asc' }, none))).toEqual([
      'A',
      'b 2',
      'b 10',
    ])
    expect(names(sortStations(stations, { key: 'name', direction: 'desc' }, none))).toEqual([
      'b 10',
      'b 2',
      'A',
    ])
  })

  it('leaves the list it was given alone', () => {
    const stations = [station('b'), station('a')]

    sortStations(stations, { key: 'name', direction: 'asc' }, none)

    expect(names(stations)).toEqual(['b', 'a'])
  })

  it.each([
    ['heard', heard(10), heard(20)],
    ['bitrate', { bitrate: 128 }, { bitrate: 320 }],
    ['country', { country: 'Austria' }, { country: 'Germany' }],
  ] as const)('orders by %s, both ways', (key, low, high) => {
    const infoFor = lookup({ low, high })
    const stations = [station('low'), station('high')]

    expect(names(sortStations(stations, { key, direction: 'asc' }, infoFor))).toEqual([
      'low',
      'high',
    ])
    expect(names(sortStations(stations, { key, direction: 'desc' }, infoFor))).toEqual([
      'high',
      'low',
    ])
  })

  it.each(['asc', 'desc'] as const)('puts a station without a value last when %s', (direction) => {
    const infoFor = lookup({ a: { bitrate: 128 }, b: { bitrate: 0 }, d: { bitrate: 320 } })
    const stations = [station('c'), station('b'), station('a'), station('d')]

    const sorted = names(sortStations(stations, { key: 'bitrate', direction }, infoFor))

    expect(sorted.slice(2)).toEqual(['b', 'c'])
  })

  it('falls back to the name for equal values', () => {
    const infoFor = lookup({ a: { bitrate: 128 }, b: { bitrate: 128 } })

    expect(
      names(
        sortStations([station('b'), station('a')], { key: 'bitrate', direction: 'desc' }, infoFor),
      ),
    ).toEqual(['a', 'b'])
  })
})

describe('commonTags', () => {
  it('leaves out a tag only one station has', () => {
    const infoFor = lookup({ a: { tags: ['jazz', 'solo'] }, b: { tags: ['jazz'] } })

    expect(commonTags([station('a'), station('b')], infoFor)).toEqual(['jazz'])
  })

  it('puts the most common first and stops at five', () => {
    const tags = ['t1', 't2', 't3', 't4', 't5', 't6']
    const infoFor = lookup({
      a: { tags },
      b: { tags },
      c: { tags: ['t6'] },
    })

    const common = commonTags([station('a'), station('b'), station('c')], infoFor)

    expect(common).toHaveLength(5)
    expect(common[0]).toBe('t6')
  })

  it('counts a tag repeated on one station once', () => {
    const infoFor = lookup({ a: { tags: ['jazz', 'jazz'] } })

    expect(commonTags([station('a')], infoFor)).toEqual([])
  })
})

it('hasTag is false for a station with no details', () => {
  expect(hasTag(station('a'), 'jazz', lookup({}))).toBe(false)
})

describe('heardSections', () => {
  const now = 100 * 86_400_000
  const daysAgo = (days: number) => (now - days * 86_400_000) / 1000

  it('splits at seven days, and never-heard stations count as earlier', () => {
    const infoFor = lookup({
      recent: heard(daysAgo(6.9)),
      old: heard(daysAgo(7.1)),
    })

    const sections = heardSections(
      [station('recent'), station('old'), station('never')],
      infoFor,
      now,
    )

    expect(names(sections.heardThisWeek)).toEqual(['recent'])
    expect(names(sections.earlier)).toEqual(['old', 'never'])
  })
})

it('sorts names and countries up and the rest down by default', () => {
  expect(defaultRadioDirection('name')).toBe('asc')
  expect(defaultRadioDirection('country')).toBe('asc')
  expect(defaultRadioDirection('heard')).toBe('desc')
  expect(defaultRadioDirection('bitrate')).toBe('desc')
})

describe('the remembered order', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('starts on last heard', () => {
    expect(loadRadioSort()).toEqual({ key: 'heard', direction: 'desc' })
  })

  it('comes back as saved', () => {
    saveRadioSort({ key: 'country', direction: 'desc' })

    expect(loadRadioSort()).toEqual({ key: 'country', direction: 'desc' })
  })

  it.each([
    ['garbage', 'not json'],
    ['an unknown order', '{"key":"mood","direction":"asc"}'],
    ['an unknown direction', '{"key":"name","direction":"up"}'],
  ])('ignores %s', (_, stored) => {
    localStorage.setItem(accountScopedKey('beacon.radioSort'), stored)

    expect(loadRadioSort()).toEqual({ key: 'heard', direction: 'desc' })
  })
})
