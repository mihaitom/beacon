import { describe, expect, it } from 'vitest'
import { importAction, importOptions, type ImportOption } from '../playHistoryImport'

const lastfm: ImportOption = { source: 'lastfm', username: 'a' }
const listenbrainz: ImportOption = { source: 'listenbrainz', username: 'b' }

describe('importOptions', () => {
  it('offers Last.fm only with the installation key', () => {
    const accounts = { lastfmName: 'a', listenbrainzName: '' }
    expect(importOptions({ ...accounts, lastfmConfigured: false })).toEqual([])
    expect(importOptions({ ...accounts, lastfmConfigured: true })).toEqual([lastfm])
  })

  it('needs no key for ListenBrainz', () => {
    expect(
      importOptions({ lastfmName: '', lastfmConfigured: false, listenbrainzName: 'b' }),
    ).toEqual([listenbrainz])
  })
})

describe('importAction', () => {
  it('starts by itself with one profile', () => {
    expect(importAction('none', [lastfm])).toBe('start')
  })

  it('asks with two', () => {
    expect(importAction('none', [lastfm, listenbrainz])).toBe('choose')
  })

  it('does nothing without a profile', () => {
    expect(importAction('none', [])).toBe('nothing')
    expect(importAction('failed', [])).toBe('nothing')
  })

  it('offers a retry after a failure and never starts one', () => {
    expect(importAction('failed', [lastfm])).toBe('retry')
  })

  it('leaves a running import alone', () => {
    expect(importAction('running', [lastfm])).toBe('nothing')
  })

  it('offers a finished one again, without starting it', () => {
    expect(importAction('done', [lastfm])).toBe('again')
    expect(importAction('done', [])).toBe('nothing')
  })
})
