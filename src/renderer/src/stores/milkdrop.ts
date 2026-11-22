import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { pushAccountSettings } from '@/services/connect/accountSettings'
import {
  deleteMilkdropPreset,
  listMilkdropPresets,
  putMilkdropPreset,
  type CustomMilkdropPreset,
} from '@/services/connect/milkdropPresets'
import { presetFromFile } from '@/services/milkdrop/convert'
import {
  BUILTIN_PRESETS,
  customPresetId,
  customPresetKey,
  type MilkdropPresetEntry,
} from '@/services/milkdrop/presets'

/** When Now Playing moves on to another preset by itself. */
export type MilkdropSwitch = 'fixed' | 'song' | 'time'

/** Frames per second at most; 0 is whatever the display runs at. */
export type MilkdropFps = 0 | 30 | 60

/** Follows the account (connect's account settings, and through them a
 * paired server) - see services/connect/accountSettings.ts. Whether
 * Milkdrop is on at all stays with the device, like which theme is. */
export interface MilkdropSettings {
  switchMode: MilkdropSwitch
  intervalSeconds: number
  /** What an automatic change picks from; empty picks from all. */
  preferred: string[]
  fps: MilkdropFps
  /** The preset chosen by hand: the one shown for good in 'fixed', the one
   * to start from otherwise. Null lets the first one be picked at random. */
  preset: string | null
}

export const MIN_INTERVAL_SECONDS = 15
export const MAX_INTERVAL_SECONDS = 600

const SETTINGS_KEY = 'beacon.milkdrop'

const DEFAULTS: MilkdropSettings = {
  switchMode: 'song',
  intervalSeconds: 60,
  preferred: [],
  fps: 0,
  preset: null,
}

/** Whatever is stored, or came over the wire from another build, as a
 * value this build can use - field by field, so one bad field does not
 * throw the others away. */
export function sanitizeMilkdropSettings(raw: unknown): MilkdropSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const switchMode = ['fixed', 'song', 'time'].includes(value.switchMode as string)
    ? (value.switchMode as MilkdropSwitch)
    : DEFAULTS.switchMode
  const interval = Number(value.intervalSeconds)
  const intervalSeconds = Number.isFinite(interval)
    ? Math.round(Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, interval)))
    : DEFAULTS.intervalSeconds
  const preferred = Array.isArray(value.preferred)
    ? [...new Set(value.preferred.filter((key): key is string => typeof key === 'string'))]
    : []
  const fps = [0, 30, 60].includes(value.fps as number) ? (value.fps as MilkdropFps) : DEFAULTS.fps
  const preset = typeof value.preset === 'string' ? value.preset : null
  return { switchMode, intervalSeconds, preferred, fps, preset }
}

function loadSettings(): MilkdropSettings {
  try {
    const stored = localStorage.getItem(accountScopedKey(SETTINGS_KEY))
    return sanitizeMilkdropSettings(stored ? JSON.parse(stored) : null)
  } catch {
    return { ...DEFAULTS }
  }
}

function randomId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

export interface UploadResult {
  added: string[]
  failed: string[]
}

export const useMilkdropStore = defineStore('milkdrop', {
  state: () => ({
    settings: loadSettings(),
    custom: [] as CustomMilkdropPreset[],
    customLoaded: false,
    /** Counts the presets picked by hand, for Now Playing to show each
     * at once (see choose). */
    chosen: 0,
  }),
  getters: {
    /** Every preset there is to pick from, the uploaded ones first. */
    presets(state): MilkdropPresetEntry[] {
      const custom = state.custom.map((preset) => ({
        key: customPresetKey(preset.id),
        name: preset.name,
        custom: true,
      }))
      return [...custom, ...BUILTIN_PRESETS]
    },
  },
  actions: {
    set(patch: Partial<MilkdropSettings>): void {
      this.settings = sanitizeMilkdropSettings({ ...this.settings, ...patch })
      try {
        localStorage.setItem(accountScopedKey(SETTINGS_KEY), JSON.stringify(this.settings))
      } catch {
        // Non-critical - worst case the choice doesn't survive to the next
        // launch on this device.
      }
      void pushAccountSettings({ milkdrop: this.settings }).catch(() => {})
    },

    /** A preset picked in the menu: shown now, and kept in 'fixed'. */
    choose(key: string): void {
      this.set({ preset: key })
      this.chosen++
    },

    togglePreferred(key: string): void {
      const preferred = this.settings.preferred.includes(key)
        ? this.settings.preferred.filter((other) => other !== key)
        : [...this.settings.preferred, key]
      this.set({ preferred })
    },

    async loadCustom(): Promise<void> {
      try {
        this.custom = await listMilkdropPresets()
        this.customLoaded = true
      } catch (error) {
        // The built-in presets work without connect's list.
        console.error('[milkdrop] Could not load the uploaded presets:', error)
      }
    },

    /** Converts and stores each file, one by one so a broken one costs only
     * itself. Says which went in and which did not, by file name. */
    async upload(files: readonly File[]): Promise<UploadResult> {
      const result: UploadResult = { added: [], failed: [] }
      for (const file of files) {
        try {
          const { name, preset } = await presetFromFile(file.name, await file.text())
          const id = randomId()
          await putMilkdropPreset(id, name, preset)
          this.custom = [...this.custom, { id, name }].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
          )
          result.added.push(name)
        } catch (error) {
          console.error('[milkdrop] Upload failed:', file.name, error)
          result.failed.push(file.name)
        }
      }
      return result
    },

    async remove(key: string): Promise<void> {
      const id = customPresetId(key)
      if (id === null) return
      await deleteMilkdropPreset(id)
      this.custom = this.custom.filter((preset) => preset.id !== id)
      if (this.settings.preferred.includes(key) || this.settings.preset === key) {
        this.set({
          preferred: this.settings.preferred.filter((other) => other !== key),
          preset: this.settings.preset === key ? null : this.settings.preset,
        })
      }
    },

    /** Applied from the account's settings at login - see
     * services/accountScopedStores.ts. */
    adopt(remote: unknown): void {
      this.set(sanitizeMilkdropSettings(remote))
    },

    /** state() runs once, at boot, before login has said whose settings
     * these are. */
    reloadForAccount(): void {
      this.settings = loadSettings()
      this.custom = []
      this.customLoaded = false
    },
  },
})
