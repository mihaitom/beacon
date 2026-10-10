import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUpdateStore } from '../update'

/** The dot on the settings button: on for a version Settings hasn't shown
 * yet, out once it has, and on again for the next one. */
describe('update store — the settings dot', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  function announce(version: string) {
    const store = useUpdateStore()
    store.available = true
    store.latestVersion = version
    return store
  }

  it('stays out while there is no newer version', () => {
    expect(useUpdateStore().unseen).toBe(false)
  })

  it('lights up for a newer version', () => {
    expect(announce('2.0.0').unseen).toBe(true)
  })

  it('goes out once Settings has shown it, and stays out after a restart', () => {
    announce('2.0.0').markSeen()
    expect(useUpdateStore().unseen).toBe(false)

    setActivePinia(createPinia())
    expect(announce('2.0.0').unseen).toBe(false)
  })

  it('lights up again for the release after that', () => {
    announce('2.0.0').markSeen()
    expect(announce('2.0.1').unseen).toBe(true)
  })

  /** Settings open while nothing is out must not swallow the next release:
   * there was nothing to have seen. */
  it('is not put out in advance by a visit with nothing to show', () => {
    useUpdateStore().markSeen()
    expect(announce('2.0.0').unseen).toBe(true)
  })

  /** The storage key is the one the update toast used to dismiss a version
   * under; a version dismissed there has been seen. */
  it('stays out for a version the old update toast was dismissed for', () => {
    localStorage.setItem('beacon.update-dismissed-version', '2.0.0')
    setActivePinia(createPinia())
    expect(announce('2.0.0').unseen).toBe(false)
  })
})
