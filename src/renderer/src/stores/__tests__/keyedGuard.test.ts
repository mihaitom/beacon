import { describe, expect, it } from 'vitest'
import { createKeyedGuard } from '../keyedGuard'

describe('keyedGuard', () => {
  it('has no current key and nothing in flight before the first begin()', () => {
    const guard = createKeyedGuard<string>()
    expect(guard.hasAny()).toBe(false)
    expect(guard.isCurrent('a')).toBe(false)
  })

  it('is current for the key it was begun with', () => {
    const guard = createKeyedGuard<string>()
    guard.begin('a')
    expect(guard.isCurrent('a')).toBe(true)
    expect(guard.hasAny()).toBe(true)
  })

  it('a different key is not current once another has begun', () => {
    const guard = createKeyedGuard<string>()
    guard.begin('a')
    expect(guard.isCurrent('b')).toBe(false)
  })

  it('a new begin() supersedes the previous key', () => {
    const guard = createKeyedGuard<string>()
    guard.begin('a')
    guard.begin('b')
    expect(guard.isCurrent('a')).toBe(false)
    expect(guard.isCurrent('b')).toBe(true)
  })

  it('end() clears the key when it is still current', () => {
    const guard = createKeyedGuard<string>()
    guard.begin('a')
    guard.end('a')
    expect(guard.hasAny()).toBe(false)
    expect(guard.isCurrent('a')).toBe(false)
  })

  it('end() is a no-op for a key that has already been superseded — the classic stale-cleanup race', () => {
    const guard = createKeyedGuard<string>()
    guard.begin('a')
    guard.begin('b') // a newer call takes over before the older one's finally runs
    guard.end('a') // the older call's own cleanup must not stomp 'b'
    expect(guard.isCurrent('b')).toBe(true)
    expect(guard.hasAny()).toBe(true)
  })
})
