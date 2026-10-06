import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { PartyRefusal, tabId, usePartyStore, wishInsertIndex } from '../party'
import { useRemoteControlStore } from '../remoteControl'
import { useConnectStore } from '../connect'
import {
  claimPartyHost,
  enableParty,
  getPartyStatus,
  type PartyStatus,
} from '@/services/party/http'
import { usePlaybackStore } from '../playback'
import { makeSong } from './fixtures'

vi.mock('@/services/party/http', () => ({
  enableParty: vi.fn(),
  rotatePartyLink: vi.fn(),
  disableParty: vi.fn().mockResolvedValue({ success: true }),
  getPartyStatus: vi.fn(),
  claimPartyHost: vi.fn(),
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

  it('moves a song already coming up forward instead of queueing it twice', () => {
    const { playback, party } = setup(['now', 'host1', 'host2', 'x'])
    party.wish(makeSong('x'), 'anna', 'Anna', 3)
    expect(ids(playback)).toEqual(['now', 'x', 'host1', 'host2'])
    expect(party.requestAt(1)?.guestName).toBe('Anna')
  })

  it('leaves a song where it is when it comes sooner than the wish would', () => {
    const { playback, party } = setup(['now', 'host'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 5)
    party.wish(makeSong('b1'), 'ben', 'Ben', 5)
    party.wish(makeSong('a2'), 'anna', 'Anna', 5)
    playback.insertAt(2, [makeSong('x')])
    expect(ids(playback)).toEqual(['now', 'a1', 'x', 'b1', 'a2', 'host'])
    // Anna's third wish would go after a2; x is already well ahead of that.
    party.wish(makeSong('x'), 'anna', 'Anna', 5)
    expect(ids(playback)).toEqual(['now', 'a1', 'x', 'b1', 'a2', 'host'])
    expect(party.requestAt(2)?.guestName).toBe('Anna')
  })

  it('queues a song that already played again, as its own entry', () => {
    const { playback, party } = setup(['x', 'now'], 1)
    const played = playback.queue[0]!
    party.wish(played, 'anna', 'Anna', 3)
    expect(ids(playback)).toEqual(['x', 'now', 'x'])
    expect(party.requestAt(2)?.guestName).toBe('Anna')
    expect(party.requestAt(0)).toBeNull()
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

describe('inviteUrl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  function startedParty() {
    const party = usePartyStore()
    party.inviteToken = 'tok'
    party.lanIp = '192.168.1.20'
    party.port = 9181
    return party
  }

  it('points the web build at the address the host has it open under', () => {
    expect(startedParty().inviteUrl).toBe(`${window.location.origin}/party/#t=tok`)
  })

  it("points the desktop app at this machine's LAN address", () => {
    ;(window as { api?: unknown }).api = {}
    expect(startedParty().inviteUrl).toBe('http://192.168.1.20:9181/party/#t=tok')
  })

  it('a stale address saved by an older version changes nothing', () => {
    localStorage.setItem(
      'beacon_party_settings',
      JSON.stringify({ publicUrl: 'https://x.example' }),
    )
    expect(startedParty().inviteUrl).toBe(`${window.location.origin}/party/#t=tok`)
  })

  it('has no link before the party has a token', () => {
    expect(usePartyStore().inviteUrl).toBeNull()
  })
})

describe('which window hosts the party', () => {
  function status(hostTab: string | null, enabled = true): PartyStatus {
    return {
      enabled,
      expires_at: enabled ? Date.now() / 1000 + 3600 : null,
      lan_ip: '192.168.1.20',
      port: 9181,
      guests: [],
      max_pending_per_guest: 3,
      skip_ratio: 0.5,
      host_tab: hostTab,
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.spyOn(useRemoteControlStore(), 'startRelay').mockImplementation(() => {})
    vi.spyOn(useRemoteControlStore(), 'stopRelayUnlessNeeded').mockImplementation(() => {})
  })

  afterEach(() => {
    usePartyStore().stopped()
    vi.restoreAllMocks()
  })

  it('names this window as the host when it starts the party', async () => {
    vi.mocked(enableParty).mockResolvedValue({ ...status(tabId()), token: 'tok' })
    await usePartyStore().enable()
    expect(vi.mocked(enableParty).mock.calls[0]![0].tab_id).toBe(tabId())
    expect(usePartyStore().hostedHere).toBe(true)
  })

  it('learns of a party another window started, without answering its guests', async () => {
    vi.mocked(getPartyStatus).mockResolvedValue(status('another-tab'))
    const party = usePartyStore()
    await party.refreshStatus()
    expect(party.enabled).toBe(true)
    expect(party.hostedHere).toBe(false)
    expect(useRemoteControlStore().startRelay).not.toHaveBeenCalled()
  })

  it('picks its own party back up after a reload, link included', async () => {
    vi.mocked(getPartyStatus).mockResolvedValue(status(tabId()))
    vi.mocked(claimPartyHost).mockResolvedValue({ ...status(tabId()), token: 'tok' })
    const party = usePartyStore()
    await party.refreshStatus()
    expect(party.hostedHere).toBe(true)
    expect(party.inviteToken).toBe('tok')
  })

  it('takes the party over by telling connect it is this window', async () => {
    vi.mocked(getPartyStatus).mockResolvedValue(status('another-tab'))
    vi.mocked(claimPartyHost).mockResolvedValue({ ...status(tabId()), token: 'tok' })
    const party = usePartyStore()
    await party.refreshStatus()
    await party.takeOver()
    expect(claimPartyHost).toHaveBeenCalledWith(tabId())
    expect(party.hostedHere).toBe(true)
    // The party's own link, so nobody already there has to scan again.
    expect(party.inviteToken).toBe('tok')
  })

  it('lets go once another window has taken over', async () => {
    vi.mocked(getPartyStatus).mockResolvedValue(status(tabId()))
    vi.mocked(claimPartyHost).mockResolvedValue({ ...status(tabId()), token: 'tok' })
    const party = usePartyStore()
    await party.refreshStatus()
    party.applyStatus(status('another-tab'))
    expect(party.hostedHere).toBe(false)
    expect(party.enabled).toBe(true)
    expect(useRemoteControlStore().stopRelayUnlessNeeded).toHaveBeenCalled()
  })
})

describe('wishes while the host casts', () => {
  function cast(position: number, name: string, id = `r-${position}`) {
    return { id, position, guest_id: name.toLowerCase(), guest_name: name, requested_at: 1 }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    vi.spyOn(useRemoteControlStore(), 'startRelay').mockImplementation(() => {})
    vi.spyOn(useRemoteControlStore(), 'stopRelayUnlessNeeded').mockImplementation(() => {})
  })

  afterEach(() => {
    usePartyStore().stopped()
    vi.restoreAllMocks()
  })

  it("shows connect's wishes in this window's queue", () => {
    const { party } = setup(['now', 'a1', 'h1'])
    party.applyCastRequests([cast(1, 'Anna')])
    expect(party.requestAt(1)?.guestName).toBe('Anna')
    expect(party.requestAt(2)).toBeNull()
  })

  it('hands the wishes it had to connect when the cast begins', () => {
    const { party } = setup(['now', 'h1'])
    party.wish(makeSong('a1'), 'anna', 'Anna', 3)
    party.applyCastRequests([cast(1, 'Anna', 'from-connect')])
    expect(party.requests).toEqual([])
    expect(party.requestAt(1)?.id).toBe('from-connect')
  })

  it('takes the wishes back when the cast ends', () => {
    const { playback, party } = setup(['now', 'a1', 'h1'])
    party.applyCastRequests([cast(1, 'Anna')])
    party.applyCastRequests(undefined)
    expect(party.castRequests).toBeNull()
    expect(party.requests.map((r) => r.song)).toEqual([playback.queue[1]])
    // Its own again: the next local edit carries it along.
    playback.reorderQueue(1, 2)
    expect(party.requestAt(2)?.guestName).toBe('Anna')
  })

  it('leaves out a wish that has played', () => {
    const { playback, party } = setup(['now', 'a1', 'h1'])
    party.applyCastRequests([cast(1, 'Anna')])
    playback.currentIndex = 2
    expect(party.activeRequests).toEqual([])
  })

  it("follows the cast session's status while hosting", async () => {
    setup(['now', 'a1', 'h1'])
    vi.mocked(enableParty).mockResolvedValue({
      enabled: true,
      expires_at: Date.now() / 1000 + 3600,
      lan_ip: '',
      port: 0,
      guests: [],
      max_pending_per_guest: 3,
      skip_ratio: 0.5,
      host_tab: tabId(),
      token: 'tok',
    })
    const party = usePartyStore()
    await party.enable()
    useConnectStore().status = { party_requests: [cast(1, 'Anna')] } as never
    await vi.waitFor(() => expect(party.requestAt(1)?.guestName).toBe('Anna'))
  })
})
