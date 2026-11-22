import { describe, expect, it } from 'vitest'
import { MILKDROP_PRESET_KEYS, loadPresetFile, pickPresetKey } from '../presets'

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

describe('the shipped presets', () => {
  // Butterchurn compiles a preset's equations the same way when loading it;
  // one that fails there would leave the previous preset frozen on screen.
  it('each load with a name and equations that compile', async () => {
    expect(MILKDROP_PRESET_KEYS.length).toBeGreaterThan(0)
    for (const key of MILKDROP_PRESET_KEYS) {
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
