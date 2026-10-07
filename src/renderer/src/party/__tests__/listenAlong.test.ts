import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListenAlongPlayer, type ListenState } from '../listenAlong'
import { partyApi } from '../api'

/** Just what the player touches of an <audio> element. */
class FakeAudio {
  src = ''
  volume = 1
  currentTime = 0
  paused = true
  preload = ''
  playResult: Promise<void> = Promise.resolve()
  onplaying: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onerror: (() => void) | null = null
  onended: (() => void) | null = null
  play() {
    this.paused = false
    return this.playResult
  }
  pause() {
    this.paused = true
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  load() {}
}

function setup() {
  const audio = new FakeAudio()
  const states: ListenState[] = []
  const player = new ListenAlongPlayer(
    (state) => states.push(state),
    () => audio as unknown as HTMLAudioElement,
  )
  return { audio, states, player }
}

function connId(src: string): string {
  return new URL(src, 'http://x').searchParams.get('c') ?? ''
}

describe('listening along', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(partyApi, 'listenStart').mockResolvedValue({ epoch: 'e1', start: 12 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens its own connection and learns where in the stream it starts', async () => {
    const { audio, player } = setup()
    player.play()
    expect(audio.src).toMatch(/^\/party\/api\/listen\?c=[0-9a-f]{24}$/)
    expect(player.state).toBe('connecting')
    audio.onplaying?.()
    await vi.waitFor(() => expect(player.heardTime()).toBe(12))
    expect(partyApi.listenStart).toHaveBeenCalledWith(connId(audio.src))
    audio.currentTime = 3.5
    expect(player.heardTime()).toBe(15.5)
    expect(player.epoch).toBe('e1')
  })

  it('asks again until connect has handed the connection its first audio', async () => {
    vi.mocked(partyApi.listenStart)
      .mockResolvedValueOnce({ epoch: 'e1', start: null })
      .mockResolvedValueOnce({ epoch: 'e1', start: 4 })
    const { audio, player } = setup()
    player.play()
    audio.onplaying?.()
    await vi.advanceTimersByTimeAsync(400)
    expect(player.heardTime()).toBe(4)
  })

  it('holds a stalled stream before giving the connection up', async () => {
    const { audio, player } = setup()
    player.play()
    audio.onplaying?.()
    const first = audio.src
    await vi.advanceTimersByTimeAsync(5000)
    expect(player.state).toBe('buffering')
    expect(audio.src).toBe(first)
    await vi.advanceTimersByTimeAsync(16_000)
    // Given up: a new connection after the first step of the ladder.
    await vi.advanceTimersByTimeAsync(1000)
    expect(audio.src).not.toBe('')
    expect(audio.src).not.toBe(first)
  })

  it('a stream that moves again is playing again', async () => {
    const { audio, player } = setup()
    player.play()
    audio.onplaying?.()
    await vi.advanceTimersByTimeAsync(5000)
    expect(player.state).toBe('buffering')
    audio.currentTime = 6
    audio.ontimeupdate?.()
    expect(player.state).toBe('playing')
  })

  it('reconnects a dropped stream, with growing pauses', async () => {
    const { audio, player } = setup()
    player.play()
    audio.onerror?.()
    expect(audio.src).toBe('')
    await vi.advanceTimersByTimeAsync(1000)
    const second = audio.src
    expect(second).not.toBe('')
    audio.onerror?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(audio.src).toBe('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(audio.src).not.toBe('')
    expect(audio.src).not.toBe(second)
  })

  it('a refused start needs a new tap', async () => {
    const { audio, player } = setup()
    audio.playResult = Promise.reject(new DOMException('no', 'NotAllowedError'))
    player.play()
    await vi.advanceTimersByTimeAsync(0)
    expect(player.state).toBe('failed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(audio.src).toBe('')
  })

  it('reconnects to a new stream when connect started one', async () => {
    const { audio, player } = setup()
    player.play()
    audio.onplaying?.()
    await vi.waitFor(() => expect(player.epoch).toBe('e1'))
    const first = audio.src
    player.followEpoch('e1')
    expect(audio.src).toBe(first)
    player.followEpoch('e2')
    expect(audio.src).not.toBe(first)
  })

  it('stopping lets go of the connection', () => {
    const { audio, player, states } = setup()
    player.play()
    player.stop()
    expect(audio.src).toBe('')
    expect(audio.paused).toBe(true)
    expect(states.at(-1)).toBe('off')
    expect(player.heardTime()).toBeNull()
  })
})

describe('the guest’s volume', () => {
  it('applies to the element now and to the next connection', () => {
    const { audio, player } = setup()
    player.setVolume(0.3)
    player.play()
    expect(audio.volume).toBe(0.3)
    player.setVolume(0.6)
    expect(audio.volume).toBe(0.6)
  })
})
