import { describe, expect, it, vi } from 'vitest'
import { getMilkdropPreset } from '@/services/connect/milkdropPresets'
import {
  BUILTIN_PRESETS,
  customPresetId,
  customPresetKey,
  loadPresetFile,
  pickPresetKey,
  presetPool,
} from '../presets'

vi.mock('@/services/connect/milkdropPresets', () => ({ getMilkdropPreset: vi.fn() }))

describe('pickPresetKey', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('maps a seed across the whole list', () => {
    expect(pickPresetKey(keys, 0, null)).toBe('a')
    expect(pickPresetKey(keys, 0.5, null)).toBe('c')
    expect(pickPresetKey(keys, 0.999, null)).toBe('d')
  })

  it('never rolls the preset already showing', () => {
    expect(pickPresetKey(keys, 0.3, 'b')).toBe('c')
    expect(pickPresetKey(keys, 0.9, 'd')).toBe('a')
  })

  it('keeps the only preset there is, and has none without any', () => {
    expect(pickPresetKey(['a'], 0.4, 'a')).toBe('a')
    expect(pickPresetKey([], 0.4, null)).toBeNull()
  })
})

describe('presetPool', () => {
  const all = ['a', 'b', 'c'].map((key) => ({ key, name: key, custom: false }))

  it('is the preferred presets that still exist', () => {
    expect(presetPool(all, ['c', 'gone', 'a'])).toEqual(['a', 'c'])
  })

  it('is every preset while none of the preferred ones is there', () => {
    expect(presetPool(all, [])).toEqual(['a', 'b', 'c'])
    expect(presetPool(all, ['gone'])).toEqual(['a', 'b', 'c'])
  })
})

describe('uploaded presets', () => {
  it('are told apart from the shipped ones by their key', () => {
    expect(customPresetId(customPresetKey('abc'))).toBe('abc')
    expect(customPresetId(BUILTIN_PRESETS[0]!.key)).toBeNull()
  })

  it('come from connect, once each, and again after a failure', async () => {
    const get = vi.mocked(getMilkdropPreset)
    get.mockRejectedValueOnce(new Error('down'))
    await expect(loadPresetFile(customPresetKey('x1'))).rejects.toThrow('down')
    get.mockResolvedValue({ id: 'x1', name: 'Mine', preset: { baseVals: {} } })
    await loadPresetFile(customPresetKey('x1'))
    const again = await loadPresetFile(customPresetKey('x1'))
    expect(again).toEqual({ name: 'Mine', preset: { baseVals: {} } })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('an unknown key is an error, not a silent blank', async () => {
    await expect(loadPresetFile('builtin:no-such-preset')).rejects.toThrow()
  })
})

describe('the shipped presets', () => {
  // Butterchurn compiles a preset's equations the same way when loading it;
  // one that fails there would leave the previous preset frozen on screen.
  it('each load with a name and equations that compile', async () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThan(0)
    for (const { key } of BUILTIN_PRESETS) {
      const { name, preset } = await loadPresetFile(key)
      expect(name, key).toBeTruthy()
      for (const field of ['init_eqs_str', 'frame_eqs_str', 'pixel_eqs_str']) {
        const code = preset[field]
        expect(typeof code, `${key} ${field}`).toBe('string')
        expect(() => new Function('a', `${code as string} return a;`), key).not.toThrow()
      }
    }
  })
})
