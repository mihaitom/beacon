// The cast stream readout (#56): it appears only for whoever turned the log
// level up while casting, asks connect only then, and says plainly when a
// speaker has stopped reading a connection that is still open - the moment
// everything else in #56 was about.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getLogLevel } from '@/services/connect/logLevel'
import {
  getStreamDiagnostics,
  type StreamConnectionInfo,
  type StreamDiagnostics,
} from '@/services/connect/streamDiagnostics'
import { useConnectStore } from '@/stores/connect'
import CastStreamDebugOverlay from '../CastStreamDebugOverlay.vue'

vi.mock('@/services/connect/logLevel', () => ({ getLogLevel: vi.fn() }))
vi.mock('@/services/connect/streamDiagnostics', () => ({ getStreamDiagnostics: vi.fn() }))

function diagnostics(connection: Partial<StreamConnectionInfo> = {}): StreamDiagnostics {
  return {
    older_sonos_mode: 'whole',
    position: 40,
    track_end: 400,
    connections: [
      {
        current: true,
        open: true,
        outcome: null,
        age: 40,
        model: 'S3',
        mode: 'whole',
        range: null,
        start: 0,
        bytes: 14_844_634,
        last_read: 1,
        audio_end: 371,
        ...connection,
      },
    ],
    device: { position: 38, age: 2 },
    ahead: 331,
    targets: [
      {
        type: 'sonos',
        name: 'Study',
        state: 'PLAYING',
        state_age: 30,
        problem: null,
        problem_age: null,
      },
    ],
    requests: [],
  }
}

function casting(on: boolean) {
  const targets = on ? [{ type: 'sonos', name: 'Study' }] : []
  useConnectStore().$patch({ status: { targets } } as never)
}

async function mountOverlay(level = 'DEBUG') {
  vi.mocked(getLogLevel).mockResolvedValue({ level } as Awaited<ReturnType<typeof getLogLevel>>)
  const wrapper = mount(CastStreamDebugOverlay)
  await flushPromises()
  return wrapper
}

describe('CastStreamDebugOverlay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getStreamDiagnostics).mockReset().mockResolvedValue(diagnostics())
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays out of the way at a normal log level', async () => {
    casting(true)
    const wrapper = await mountOverlay('INFO')

    expect(wrapper.find('.stream-debug-overlay').exists()).toBe(false)
    expect(getStreamDiagnostics).not.toHaveBeenCalled()
  })

  it('asks connect only while something is cast', async () => {
    casting(false)
    const wrapper = await mountOverlay()
    expect(getStreamDiagnostics).not.toHaveBeenCalled()

    casting(true)
    await flushPromises()
    expect(wrapper.find('.stream-debug-overlay').exists()).toBe(true)

    casting(false)
    await flushPromises()
    vi.mocked(getStreamDiagnostics).mockClear()
    vi.advanceTimersByTime(10_000)
    expect(getStreamDiagnostics).not.toHaveBeenCalled()
    expect(wrapper.find('.stream-debug-overlay').exists()).toBe(false)
  })

  it('flags a speaker that stopped reading an open connection', async () => {
    vi.mocked(getStreamDiagnostics).mockResolvedValue(diagnostics({ last_read: 300 }))
    casting(true)
    const wrapper = await mountOverlay()

    expect(wrapper.find('.stream-debug-overlay__line--bad').text()).toContain('STALLED')
  })

  it('does not flag a connection that has sent everything', async () => {
    vi.mocked(getStreamDiagnostics).mockResolvedValue(
      diagnostics({ open: false, outcome: 'source finished', last_read: 300 }),
    )
    casting(true)
    const wrapper = await mountOverlay()

    expect(wrapper.text()).not.toContain('STALLED')
  })
})
