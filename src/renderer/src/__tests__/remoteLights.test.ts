import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

const REMOTE = resolve(__dirname, '../../../../connect/static/remote')

function lightsState() {
  return {
    paired: true,
    found: [],
    bridge: { host: '192.0.2.10', id: 'bridge' },
    reachable: true,
    areas: [{ id: 'area-1', name: 'Living room', lights: 3 }],
    area_id: 'area-1',
    enabled: false,
    lead_ms: 0,
    style: 'pulse',
    colour_mode: 'theme',
    fixed_colour: '#ff8800',
    theme_colour: '#ff8800',
    theme_follows_picture: false,
    brightness: 80,
    picture: null,
    playing: false,
    start_error: null,
  }
}

/** The Hue dialog is a second, independent sheet over Now Playing. It has
 * the same way out as the equalizer, and its switch has to reach connect
 * rather than only moving on screen. */
describe("the Remote Control's Hue dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the setup, saves a change and closes from Done', async () => {
    let state = lightsState()
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/remote/lights/update') {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>
        state = { ...state, ...(body.update as object) }
      }
      return { ok: true, status: 200, json: async () => state }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { openLights } = await import(
      /* @vite-ignore */ pathToFileURL(resolve(REMOTE, 'js/lights.js')).href
    )
    openLights()

    await vi.waitFor(() => expect(document.querySelector('.eq-switch input')).not.toBeNull())
    document.querySelector<HTMLInputElement>('.eq-switch input')!.click()

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/remote/lights/update',
        expect.objectContaining({ method: 'POST' }),
      ),
    )

    document.querySelector<HTMLButtonElement>('.lights-done')!.click()
    expect(document.querySelector('.eq-overlay')).toBeNull()
  })
})
