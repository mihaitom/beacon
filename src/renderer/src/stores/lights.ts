import { defineStore } from 'pinia'
import { themeAccent } from '@/services/appAccent'
import { useAppearanceStore } from '@/stores/appearance'
import {
  forgetBridge,
  getLights,
  getPicture,
  pairBridge,
  updateLights,
  type LightsState,
  type LightsUpdate,
} from '@/services/connect/lights'

/** This device's theme accent as `#rrggbb` - the colour the lights take in
 * "theme" mode, and for a picture without colour. */
export function themeColour(): string {
  return (
    '#' +
    themeAccent.value
      .split(',')
      .map((part) => Number(part.trim()).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** This device's theme as the lights take it in "theme" mode. */
export function themeSettings(): { theme_colour: string; theme_follows_picture: boolean } {
  return {
    theme_colour: themeColour(),
    theme_follows_picture: useAppearanceStore().adaptiveAccent,
  }
}

/** connect's Hue setup, for the toolbar's lights button and its dialog.
 * The button loads it (and keeps asking while there is no bridge yet), the
 * dialog again on every open, so neither shows an answer from before
 * connect was up. */
export const useLightsStore = defineStore('lights', {
  state: () => ({
    lights: null as LightsState | null,
    loadFailed: false,
    loading: false,
  }),
  getters: {
    /** Worth a button: a bridge is paired, or one is on the network. */
    available(state): boolean {
      return !!state.lights && (state.lights.paired || state.lights.found.length > 0)
    },
    /** Paired, switched on and an area picked. */
    active(state): boolean {
      const lights = state.lights
      return !!lights && lights.paired && lights.enabled && !!lights.area_id
    },
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.lights = await getLights()
        this.loadFailed = false
      } catch (error) {
        this.loadFailed = true
        console.error('[lights] Could not load the lights:', error)
      } finally {
        this.loading = false
      }
    },
    /** Rejects with connect's error; the dialog says what went wrong. */
    async pair(host: string): Promise<void> {
      this.lights = await pairBridge(host)
    },
    /** The picture alone, for the open dialog to follow track changes.
     * Quiet on failure: the dialog keeps the picture it has. */
    async refreshPicture(): Promise<void> {
      if (!this.lights?.paired) return
      try {
        const picture = await getPicture()
        if (this.lights) this.lights = { ...this.lights, picture }
      } catch (error) {
        console.error('[lights] Could not refresh the picture:', error)
      }
    },
    async update(update: LightsUpdate): Promise<void> {
      this.lights = await updateLights(update)
    },
    /** Tells connect this device's theme - its accent, and whether that
     * follows the picture - where connect has another one. Called where
     * somebody is looking at the lights here - the dialog opening, the
     * theme changing - not at every app start, or two devices on different
     * themes would keep taking it from each other. */
    async syncTheme(): Promise<void> {
      if (!this.lights?.paired) return
      const theme = themeSettings()
      if (
        theme.theme_colour === this.lights.theme_colour &&
        theme.theme_follows_picture === this.lights.theme_follows_picture
      ) {
        return
      }
      try {
        await this.update(theme)
      } catch (error) {
        console.error('[lights] Could not report the theme colour:', error)
      }
    },
    async forget(): Promise<void> {
      await forgetBridge()
      await this.load()
    },
  },
})
