import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { getAudioEngine } from '@/services/audioEngine'
import {
  isActive,
  flatSetting,
  sanitizeSetting,
  toBands,
  type EqualizerBand,
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
}

function load(): EqualizerState {
  return { local: read(LOCAL_KEY, sanitizeSetting), speakers: read(SPEAKERS_KEY, sanitizeSpeakers) }
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
     * the account and, while casting, to the session: connect then uses
     * them from the next song on (see applyToSpeakerNow() for sooner). */
    setSpeakers(speakers: Record<string, EqualizerSetting>): void {
      this.speakers = sanitizeSpeakers(speakers)
      write(SPEAKERS_KEY, this.speakers)
      const speakerEqualizers = this.speakers
      const castPayload = this.castPayload
      // Dynamic imports: both modules reach back into the stores.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ speakerEqualizers }).catch(() => {}),
      )
      void import('@/stores/connect').then(({ useConnectStore }) => {
        if (!useConnectStore().isActive) return
        void import('@/services/connect/playback').then(({ updateEqualizers }) =>
          updateEqualizers(castPayload).catch(() => {}),
        )
      })
    },

    /** See services/accountScopedStores.ts. */
    reloadForAccount(): void {
      const next = load()
      this.local = next.local
      this.speakers = next.speakers
      this.applyLocal()
    },
  },
})
