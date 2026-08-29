import { describe, expect, it } from 'vitest'
import { createSequenceGuard } from '../sequenceGuard'

describe('sequenceGuard', () => {
  it('the token from the only begin() so far is current', () => {
    const guard = createSequenceGuard()
    const token = guard.begin()
    expect(guard.isCurrent(token)).toBe(true)
  })

  it('an earlier token is no longer current once a later begin() has run', () => {
    const guard = createSequenceGuard()
    const first = guard.begin()
    guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
  })

  it('the latest token is current even after earlier ones exist', () => {
    const guard = createSequenceGuard()
    guard.begin()
    guard.begin()
    const latest = guard.begin()
    expect(guard.isCurrent(latest)).toBe(true)
  })

  it('models a slow older call resolving after a newer, faster one already won', () => {
    const guard = createSequenceGuard()
    const older = guard.begin() // e.g. the first of two rapid clicks
    const newer = guard.begin() // second click, resolves first
    expect(guard.isCurrent(newer)).toBe(true)
    expect(guard.isCurrent(older)).toBe(false) // older's late resolution must not win
  })
})
