import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { getAudioEngine } from '@/services/audioEngine'
import {
  isActive,
  flatSetting,
  sanitizePresets,
  sanitizeSetting,
  toBands,
  type CustomPreset,
  type EqualizerBand,
  type EqualizerProfile,
  type EqualizerSetting,
} from '@/services/equalizer'
import type { ConnectDeviceRef } from '@/services/connect/types'

/** The equalizer for this device's own playback, and one per speaker.
 *
 * This device's curve stays on this device: it is about the headphones or
 * speakers plugged in here. A speaker's curve follows the account instead
 * (services/connect/accountSettings.ts), since it is about the speaker and
 * has to be the same whichever device starts the cast; connect gets it with
 * every /play and applies it in that speaker's own stream
 * (connect/core/equalizer.py). */

const LOCAL_KEY = 'beacon.equalizer.local'
const SPEAKERS_KEY = 'beacon.equalizer.speakers'
const PRESETS_KEY = 'beacon.equalizer.presets'

export function speakerKey(device: ConnectDeviceRef): string {
  return `${device.type}:${device.name}`
}

export function sanitizeSpeakers(value: unknown): Record<string, EqualizerSetting> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, setting]) => [
      key,
      sanitizeSetting(setting),
    ]),
  )
}

function read<T>(key: string, sanitize: (value: unknown) => T): T {
  try {
    const stored = localStorage.getItem(accountScopedKey(key))
    return sanitize(stored ? JSON.parse(stored) : null)
  } catch {
    return sanitize(null)
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(accountScopedKey(key), JSON.stringify(value))
  } catch {
    // Non-critical - the setting just doesn't survive to the next launch.
  }
}

interface EqualizerState {
  local: EqualizerSetting
  speakers: Record<string, EqualizerSetting>
  /** The listener's own presets, in the order they were first saved. They
   * follow the account like the speakers' curves. */
  presets: CustomPreset[]
}

function load(): EqualizerState {
  return {
    local: read(LOCAL_KEY, sanitizeSetting),
    speakers: read(SPEAKERS_KEY, sanitizeSpeakers),
    presets: read(PRESETS_KEY, sanitizePresets),
  }
}

export const useEqualizerStore = defineStore('equalizer', {
  state: (): EqualizerState => load(),
  getters: {
    speaker:
      (state) =>
      (device: ConnectDeviceRef): EqualizerSetting =>
        state.speakers[speakerKey(device)] ?? flatSetting(),
    /** Every speaker whose curve changes anything, as connect takes it. */
    castPayload: (state): Record<string, EqualizerBand[]> =>
      Object.fromEntries(
        Object.entries(state.speakers)
          .filter(([, setting]) => isActive(setting))
          .map(([key, setting]) => [key, toBands(setting)]),
      ),
  },
  actions: {
    setLocal(setting: EqualizerSetting): void {
      this.local = sanitizeSetting(setting)
      write(LOCAL_KEY, this.local)
      this.applyLocal()
    },

    /** This device's curve into the Web Audio graph - a no-op where there
     * is none (see webAudioAllowed() in services/audioEngine.ts). */
    applyLocal(): void {
      getAudioEngine().setEqualizer(isActive(this.local) ? toBands(this.local) : [])
    },

    setSpeaker(device: ConnectDeviceRef, setting: EqualizerSetting): void {
      this.setSpeakers({ ...this.speakers, [speakerKey(device)]: sanitizeSetting(setting) })
    },

    /** Also what a pull from another device lands in. Pushes the curves to
     * the account and, while casting, to the session: with transitions on
     * connect hears them straight away (the mix filters live), otherwise
     * from the next song on. */
    setSpeakers(speakers: Record<string, EqualizerSetting>): void {
      this.speakers = sanitizeSpeakers(speakers)
      write(SPEAKERS_KEY, this.speakers)
      // Dynamic imports: both modules reach back into the stores. What is
      // sent is read once they are there, not now: the first import can
      // land after a later one, and would otherwise send an older state.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ speakerEqualizers: this.speakers }).catch(() => {}),
      )
      void import('@/stores/connect').then(({ useConnectStore }) => {
        if (!useConnectStore().isActive) return
        void import('@/services/connect/playback').then(({ updateEqualizers }) =>
          updateEqualizers(this.castPayload).catch(() => {}),
        )
      })
    },

    /** Saves `gains` under `name`, over a preset of that name if there is
     * one - where it was, so saving again does not reorder the chips. */
    savePreset(name: string, gains: number[]): void {
      this.putPreset({ name, gains })
    },

    /** An imported profile, kept with the presets under its own name. */
    saveProfile(profile: EqualizerProfile): void {
      this.putPreset({ name: profile.name, gains: [], profile })
    },

    putPreset(entry: CustomPreset): void {
      const preset = sanitizePresets([entry])[0]
      if (!preset) return
      const index = this.presets.findIndex((p) => p.name === preset.name)
      const presets = [...this.presets]
      if (index >= 0) presets[index] = preset
      else presets.push(preset)
      this.setPresets(presets)
    },

    deletePreset(name: string): void {
      this.setPresets(this.presets.filter((p) => p.name !== name))
    },

    /** Also what a pull from another device lands in. */
    setPresets(presets: CustomPreset[]): void {
      this.presets = sanitizePresets(presets)
      write(PRESETS_KEY, this.presets)
      // Read when sent, as in setSpeakers().
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ equalizerPresets: this.presets }).catch(() => {}),
      )
    },

    /** See services/accountScopedStores.ts. */
    reloadForAccount(): void {
      const next = load()
      this.local = next.local
      this.speakers = next.speakers
      this.presets = next.presets
      this.applyLocal()
    },
  },
})
