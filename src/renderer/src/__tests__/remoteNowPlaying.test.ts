import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

/** The Remote Control is plain JS outside the renderer's tsconfig, so it is
 * imported by URL rather than as a module TypeScript has to have types for —
 * the same route remoteI18n.test.ts takes to its locale files. */
const REMOTE = resolve(__dirname, '../../../../connect/static/remote')

const SONG = {
  id: 's1',
  title: 'A song',
  artist: 'Someone',
  artist_id: 'ar1',
  album: 'An album',
  album_id: 'al1',
  cover_art_url: null,
  cover_art_id: null,
  duration: 200,
  starred: false,
}

/** The Remote Control's Now Playing is plain JS with no tests of its own in
 * connect/. This is the smoke test that catches the failures that leave a
 * screen dead rather than merely wrong: a missing element while the view
 * wires itself up used to throw before a single transport button had a
 * listener, so the page rendered and then ignored every tap. */
describe("the Remote Control's Now Playing", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header class="app-bar">
        <i class="mdi mdi-lighthouse-on"></i>
        <span class="app-bar__title">Beacon</span>
        <span id="app-bar-actions" class="app-bar__actions"></span>
      </header>
      <main id="view-root"></main>
    `
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function mount() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ source: null, backgrounds: [], is_artist: false }),
      })),
    )
    const [{ renderNowPlaying }, { setSnapshot }] = await Promise.all([
      import(/* @vite-ignore */ pathToFileURL(resolve(REMOTE, 'js/views/now-playing.js')).href),
      import(/* @vite-ignore */ pathToFileURL(resolve(REMOTE, 'js/state.js')).href),
    ])
    const root = document.getElementById('view-root')!
    const cleanup = renderNowPlaying(root)
    setSnapshot({
      playing: false,
      current_song: SONG,
      radio: null,
      queue: [SONG],
      queue_index: 0,
      casting: [],
      volume: 1,
    })
    return { root, cleanup }
  }

  it('puts its toolbar in the app bar and still wires the transport', async () => {
    const { cleanup } = await mount()

    expect(document.querySelector('#app-bar-actions #np-toolbar')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('#np-play')!.click()
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/remote/command',
      expect.objectContaining({ method: 'POST' }),
    )

    cleanup()
    expect(document.querySelector('#app-bar-actions #np-toolbar')).toBeNull()
  })
})
