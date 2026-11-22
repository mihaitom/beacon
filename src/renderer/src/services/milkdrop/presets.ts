import type { MilkdropPreset } from 'butterchurn'

/** A preset file as it sits in assets/milkdrop/presets/: Butterchurn's
 * converted preset plus the name its author gave it, which the file name
 * cannot carry (it is a slug, so it survives every file system). */
export interface MilkdropPresetFile {
  name: string
  preset: MilkdropPreset
}

// Lazy, one chunk per preset: only the one on screen is ever downloaded.
const PRESET_FILES = import.meta.glob<MilkdropPresetFile>('@/assets/milkdrop/presets/*.json', {
  import: 'default',
})

/** Every preset Beacon ships, by file path - sorted, so a seed picks the
 * same preset on every machine. */
export const MILKDROP_PRESET_KEYS: readonly string[] = Object.keys(PRESET_FILES).sort()

/** The preset a seed in [0, 1) stands for, never the one already showing
 * when there is any other: a new song that rolled the current preset again
 * would look like no change at all. */
export function pickPresetKey(
  keys: readonly string[],
  seed: number,
  current: string | null,
): string | null {
  if (keys.length === 0) return null
  const index = Math.min(keys.length - 1, Math.floor(seed * keys.length))
  const key = keys[index]!
  if (key !== current || keys.length === 1) return key
  return keys[(index + 1) % keys.length]!
}

export async function loadPresetFile(key: string): Promise<MilkdropPresetFile> {
  const load = PRESET_FILES[key]
  if (!load) throw new Error(`Unknown Milkdrop preset: ${key}`)
  return load()
}
