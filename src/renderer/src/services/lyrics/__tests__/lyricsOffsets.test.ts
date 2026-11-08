// The corrections are handwork: they follow the account, and neither side
// gets to quietly lose what the other one has.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  pullLyricsOffsets,
  pushOffset,
  readStoredOffset,
  resetLyricsOffsetsForTests,
  writeStoredOffset,
} from '../lyricsOffsets'
import { fetchConnect } from '@/services/connect/http'
import { useAuthStore } from '@/stores/auth'

vi.mock('@/services/connect/http', () => ({ fetchConnect: vi.fn() }))

const put = () =>
  vi
    .mocked(fetchConnect)
    .mock.calls.filter(([, options]) => options?.method === 'PUT')
    .map(([, options]) => (options!.body as { offsets: Record<string, number> }).offsets)

function serverHas(offsets: Record<string, number>) {
  vi.mocked(fetchConnect).mockImplementation(async (_path, options) =>
    options?.method === 'PUT' ? {} : ({ offsets } as never),
  )
}

describe('lyrics corrections', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetLyricsOffsetsForTests()
    vi.mocked(fetchConnect).mockReset()
    serverHas({})
    const auth = useAuthStore()
    auth.serverUrl = 'https://music.example'
    auth.username = 'alice'
    auth.authenticated = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes over corrections made elsewhere', async () => {
    serverHas({ s1: 1.5 })
    await pullLyricsOffsets()
    expect(readStoredOffset('s1')).toBe(1.5)
  })

  it('lets the account win over an older value here', async () => {
    writeStoredOffset('s1', 9)
    serverHas({ s1: 1.5 })
    await pullLyricsOffsets()
    expect(readStoredOffset('s1')).toBe(1.5)
    expect(put()).toEqual([])
  })

  it('takes back a correction undone elsewhere', async () => {
    writeStoredOffset('s1', 9)
    serverHas({ s1: 0 })
    await pullLyricsOffsets()
    expect(readStoredOffset('s1')).toBe(0)
  })

  it('sends up what only this device knows', async () => {
    writeStoredOffset('mine', 2)
    await pullLyricsOffsets()
    expect(put()).toEqual([{ mine: 2 }])
    expect(readStoredOffset('mine')).toBe(2)
  })

  it('sends a large backlog in pieces connect accepts', async () => {
    for (let i = 0; i < 1001; i++) writeStoredOffset(`s${i}`, 1)
    await pullLyricsOffsets()
    expect(put().map((batch) => Object.keys(batch).length)).toEqual([500, 500, 1])
  })

  it('does not overwrite a change still on its way', async () => {
    vi.useFakeTimers()
    writeStoredOffset('s1', 3)
    pushOffset('s1', 3)
    serverHas({ s1: 1 })
    await pullLyricsOffsets()
    expect(readStoredOffset('s1')).toBe(3)
  })

  it('collects a burst of nudges into one request', async () => {
    vi.useFakeTimers()
    pushOffset('s1', 0.1)
    pushOffset('s1', 0.2)
    pushOffset('s1', 0.3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(put()).toEqual([{ s1: 0.3 }])
  })

  it('sends a correction set back to zero', async () => {
    vi.useFakeTimers()
    pushOffset('s1', 0)
    await vi.advanceTimersByTimeAsync(1500)
    expect(put()).toEqual([{ s1: 0 }])
  })

  it('survives the request failing', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchConnect).mockRejectedValue(new Error('offline'))
    pushOffset('s1', 1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(console.error).toHaveBeenCalled()
  })

  describe('when a change cannot be delivered right away', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('tries again, so that an undo still reaches the account', async () => {
      vi.mocked(fetchConnect).mockRejectedValueOnce(new Error('offline'))
      pushOffset('s1', 0)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(put()).toEqual([{ s1: 0 }, { s1: 0 }])
    })

    it('stops once it has got through', async () => {
      vi.mocked(fetchConnect).mockRejectedValueOnce(new Error('offline'))
      pushOffset('s1', 0)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(put()).toHaveLength(2)
    })

    it('does not let an old value overtake a newer one', async () => {
      let refuse: (error: Error) => void = () => {}
      vi.mocked(fetchConnect).mockImplementationOnce(
        () => new Promise((_resolve, reject) => (refuse = reject)),
      )
      pushOffset('s1', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      pushOffset('s1', 2)
      refuse(new Error('offline'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(put().at(-1)).toEqual({ s1: 2 })
    })

    it("does not put a failed change among the next account's", async () => {
      let refuse: (error: Error) => void = () => {}
      vi.mocked(fetchConnect).mockImplementationOnce(
        () => new Promise((_resolve, reject) => (refuse = reject)),
      )
      pushOffset('s1', 3)
      await vi.advanceTimersByTimeAsync(1_000)
      useAuthStore().username = 'bob'
      pushOffset('s2', 4)
      refuse(new Error('offline'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(put().at(-1)).toEqual({ s2: 4 })
    })

    it('does not retry into the next account', async () => {
      vi.mocked(fetchConnect).mockRejectedValueOnce(new Error('offline'))
      pushOffset('s1', 3)
      await vi.advanceTimersByTimeAsync(1_000)
      useAuthStore().username = 'bob'
      await vi.advanceTimersByTimeAsync(30_000)
      expect(put()).toHaveLength(1)
    })
  })

  it('does not send a waiting change with the next account', async () => {
    vi.useFakeTimers()
    pushOffset('s1', 3)
    useAuthStore().username = 'bob'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(put()).toEqual([])
  })

  it("does not mix the next account's change with the last one's", async () => {
    vi.useFakeTimers()
    pushOffset('s1', 3)
    useAuthStore().username = 'bob'
    pushOffset('s2', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(put()).toEqual([{ s2: 4 }])
  })

  it('keeps the answer away from whoever logged in while asking', async () => {
    writeStoredOffset('s1', 7)
    vi.mocked(fetchConnect).mockImplementation(async () => {
      useAuthStore().username = 'bob'
      return { offsets: { s1: 1 } } as never
    })
    await pullLyricsOffsets()
    expect(readStoredOffset('s1')).toBe(0)
    useAuthStore().username = 'alice'
    expect(readStoredOffset('s1')).toBe(7)
  })
})
