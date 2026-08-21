import { describe, expect, it } from 'vitest'
import { createLock } from '../lock'

describe('lock', () => {
  it('starts unlocked', () => {
    expect(createLock().isLocked()).toBe(false)
  })

  it('is locked after acquire()', () => {
    const lock = createLock()
    lock.acquire()
    expect(lock.isLocked()).toBe(true)
  })

  it('is unlocked again after release()', () => {
    const lock = createLock()
    lock.acquire()
    lock.release()
    expect(lock.isLocked()).toBe(false)
  })

  it('release() without a prior acquire() is a harmless no-op', () => {
    const lock = createLock()
    lock.release()
    expect(lock.isLocked()).toBe(false)
  })
})
