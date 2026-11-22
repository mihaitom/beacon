import type { MilkdropPreset } from 'butterchurn'
import BUILTIN_INDEX from '@/assets/milkdrop/index.json'
import { getMilkdropPreset } from '@/services/connect/milkdropPresets'
import type { OrbitTarget } from '@/services/milkdrop/orbits'
import type { MilkdropCaption } from '@/services/milkdrop/captions'

/** A preset file as it sits in assets/milkdrop/presets/: Butterchurn's
 * converted preset plus the name its author gave it, which the file name
 * cannot carry (it is a slug, so it survives every file system). */
export interface MilkdropPresetFile {
  name: string
  preset: MilkdropPreset
  /** Points a preset of Beacon's own zooms into deeper than floats reach,
   * one row each of its `sampler_orbit` - see orbits.ts. */
  orbits?: OrbitTarget[]
  /** What a preset of Beacon's own can say about what is on screen - see
   * captions.ts. */
  captions?: MilkdropCaption[]
  /** Whether it reports how far it has zoomed in - see captions.ts. */
  reportsZoom?: boolean
}

/** One preset to pick from: one Beacon ships (`builtin:<slug>`) or one the
 * listener uploaded (`custom:<id>`, kept by connect). */
export interface MilkdropPresetEntry {
  key: string
  name: string
  custom: boolean
}

const BUILTIN_PREFIX = 'builtin:'
const CUSTOM_PREFIX = 'custom:'

// Lazy, one chunk per preset: only the one on screen is ever downloaded.
// The names come from index.json, so the list needs none of these loaded.
const PRESET_FILES = import.meta.glob<MilkdropPresetFile>('@/assets/milkdrop/presets/*.json', {
  import: 'default',
})

function builtinFile(slug: string): (() => Promise<MilkdropPresetFile>) | undefined {
  return Object.entries(PRESET_FILES).find(([path]) => path.endsWith(`/${slug}.json`))?.[1]
}

export const BUILTIN_PRESETS: readonly MilkdropPresetEntry[] = (
  BUILTIN_INDEX as { slug: string; name: string }[]
).map(({ slug, name }) => ({ key: BUILTIN_PREFIX + slug, name, custom: false }))

export function customPresetKey(id: string): string {
  return CUSTOM_PREFIX + id
}

/** The connect id behind a custom preset's key, or null for a built-in one. */
export function customPresetId(key: string): string | null {
  return key.startsWith(CUSTOM_PREFIX) ? key.slice(CUSTOM_PREFIX.length) : null
}

/** Whether a stored key names a built-in preset Beacon no longer ships, so
 * a choice saved before an update is let go rather than leaving the
 * picture empty. */
export function isRetiredPreset(key: string): boolean {
  return key.startsWith(BUILTIN_PREFIX) && !BUILTIN_PRESETS.some((entry) => entry.key === key)
}

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

/** What an automatic change picks from: the preferred presets that still
 * exist, or every preset while none is preferred. */
export function presetPool(
  all: readonly MilkdropPresetEntry[],
  preferred: readonly string[],
): string[] {
  const keys = all.map((entry) => entry.key)
  const wanted = new Set(preferred)
  const pool = keys.filter((key) => wanted.has(key))
  return pool.length > 0 ? pool : keys
}

// Uploaded presets don't change under their id once stored (a change is a
// new upload), so one fetch per session is enough.
const customCache = new Map<string, Promise<MilkdropPresetFile>>()

export async function loadPresetFile(key: string): Promise<MilkdropPresetFile> {
  const id = customPresetId(key)
  if (id !== null) {
    let pending = customCache.get(id)
    if (!pending) {
      pending = getMilkdropPreset(id).then(({ name, preset }) => ({ name, preset }))
      customCache.set(id, pending)
      pending.catch(() => customCache.delete(id))
    }
    return pending
  }
  const load = key.startsWith(BUILTIN_PREFIX)
    ? builtinFile(key.slice(BUILTIN_PREFIX.length))
    : undefined
  if (!load) throw new Error(`Unknown Milkdrop preset: ${key}`)
  return load()
}
