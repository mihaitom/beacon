import { describe, expect, it, vi } from 'vitest'
import { presetFromFile } from '../convert'

const PRESET = { baseVals: { zoom: 1 }, frame_eqs_str: '' }

describe('presetFromFile', () => {
  it('converts a .milk file and names it after the file', async () => {
    const convertPreset = vi.fn().mockResolvedValue(PRESET)
    const result = await presetFromFile('Geiss - Swirl.milk', '[preset00]', async () => ({
      convertPreset,
    }))
    expect(convertPreset).toHaveBeenCalledWith('[preset00]')
    expect(result).toEqual({ name: 'Geiss - Swirl', preset: PRESET })
  })

  it('takes a Butterchurn .json as it is, and a Beacon one with its name', async () => {
    const never = vi.fn()
    expect(await presetFromFile('a.json', JSON.stringify(PRESET), never)).toEqual({
      name: 'a',
      preset: PRESET,
    })
    const named = JSON.stringify({ name: 'Real name', preset: PRESET })
    expect((await presetFromFile('a.json', named, never)).name).toBe('Real name')
    expect(never).not.toHaveBeenCalled()
  })

  it('refuses what is not a preset', async () => {
    await expect(presetFromFile('a.json', '{"x":1}')).rejects.toThrow()
    await expect(presetFromFile('a.json', 'not json')).rejects.toThrow()
    const converter = async () => ({ convertPreset: vi.fn().mockResolvedValue({}) })
    await expect(presetFromFile('a.milk', 'garbage', converter)).rejects.toThrow()
  })
})
