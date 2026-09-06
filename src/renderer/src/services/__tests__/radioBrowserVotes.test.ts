import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { recentRadioBrowserVotes, rememberRadioBrowserVote } from '../radioBrowserVotes'

const STORAGE_KEY = 'beacon.radio-browser-votes'

describe('radioBrowserVotes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("remembers a station that has had this account's vote", () => {
    rememberRadioBrowserVote('uuid-a')

    expect(recentRadioBrowserVotes()).toEqual(new Set(['uuid-a']))
  })

  it('has nothing for a station nobody voted for', () => {
    expect(recentRadioBrowserVotes().has('uuid-a')).toBe(false)
  })

  /** The directory allows a fresh vote 24 hours later, so a note about one
   * must not outlive that - otherwise the button stays shut on a vote that
   * would now be accepted. */
  it('forgets a vote once the directory would accept another one', () => {
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
    rememberRadioBrowserVote('uuid-a')

    vi.setSystemTime(new Date('2026-09-07T11:59:00Z'))
    expect(recentRadioBrowserVotes().has('uuid-a')).toBe(true)

    vi.setSystemTime(new Date('2026-09-07T12:01:00Z'))
    expect(recentRadioBrowserVotes().has('uuid-a')).toBe(false)
  })

  it('restarts the 24 hours when the same station is voted for again', () => {
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
    rememberRadioBrowserVote('uuid-a')

    vi.setSystemTime(new Date('2026-09-07T11:00:00Z'))
    rememberRadioBrowserVote('uuid-a')

    vi.setSystemTime(new Date('2026-09-08T10:00:00Z'))
    expect(recentRadioBrowserVotes().has('uuid-a')).toBe(true)
  })

  /** A vote is a note about an action, not a setting - unreadable storage
   * costs one refused vote, never an error on screen. */
  it('starts from nothing when what was stored cannot be read', () => {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), 'not json at all')

    expect(recentRadioBrowserVotes()).toEqual(new Set())
  })

  it('ignores a stored entry that is not a timestamp', () => {
    localStorage.setItem(
      accountScopedKey(STORAGE_KEY),
      JSON.stringify({ 'uuid-a': 'yesterday', 'uuid-b': Date.now() }),
    )

    expect(recentRadioBrowserVotes()).toEqual(new Set(['uuid-b']))
  })
})
