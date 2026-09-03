import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPollGate,
  backoffRemainingMs,
  isBackingOff,
  noteResponseStatus,
  pollingAllowed,
} from '../pollGate'

function headers(values: Record<string, string> = {}): { get(name: string): string | null } {
  return { get: (name) => values[name] ?? null }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

describe('pollGate', () => {
  beforeEach(() => {
    _resetPollGate()
    setVisibility('visible')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetPollGate()
  })

  it('lets polling through when nothing is wrong', () => {
    expect(pollingAllowed()).toBe(true)
  })

  it('stops polling while the window is hidden', () => {
    setVisibility('hidden')
    expect(pollingAllowed()).toBe(false)
    // Not a denial, so anything that polls for someone else's benefit (the
    // phone's own view, see remoteControl.ts) still may.
    expect(isBackingOff()).toBe(false)
  })

  describe('being denied by something in front of the backend', () => {
    it('stands polling down after a bare 403', () => {
      noteResponseStatus(403, headers(), null)
      expect(isBackingOff()).toBe(true)
      expect(pollingAllowed()).toBe(false)
    })

    it('stands polling down after a 429', () => {
      noteResponseStatus(429, headers(), null)
      expect(isBackingOff()).toBe(true)
    })

    it("ignores the backend's own 403, which carries a reason", () => {
      // routes/devices.py's SERVER_LOCK rejection is a real, legitimate 403
      // — parking every poll in the app over a configuration message would
      // be a self-inflicted outage.
      noteResponseStatus(403, headers(), 'Server URL does not match the locked server')
      expect(isBackingOff()).toBe(false)
    })

    it('waits longer each time it is denied again', () => {
      noteResponseStatus(403, headers(), null)
      const first = backoffRemainingMs()
      vi.advanceTimersByTime(first)
      noteResponseStatus(403, headers(), null)
      expect(backoffRemainingMs()).toBeGreaterThan(first)
    })

    it('starts over once a request works again', () => {
      noteResponseStatus(403, headers(), null)
      const first = backoffRemainingMs()
      noteResponseStatus(200, headers(), null)
      expect(isBackingOff()).toBe(false)

      noteResponseStatus(403, headers(), null)
      expect(backoffRemainingMs()).toBe(first)
    })

    it('ends on its own once the wait is over', () => {
      noteResponseStatus(403, headers(), null)
      vi.advanceTimersByTime(backoffRemainingMs() + 1)
      expect(isBackingOff()).toBe(false)
      expect(pollingAllowed()).toBe(true)
    })

    it('honours a Retry-After longer than its own step', () => {
      noteResponseStatus(429, headers({ 'Retry-After': '120' }), null)
      expect(backoffRemainingMs()).toBe(120_000)
    })

    it('accepts Retry-After as an HTTP date', () => {
      const when = new Date(Date.now() + 90_000).toUTCString()
      noteResponseStatus(429, headers({ 'Retry-After': when }), null)
      // Whole-second resolution in the header, so allow for the rounding.
      expect(backoffRemainingMs()).toBeGreaterThan(85_000)
      expect(backoffRemainingMs()).toBeLessThanOrEqual(90_000)
    })

    it('never lets Retry-After shorten its own step', () => {
      noteResponseStatus(429, headers({ 'Retry-After': '1' }), null)
      expect(backoffRemainingMs()).toBeGreaterThan(1_000)
    })

    it('ignores an absurd Retry-After rather than parking the app for an hour', () => {
      noteResponseStatus(429, headers({ 'Retry-After': '86400' }), null)
      expect(backoffRemainingMs()).toBeLessThanOrEqual(600_000)
    })

    it('ignores a Retry-After it cannot make sense of', () => {
      noteResponseStatus(429, headers({ 'Retry-After': 'soon' }), null)
      expect(backoffRemainingMs()).toBeGreaterThan(0)
    })
  })
})
