import { defineStore } from 'pinia'
import {
  forgetBridge,
  getLights,
  pairBridge,
  updateLights,
  type LightsState,
  type LightsUpdate,
} from '@/services/connect/lights'

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
    async update(update: LightsUpdate): Promise<void> {
      this.lights = await updateLights(update)
    },
    async forget(): Promise<void> {
      await forgetBridge()
      await this.load()
    },
  },
})
