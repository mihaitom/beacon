import { defineStore } from 'pinia'
import { getExternalSource, type ExternalSource } from '@/services/connect/externalSource'

/** Whether an external source is set up, for the navigation and the tab.
 * Loaded once a layout mounts, and replaced by the settings section after
 * a change. */
export const useExternalSourceStore = defineStore('externalSource', {
  state: () => ({
    source: null as ExternalSource | null,
    loading: null as Promise<void> | null,
  }),
  getters: {
    configured: (state): boolean => !!state.source?.configured,
    name: (state): string => state.source?.name ?? '',
  },
  actions: {
    ensureLoaded(): Promise<void> {
      if (this.source) return Promise.resolve()
      this.loading ??= this.load().finally(() => {
        this.loading = null
      })
      return this.loading
    },
    async load(): Promise<void> {
      try {
        this.source = await getExternalSource()
      } catch (error) {
        // An older connect without the route, or one that is restarting:
        // no tab, nothing else breaks.
        console.warn('[external-source] Could not load:', error)
      }
    },
    set(source: ExternalSource): void {
      this.source = source
    },
  },
})
