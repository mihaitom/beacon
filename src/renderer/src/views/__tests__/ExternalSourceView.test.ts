// An external source's tab: a sandboxed page and the message bridge to it.
// Covers who may talk to the bridge and what a play request does - not the
// empty state's copy or the frame's size.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useExternalSourceStore } from '@/stores/externalSource'
import { usePlaybackStore } from '@/stores/playback'
import { getExternalSources, registerExternalItem } from '@/services/connect/externalSource'
import type { Song } from '@/types/library'
import ExternalSourceView from '../ExternalSourceView.vue'

vi.mock('@/services/connect/externalSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/externalSource')>()),
  getExternalSources: vi.fn(),
  registerExternalItem: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const emit = vi.fn()

const SONG = { id: 'ext:1', title: 'T', artist: 'A' } as Song

let wrapper: VueWrapper | null = null

function mountAt(id: string, attach = true) {
  return mount(ExternalSourceView, {
    attachTo: attach ? document.body : undefined,
    global: {
      plugins: [vuetify, i18n],
      mocks: {
        $emitter: { emit, on: vi.fn(), off: vi.fn() },
        $route: { params: { id } },
      },
    },
  })
}

async function mountView(id = 'wish') {
  wrapper = mountAt(id)
  await flushPromises()
  const frame = wrapper.find('iframe').element as HTMLIFrameElement
  return { frame, frameWindow: frame.contentWindow! }
}

function fromWindow(source: Window | null, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source }))
  return flushPromises()
}

describe('ExternalSourceView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getExternalSources).mockResolvedValue({
      may_configure: true,
      sources: [
        { id: 'wish', name: 'Wishlist', icon: 'mdi-gift', ui_path: '/external-ui/secret/wish/' },
        {
          id: 'dir',
          name: 'Folder',
          icon: 'mdi-folder-music',
          ui_path: '/external-ui/secret/dir/',
        },
      ],
    })
    vi.mocked(registerExternalItem).mockResolvedValue(SONG)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.clearAllMocks()
  })

  it('shows the page sandboxed without its own origin', async () => {
    const { frame } = await mountView()
    const sandbox = frame.getAttribute('sandbox')!.split(' ')
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(frame.getAttribute('src')).toMatch(/\/external-ui\/secret\/wish\/$/)
  })

  it('plays what the page asks for and tells it so', async () => {
    const { frameWindow } = await mountView()
    const playback = usePlaybackStore()
    const play = vi.spyOn(playback, 'playSongList').mockResolvedValue()
    const reply = vi.spyOn(frameWindow, 'postMessage')

    await fromWindow(frameWindow, { type: 'beacon.play', item: { audioUrl: 'a.mp3', title: 'T' } })

    expect(registerExternalItem).toHaveBeenCalledWith(
      'wish',
      expect.objectContaining({ audioUrl: 'a.mp3', title: 'T' }),
    )
    expect(play).toHaveBeenCalledWith([SONG], 0)
    expect(reply).toHaveBeenCalledWith({ type: 'beacon.played', ok: true }, '*')
  })

  it.each([
    ['next', 'queueNext'],
    ['queue', 'addToQueue'],
  ] as const)('queues for mode %s', async (mode, action) => {
    const { frameWindow } = await mountView()
    const queued = vi.spyOn(usePlaybackStore(), action).mockImplementation(() => {})
    await fromWindow(frameWindow, { type: 'beacon.play', mode, item: { audioUrl: 'a' } })
    expect(queued).toHaveBeenCalledWith([SONG])
  })

  it('ignores a play request from anything but its own frame', async () => {
    await mountView()
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    await fromWindow(window, { type: 'beacon.play', item: { audioUrl: 'a' } })
    await fromWindow(null, { type: 'beacon.play', item: { audioUrl: 'a' } })
    expect(registerExternalItem).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })

  it('says why when connect refuses the song', async () => {
    vi.mocked(registerExternalItem).mockRejectedValue(new Error('not the app'))
    const { frameWindow } = await mountView()
    const play = vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    const reply = vi.spyOn(frameWindow, 'postMessage')

    await fromWindow(frameWindow, { type: 'beacon.play', item: { audioUrl: 'http://x/a' } })

    expect(play).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      { type: 'beacon.played', ok: false, error: 'not the app' },
      '*',
    )
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })

  it('answers ready with the theme and what is playing, and nothing else', async () => {
    const { frameWindow } = await mountView()
    const reply = vi.spyOn(frameWindow, 'postMessage')
    await fromWindow(frameWindow, { type: 'beacon.ready' })
    const types = reply.mock.calls.map(([message]) => (message as { type: string }).type)
    expect(types).toEqual(['beacon.theme', 'beacon.nowPlaying'])
    const theme = reply.mock.calls[0]![0] as { dark: boolean; colors: Record<string, string> }
    expect(typeof theme.dark).toBe('boolean')
    expect(theme.colors.primary).toMatch(/^#/)
  })

  it('shows the page of the source the route names', async () => {
    const { frame, frameWindow } = await mountView('dir')
    expect(frame.getAttribute('src')).toMatch(/\/external-ui\/secret\/dir\/$/)
    vi.spyOn(usePlaybackStore(), 'playSongList').mockResolvedValue()
    await fromWindow(frameWindow, { type: 'beacon.play', item: { audioUrl: 'a' } })
    expect(registerExternalItem).toHaveBeenCalledWith('dir', expect.anything())
  })

  it('shows no frame for a source that is not there', async () => {
    wrapper = mountAt('gone', false)
    await flushPromises()
    expect(useExternalSourceStore().loaded).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })
})
