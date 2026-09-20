import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAdvancedModeStore } from '../advancedMode'

describe('advancedMode store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('is off for anyone who has never switched it on', () => {
    // The whole point: the person who did not set the server up never
    // meets the setup controls without asking for them.
    expect(useAdvancedModeStore().enabled).toBe(false)
  })

  it('remembers being switched on', () => {
    const store = useAdvancedModeStore()
    store.setEnabled(true)

    store.enabled = false
    store.reloadForAccount()

    expect(store.enabled).toBe(true)
  })

  it('remembers being switched back off', () => {
    const store = useAdvancedModeStore()
    store.setEnabled(true)
    store.setEnabled(false)

    store.enabled = true
    store.reloadForAccount()

    expect(store.enabled).toBe(false)
  })

  it('stays off when localStorage cannot be read', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(useAdvancedModeStore().enabled).toBe(false)
    } finally {
      Storage.prototype.getItem = original
    }
  })
})
