import { defineStore } from 'pinia'
import { fetchRadioStationInfo, type RadioStationInfo } from '@/services/connect/radio'
import { radioBrowserIdFor } from '@/services/radioBrowserLinks'
import type { RadioStation } from '@/types/library'

// Bumped by reset(), so an answer still on its way for the previous
// account cannot land in the next one's state.
let generation = 0

/** RadioView.vue's per-station extras (tags, country, codec, last title
 * heard), keyed by stream URL. */
export const useRadioStationInfoStore = defineStore('radioStationInfo', {
  state: () => ({
    byUrl: {} as Record<string, RadioStationInfo>,
    /** Whether the last load has answered, successfully or not. */
    settled: false,
  }),
  actions: {
    infoFor(station: RadioStation): RadioStationInfo | null {
      return this.byUrl[station.streamUrl] ?? null
    },

    /** Asked afresh on every visit, since the last title heard changes with
     * listening; connect answers the directory half from its own cache.
     * What is known stays up meanwhile, and a failure keeps it. */
    async load(stations: RadioStation[]): Promise<void> {
      const startedIn = generation
      const urls = [...new Set(stations.map((station) => station.streamUrl).filter(Boolean))]
      if (!urls.length) {
        this.settled = true
        return
      }
      try {
        const info = await fetchRadioStationInfo(
          urls.map((url) => ({ url, uuid: radioBrowserIdFor(url) })),
        )
        if (startedIn !== generation) return
        this.byUrl = info
      } catch (error) {
        console.warn('[radio] Could not load station details', error)
      } finally {
        if (startedIn === generation) this.settled = true
      }
    },

    reset(): void {
      generation++
      this.byUrl = {}
      this.settled = false
    },
  },
})
