import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { pushAccountSettings } from '@/services/connect/accountSettings'
import {
  deleteMilkdropPreset,
  listMilkdropPresets,
  putMilkdropPreset,
} from '@/services/connect/milkdropPresets'
import { presetFromFile } from '@/services/milkdrop/convert'
import {
  INTERVAL_STEPS,
  intervalStep,
  sanitizeMilkdropSettings,
  useMilkdropStore,
} from '../milkdrop'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/connect/milkdropPresets', () => ({
  listMilkdropPresets: vi.fn(),
  putMilkdropPreset: vi.fn().mockResolvedValue(undefined),
  deleteMilkdropPreset: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/milkdrop/convert', () => ({ presetFromFile: vi.fn() }))

const PRESET = { baseVals: { zoom: 1 } }

function file(name: string): File {
  return new File(['text'], name)
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  setActivePinia(createPinia())
})

describe('sanitizeMilkdropSettings', () => {
  it('keeps what is good and replaces only what is not', () => {
    expect(
      sanitizeMilkdropSettings({
        switchMode: 'time',
        intervalSeconds: 5,
        preferred: ['a', 7, 'a', 'b'],
        preset: 'builtin:x',
      }),
    ).toEqual({
      switchMode: 'time',
      intervalSeconds: 15,
      preferred: ['a', 'b'],
      preset: 'builtin:x',
    })
  })

  it('makes defaults out of nothing', () => {
    expect(sanitizeMilkdropSettings('nonsense').switchMode).toBe('song')
    expect(sanitizeMilkdropSettings({ intervalSeconds: 1e9 }).intervalSeconds).toBe(600)
  })
})

describe('the Milkdrop store', () => {
  it('keeps a change on this device and sends it to the account', () => {
    useMilkdropStore().set({ intervalSeconds: 90 })
    expect(vi.mocked(pushAccountSettings)).toHaveBeenCalledWith({
      milkdrop: expect.objectContaining({ intervalSeconds: 90 }),
    })
    setActivePinia(createPinia())
    expect(useMilkdropStore().settings.intervalSeconds).toBe(90)
  })

  it('toggles a preset in and out of the pool', () => {
    const store = useMilkdropStore()
    store.togglePreferred('builtin:a')
    store.togglePreferred('builtin:b')
    store.togglePreferred('builtin:a')
    expect(store.settings.preferred).toEqual(['builtin:b'])
  })

  it('counts every pick by hand, the same one again too', () => {
    const store = useMilkdropStore()
    store.choose('builtin:a')
    store.choose('builtin:a')
    expect(store.chosen).toBe(2)
    expect(store.settings.preset).toBe('builtin:a')
  })

  it('lists the uploaded presets ahead of the shipped ones', async () => {
    vi.mocked(listMilkdropPresets).mockResolvedValue([{ id: 'p1', name: 'Mine' }])
    const store = useMilkdropStore()
    await store.loadCustom()
    expect(store.presets[0]).toEqual({
      key: 'custom:p1',
      name: 'Mine',
      custom: true,
      demanding: false,
    })
    expect(store.presets.length).toBeGreaterThan(1)
  })

  it('uploads each file on its own, a broken one costing only itself', async () => {
    vi.mocked(presetFromFile).mockImplementation(async (name) => {
      if (name === 'broken.milk') throw new Error('nope')
      return { name: name.replace('.milk', ''), preset: PRESET }
    })
    const store = useMilkdropStore()
    const result = await store.upload([file('Zeta.milk'), file('broken.milk'), file('alpha.milk')])

    expect(result).toEqual({ added: ['Zeta', 'alpha'], failed: ['broken.milk'] })
    expect(vi.mocked(putMilkdropPreset)).toHaveBeenCalledTimes(2)
    expect(store.custom.map((preset) => preset.name)).toEqual(['alpha', 'Zeta'])
  })

  it('a deleted preset leaves the pool and the fixed choice too', async () => {
    vi.mocked(listMilkdropPresets).mockResolvedValue([{ id: 'p1', name: 'Mine' }])
    const store = useMilkdropStore()
    await store.loadCustom()
    store.set({ preferred: ['custom:p1', 'builtin:a'], preset: 'custom:p1' })

    await store.remove('custom:p1')

    expect(vi.mocked(deleteMilkdropPreset)).toHaveBeenCalledWith('p1')
    expect(store.custom).toEqual([])
    expect(store.settings.preferred).toEqual(['builtin:a'])
    expect(store.settings.preset).toBeNull()
  })

  it('a shipped preset cannot be deleted', async () => {
    await useMilkdropStore().remove('builtin:a')
    expect(vi.mocked(deleteMilkdropPreset)).not.toHaveBeenCalled()
  })

  it('takes the account settings over from another device', () => {
    const store = useMilkdropStore()
    store.adopt({ switchMode: 'fixed', intervalSeconds: 120 })
    expect(store.settings).toMatchObject({ switchMode: 'fixed', intervalSeconds: 120 })
  })
})

describe('intervalStep', () => {
  it('finds the timer step closest on a doubling scale', () => {
    expect(INTERVAL_STEPS[intervalStep(60)]).toBe(60)
    // Halfway between 60 and 90 on a plain scale, nearer 90 on a doubling one.
    expect(INTERVAL_STEPS[intervalStep(75)]).toBe(90)
    expect(INTERVAL_STEPS[intervalStep(500)]).toBe(420)
    expect(INTERVAL_STEPS[intervalStep(5)]).toBe(15)
    expect(INTERVAL_STEPS[intervalStep(1e9)]).toBe(600)
  })
})
