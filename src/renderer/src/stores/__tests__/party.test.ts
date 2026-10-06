import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { PartyRefusal, usePartyStore, wishInsertIndex } from '../party'
import { usePlaybackStore } from '../playback'
import { makeSong } from './fixtures'

vi.mock('@/services/party/http', () => ({
  enableParty: vi.fn(),
  rotatePartyLink: vi.fn(),
  disableParty: vi.fn().mockResolvedValue({ success: true }),
  getPartyStatus: vi.fn(),
  updatePartySettings: vi.fn(),
  kickPartyGuest: vi.fn(),
}))

function setup(queueIds: string[], currentIndex = 0) {
  const playback = usePlaybackStore()
  playback.queue = queueIds.map((id) => makeSong(id))
  playback.originalQueue = [...playback.queue]
  playback.currentIndex = currentIndex
  return { playback, party: usePartyStore() }
}

function ids(playback: ReturnType<typeof usePlaybackStore>): string[] {
  return playback.queue.map((s) => s.id)
}

function refusal(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof PartyRefusal ? error.code : `unexpected: ${String(error)}`
  }
}

describe('party wishes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('lands right after the current song, ahead of what the host queued', () => {
    const { playback, party } = setup(['now', 'host1', 'host2'])
    party.wish(makeSong('w1'), 'anna', 'Anna', 3)
    expect(ids(playback)).toEqual(['now', 'w1', 'host1', 'host2'])
  })

  it('takes turns between guests', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 5)
    party.wish(makeSong('a2'), 'anna', 'Anna', 5)
    party.wish(makeSong('a3'), 'anna', 'Anna', 5)
    party.wish(makeSong('b1'), 'ben', 'Ben', 5)
    party.wish(makeSong('c1'), 'cleo', 'Cleo', 5)
    party.wish(makeSong('b2'), 'ben', 'Ben', 5)
    expect(ids(playback)).toEqual(['now', 'a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'host'])
  })

  it('keeps the unshuffled order in step', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 5)
    party.wish(makeSong('a2'), 'anna', 'Anna', 5)
    party.wish(makeSong('b1'), 'ben', 'Ben', 5)
    expect(playback.originalQueue.map((s) => s.id)).toEqual(['now', 'a1', 'b1', 'a2', 'host'])
  })

  it('refuses beyond the per-guest limit, counting only songs still ahead', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 2)
    party.wish(makeSong('a2'), 'anna', 'Anna', 2)
    expect(refusal(() => party.wish(makeSong('a3'), 'anna', 'Anna', 2))).toBe('limit')
    // Another guest is unaffected.
    expect(refusal(() => party.wish(makeSong('b1'), 'ben', 'Ben', 2))).toBeNull()
    // Once a1 is playing it no longer counts against Anna.
    playback.currentIndex = 1
    expect(refusal(() => party.wish(makeSong('a3'), 'anna', 'Anna', 2))).toBeNull()
  })

  it('refuses while a radio station plays, leaving the queue alone', () => {
    const { playback, party } = setup(['now'])
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://s.example',
      homePageUrl: null,
    }
    expect(refusal(() => party.wish(makeSong('a1'), 'anna', 'Anna', 3))).toBe('radio')
    expect(ids(playback)).toEqual(['now'])
  })

  it('refuses a song that is already wished for', () => {
    const { party } = setup(['now'])
    party.wish(makeSong('x'), 'anna', 'Anna', 3)
    expect(refusal(() => party.wish(makeSong('x'), 'ben', 'Ben', 3))).toBe('duplicate')
  })

  it('makes a wish its own queue entry even for a song queued already', () => {
    const { playback, party } = setup(['now', 'x'])
    const sameObject = playback.queue[1]!
    party.wish(sameObject, 'anna', 'Anna', 3)
    expect(ids(playback)).toEqual(['now', 'x', 'x'])
    expect(party.requestAt(1)?.guestName).toBe('Anna')
    expect(party.requestAt(2)).toBeNull()
  })

  it('appends when nothing is playing', () => {
    const { playback, party } = setup([], -1)
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    expect(ids(playback)).toEqual(['a1'])
  })

  it('reports where each request sits for the guest snapshot', () => {
    const { party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    const requests = party.snapshotRequests()
    expect(Object.keys(requests)).toEqual(['1'])
    expect(requests['1']).toMatchObject({ guest_id: 'anna', guest_name: 'Anna' })
  })
})

describe('withdrawing a wish', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('removes the guest’s own pending wish', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    const id = party.requests[0]!.id
    party.withdraw(id, 'anna')
    expect(ids(playback)).toEqual(['now', 'host'])
    expect(party.requests).toEqual([])
  })

  it('refuses someone else’s wish', () => {
    const { playback, party } = setup(['now'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    const id = party.requests[0]!.id
    expect(refusal(() => party.withdraw(id, 'ben'))).toBe('forbidden')
    expect(ids(playback)).toEqual(['now', 'a1'])
  })

  it('refuses a wish that is already playing', () => {
    const { playback, party } = setup(['now'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    const id = party.requests[0]!.id
    playback.currentIndex = 1
    expect(refusal(() => party.withdraw(id, 'anna'))).toBe('not-found')
    expect(ids(playback)).toEqual(['now', 'a1'])
  })
})

describe('keeping requests current', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('forgets requests once played or removed by the host', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    party.wish(makeSong('b1'), 'ben', 'Ben', 3)
    playback.removeFromQueue(2) // the host drops b1
    playback.currentIndex = 2 // a1 has played, host is on
    party.prune()
    expect(party.requests).toEqual([])
  })

  it('keeps the request of the song playing now', () => {
    const { playback, party } = setup(['now'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    playback.currentIndex = 1
    party.prune()
    expect(party.requestAt(1)?.guestName).toBe('Anna')
  })
})

describe('wishInsertIndex', () => {
  it('starts right after the current song', () => {
    expect(wishInsertIndex([], 'a', 4)).toBe(5)
  })

  it('puts a newcomer after everyone’s first wish', () => {
    const pending = [
      { guestId: 'a', position: 1 },
      { guestId: 'b', position: 2 },
      { guestId: 'a', position: 3 },
    ]
    expect(wishInsertIndex(pending, 'c', 0)).toBe(3)
    expect(wishInsertIndex(pending, 'b', 0)).toBe(4)
  })
})

describe('PartyRefusal', () => {
  it('reads as its bare code, which is what the relay hands connect', () => {
    expect(String(new PartyRefusal('limit'))).toBe('limit')
  })
})
