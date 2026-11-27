import { describe, expect, it, vi } from 'vitest'
// Sets the helpers the equations call (pow, above, ...) on window.
import '@/services/milkdrop/butterchurn'
import { getMilkdropPreset } from '@/services/connect/milkdropPresets'
import {
  BUILTIN_PRESETS,
  customPresetId,
  customPresetKey,
  loadPresetFile,
  isRetiredPreset,
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
  const all = ['a', 'b', 'c'].map((key) => ({ key, name: key, custom: false, demanding: false }))

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

  // The party guest page's Content-Security-Policy forbids `new Function`:
  // Butterchurn builds none for a preset whose equations are functions
  // already (see vite.milkdrop-presets.ts).
  it('arrive with their equations compiled, and work the same', async () => {
    for (const { key } of BUILTIN_PRESETS) {
      const { preset } = await loadPresetFile(key)
      expect(typeof preset.init_eqs, key).toBe('function')
      expect(typeof preset.frame_eqs, key).toBe('function')
      for (const shape of preset.shapes as {
        baseVals: { enabled?: number }
        frame_eqs?: unknown
      }[]) {
        if (shape.baseVals.enabled !== 0) expect(typeof shape.frame_eqs, key).toBe('function')
      }
    }
    const { preset } = await loadPresetFile('builtin:geiss-spiral-artifact')
    const run = (eqs: unknown) =>
      (eqs as (a: Record<string, number>) => Record<string, number>)({
        time: 1,
        rot_sum: 0,
        q2: 0.1,
        q3: 1,
        zoom: 1,
        wave_r: 0,
        wave_g: 0,
        wave_b: 0,
      })
    const evaluated = new Function('a', `${preset.frame_eqs_str as string} return a;`)
    expect(run(preset.frame_eqs)).toEqual(run(evaluated))
  })
})

describe('isRetiredPreset', () => {
  it('lets go of a built-in Beacon no longer ships, never of one it does or an upload', () => {
    expect(isRetiredPreset('builtin:no-such-preset')).toBe(true)
    expect(isRetiredPreset(BUILTIN_PRESETS[0]!.key)).toBe(false)
    expect(isRetiredPreset(customPresetKey('abc'))).toBe(false)
  })
})
