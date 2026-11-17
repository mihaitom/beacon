import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import type { GroupVolumeMode } from '@/services/groupVolume'

const MODE_KEY = 'beacon.group-volume-mode'

/** 'equal' unless chosen otherwise: uneven rooms are what the master was
 * asked for in the first place. */
function loadMode(): GroupVolumeMode {
  try {
    return localStorage.getItem(accountScopedKey(MODE_KEY)) === 'relative' ? 'relative' : 'equal'
  } catch {
    return 'equal'
  }
}

/** How the master volume moves several speakers - see services/groupVolume.ts. */
export const useGroupVolumeStore = defineStore('groupVolume', {
  state: () => ({
    mode: loadMode(),
  }),
  actions: {
    setMode(mode: GroupVolumeMode): void {
      this.mode = mode
      try {
        localStorage.setItem(accountScopedKey(MODE_KEY), mode)
      } catch {
        // Worst case the choice doesn't survive to the next launch.
      }
    },
    /** See services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.mode = loadMode()
    },
  },
})
