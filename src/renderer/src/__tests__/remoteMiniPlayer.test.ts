import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** The Remote Control's mini player (connect/static/remote/js/mini-player.js),
 * driven from here with real DOM - it has no test runner of its own. */

const REMOTE = resolve(__dirname, '../../../../connect/static/remote/js')
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(resolve(REMOTE, file)).href)

let setSnapshot: (snapshot: Record<string, unknown>) => void
const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))

const song = (id: string, title: string) => ({ id, title, artist: 'Artist', cover_art_url: null })
const text = (id: string) => document.getElementById(id)!.textContent

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="mini-player" class="hidden">
      <div id="mini-art"></div><div id="mini-title"></div><div id="mini-subtitle"></div>
      <button id="mini-prev"></button><button id="mini-play"></button><button id="mini-next"></button>
    </div>`
  vi.stubGlobal('fetch', fetchMock)
  location.hash = '#/queue'
  ;({ setSnapshot } = await load('state.js'))
  ;(await load('mini-player.js')).initMiniPlayer()
})

beforeEach(() => {
  fetchMock.mockClear()
  setSnapshot({ current_song: null, radio: null, queue: [], playing: false })
})

/** What the last command the phone sent was. */
function lastCommand() {
  const body = (fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body
  return JSON.parse(String(body))
}

describe("the Remote Control's mini player", () => {
  it('stays, empty, with nothing loaded at all', () => {
    expect(document.getElementById('mini-player')!.classList.contains('hidden')).toBe(false)
    expect(text('mini-title')).not.toBe('')
    expect((document.getElementById('mini-play') as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the queue's first song when nothing is loaded, and play starts it", () => {
    setSnapshot({ queue: [song('a', 'First'), song('b', 'Second')] })

    expect(text('mini-title')).toBe('First')
    document.getElementById('mini-play')!.click()

    expect(lastCommand()).toEqual({ type: 'queue-jump', payload: { index: 0 } })
  })

  it('shows the loaded song over the queue, and play toggles it', () => {
    setSnapshot({
      queue: [song('a', 'First'), song('b', 'Second')],
      current_song: song('b', 'Second'),
    })

    expect(text('mini-title')).toBe('Second')
    document.getElementById('mini-play')!.click()

    expect(lastCommand()).toEqual({ type: 'toggle-play', payload: {} })
  })
})
