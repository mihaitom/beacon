import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { radioBrowserIdFor, rememberRadioBrowserStation } from '../radioBrowserLinks'

describe('radioBrowserLinks', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('gives back the id a station was remembered with', () => {
    rememberRadioBrowserStation('http://stream.example/a', 'uuid-a')

    expect(radioBrowserIdFor('http://stream.example/a')).toBe('uuid-a')
  })

  it('has nothing for a station that was never seen in the directory', () => {
    expect(radioBrowserIdFor('http://stream.example/by-hand')).toBeNull()
  })

  it('keeps the id current when the same station is seen again', () => {
    rememberRadioBrowserStation('http://stream.example/a', 'uuid-old')
    rememberRadioBrowserStation('http://stream.example/a', 'uuid-new')

    expect(radioBrowserIdFor('http://stream.example/a')).toBe('uuid-new')
  })

  /** The cap only exists so this cannot grow without bound; the oldest
   * link is the one worth losing. */
  it('drops the oldest links past its cap and keeps the newest', () => {
    for (let i = 0; i < 205; i++) {
      rememberRadioBrowserStation(`http://stream.example/${i}`, `uuid-${i}`)
    }

    expect(radioBrowserIdFor('http://stream.example/0')).toBeNull()
    expect(radioBrowserIdFor('http://stream.example/4')).toBeNull()
    expect(radioBrowserIdFor('http://stream.example/5')).toBe('uuid-5')
    expect(radioBrowserIdFor('http://stream.example/204')).toBe('uuid-204')
  })

  /** A lost link costs a click report, never playback, so nothing here is
   * worth throwing over. */
  it('survives storage that cannot be read or written', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })

    expect(() => rememberRadioBrowserStation('http://stream.example/a', 'uuid-a')).not.toThrow()
    expect(radioBrowserIdFor('http://stream.example/a')).toBeNull()

    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('ignores stored rubbish rather than trusting it', () => {
    localStorage.setItem('beacon.radio-browser-links', 'not json at all')

    expect(radioBrowserIdFor('http://stream.example/a')).toBeNull()
  })
})
