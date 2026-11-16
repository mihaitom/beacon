import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconnectingEventSource } from '../reconnectingEventSource'

vi.mock('../pollGate', () => ({ backoffRemainingMs: () => 0 }))

/** Just enough of an EventSource to drive by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, Array<() => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.()
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener()
  }
}

const HEARTBEAT = { event: 'heartbeat', staleAfterMs: 10000 }

function latest(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!
}

describe('ReconnectingEventSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('with heartbeats', () => {
    /** The connection that died without an error: open, and then nothing.
     * Reported live 2026-11-16 as a cast going on to the next song while
     * the app stayed on the last one, its position run up to the end. */
    it('replaces a connection that went silent after a heartbeat', () => {
      const onError = vi.fn()
      const source = new ReconnectingEventSource(
        '/events',
        { onMessage: vi.fn(), onError },
        HEARTBEAT,
      )
      source.start()
      const first = latest()
      first.open()
      first.emit('heartbeat')

      vi.advanceTimersByTime(10000)

      expect(first.closed).toBe(true)
      expect(onError).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2000)
      expect(FakeEventSource.instances).toHaveLength(2)
      source.stop()
    })

    it('keeps a connection that goes on delivering status', () => {
      const onMessage = vi.fn()
      const source = new ReconnectingEventSource('/events', { onMessage }, HEARTBEAT)
      source.start()
      const first = latest()
      first.open()
      first.emit('heartbeat')

      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(2000)
        first.message('{}')
      }

      expect(first.closed).toBe(false)
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(onMessage).toHaveBeenCalledTimes(20)
      source.stop()
    })

    it('keeps a quiet connection that goes on sending heartbeats', () => {
      const source = new ReconnectingEventSource('/events', { onMessage: vi.fn() }, HEARTBEAT)
      source.start()
      const first = latest()
      first.open()

      for (let i = 0; i < 20; i++) {
        first.emit('heartbeat')
        vi.advanceTimersByTime(2000)
      }

      expect(first.closed).toBe(false)
      source.stop()
    })

    /** An older server sends comments, which never reach the page: its
     * quiet would look exactly like a dead line. */
    it('leaves a server that never sent a heartbeat alone', () => {
      const source = new ReconnectingEventSource('/events', { onMessage: vi.fn() }, HEARTBEAT)
      source.start()
      const first = latest()
      first.open()
      first.message('{}')

      vi.advanceTimersByTime(60000)

      expect(first.closed).toBe(false)
      expect(FakeEventSource.instances).toHaveLength(1)
      source.stop()
    })

    it('waits for the replacement to show heartbeats before watching it', () => {
      const source = new ReconnectingEventSource('/events', { onMessage: vi.fn() }, HEARTBEAT)
      source.start()
      const first = latest()
      first.open()
      first.emit('heartbeat')
      vi.advanceTimersByTime(10000)
      vi.advanceTimersByTime(2000)
      const second = latest()
      second.open()

      vi.advanceTimersByTime(60000)

      expect(second).not.toBe(first)
      expect(second.closed).toBe(false)
      source.stop()
    })

    it('stops watching once stopped', () => {
      const source = new ReconnectingEventSource('/events', { onMessage: vi.fn() }, HEARTBEAT)
      source.start()
      const first = latest()
      first.open()
      first.emit('heartbeat')
      source.stop()

      vi.advanceTimersByTime(60000)

      expect(FakeEventSource.instances).toHaveLength(1)
    })
  })

  it('watches nothing without heartbeat options', () => {
    const source = new ReconnectingEventSource('/events', { onMessage: vi.fn() })
    source.start()
    const first = latest()
    first.open()
    first.emit('heartbeat')

    vi.advanceTimersByTime(60000)

    expect(first.closed).toBe(false)
    source.stop()
  })
})
