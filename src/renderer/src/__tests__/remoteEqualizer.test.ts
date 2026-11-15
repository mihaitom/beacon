import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

const REMOTE = resolve(__dirname, '../../../../connect/static/remote')

const GAINS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function equalizerAnswer() {
  return {
    targets: [{ type: 'sonos', name: 'Kitchen' }],
    settings: { 'sonos:Kitchen': { enabled: true, gains: GAINS } },
    presets: [],
    built_in: [
      { name: 'flat', gains: GAINS },
      { name: 'bass', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    ],
  }
}

/** The equalizer is opened over the whole page. The regression this pins
 * was that it could be opened and then not left again: no Done, and a
 * close control that did nothing. */
describe("the Remote Control's equalizer", () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function open() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => equalizerAnswer() })),
    )
    const { openEqualizer } = await import(
      /* @vite-ignore */ pathToFileURL(resolve(REMOTE, 'js/equalizer.js')).href
    )
    openEqualizer()
    await vi.waitFor(() => expect(document.querySelector('.eq-dialog__footer')).not.toBeNull())
    return document.querySelector('.eq-overlay')!
  }

  it('closes from its Done button', async () => {
    await open()

    document.querySelector<HTMLButtonElement>('.eq-done')!.click()

    expect(document.querySelector('.eq-overlay')).toBeNull()
  })

  it('closes from Escape too', async () => {
    await open()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.querySelector('.eq-overlay')).toBeNull()
  })
})
