import { defineStore } from 'pinia'
import {
  getExternalSources,
  type ExternalSource,
  type ExternalSources,
} from '@/services/connect/externalSource'

/** The external sources that are set up, for the navigation and the tabs.
 * Loaded once a layout mounts, and replaced by the settings after a change. */
export const useExternalSourceStore = defineStore('externalSource', {
  state: () => ({
    loaded: false,
    mayConfigure: false,
    sources: [] as ExternalSource[],
    loading: null as Promise<void> | null,
  }),
  getters: {
    byId:
      (state) =>
      (id: string): ExternalSource | undefined =>
        state.sources.find((source) => source.id === id),
  },
  actions: {
    ensureLoaded(): Promise<void> {
      if (this.loaded) return Promise.resolve()
      this.loading ??= this.load().finally(() => {
        this.loading = null
      })
      return this.loading
    },
    async load(): Promise<void> {
      try {
        this.set(await getExternalSources())
      } catch (error) {
        // An older connect without the route, or one that is restarting:
        // no tabs, nothing else breaks.
        console.warn('[external-source] Could not load:', error)
      }
    },
    set(state: ExternalSources): void {
      this.mayConfigure = state.may_configure
      this.sources = state.sources
      this.loaded = true
    },
  },
})
