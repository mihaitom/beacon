import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A fresh copy of the module, as a new page load gets. */
async function pageLoad(): Promise<typeof import('../deviceLimits')> {
  vi.resetModules()
  return import('../deviceLimits')
}

describe('deviceLimits', () => {
  beforeEach(() => localStorage.clear())

  it('remembers a preset this device could not draw, once', async () => {
    const limits = await pageLoad()
    limits.markTooHeavy('builtin:a')
    limits.markTooHeavy('builtin:a')
    expect([...(await pageLoad()).tooHeavyHere()]).toEqual(['builtin:a'])
  })

  it('lets a hand-picked preset try again', async () => {
    const limits = await pageLoad()
    limits.markTooHeavy('builtin:a')
    limits.forgetTooHeavy('builtin:a')
    expect(limits.tooHeavyHere().size).toBe(0)
  })

  it('takes a start that never finished as too heavy at the next load', async () => {
    ;(await pageLoad()).noteStarting('builtin:hang')
    const next = await pageLoad()
    expect(next.tooHeavyHere().has('builtin:hang')).toBe(true)
  })

  it('does not count a start that finished, or one this load made itself', async () => {
    const first = await pageLoad()
    first.noteStarting('builtin:fine')
    first.clearStarting('builtin:fine')
    const second = await pageLoad()
    expect(second.tooHeavyHere().size).toBe(0)
    second.noteStarting('builtin:now')
    expect(second.tooHeavyHere().size).toBe(0)
  })

  it('clears only the start it was asked to', async () => {
    const limits = await pageLoad()
    limits.noteStarting('builtin:b')
    limits.clearStarting('builtin:a')
    expect((await pageLoad()).tooHeavyHere().has('builtin:b')).toBe(true)
  })

  it('survives a broken list', async () => {
    localStorage.setItem('beacon.milkdrop.tooHeavy', '{nope')
    const limits = await pageLoad()
    expect(limits.tooHeavyHere().size).toBe(0)
    limits.markTooHeavy('builtin:a')
    expect(limits.tooHeavyHere().has('builtin:a')).toBe(true)
  })
})
