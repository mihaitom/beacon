// The cast stream readout (#56): it appears only for whoever turned the log
// level up while casting, asks connect only then, and says plainly when a
// speaker has stopped reading a connection that is still open - the moment
// everything else in #56 was about - for each speaker cast to on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { getLogLevel } from '@/services/connect/logLevel'
import {
  getStreamDiagnostics,
  type StreamConnectionInfo,
  type StreamDiagnostics,
  type StreamTargetInfo,
} from '@/services/connect/streamDiagnostics'
import { useConnectStore } from '@/stores/connect'
import CastStreamDebugOverlay from '../CastStreamDebugOverlay.vue'

vi.mock('@/services/connect/logLevel', () => ({ getLogLevel: vi.fn() }))
vi.mock('@/services/connect/streamDiagnostics', () => ({ getStreamDiagnostics: vi.fn() }))

const vuetify = createVuetify({ components, directives })

function connection(fields: Partial<StreamConnectionInfo> = {}): StreamConnectionInfo {
  return {
    current: true,
    open: true,
    outcome: null,
    age: 40,
    model: 'S3',
    start: 0,
    bytes: 14_844_634,
    last_read: 1,
    audio_end: 371,
    ...fields,
  }
}

function target(fields: Partial<StreamTargetInfo> = {}): StreamTargetInfo {
  return {
    type: 'sonos',
    name: 'Study',
    follows: null,
    state: 'PLAYING',
    state_age: 30,
    problem: null,
    problem_age: null,
    connection: connection(),
    device: { position: 38, age: 2 },
    ahead: 331,
    requests: [],
    ...fields,
  }
}

function diagnostics(...targets: StreamTargetInfo[]): StreamDiagnostics {
  return { position: 40, track_end: 400, targets: targets.length ? targets : [target()] }
}

function casting(on: boolean) {
  const targets = on ? [{ type: 'sonos', name: 'Study' }] : []
  useConnectStore().$patch({ status: { targets } } as never)
}

async function mountOverlay(level = 'DEBUG') {
  vi.mocked(getLogLevel).mockResolvedValue({ level } as Awaited<ReturnType<typeof getLogLevel>>)
  const wrapper = mount(CastStreamDebugOverlay, { global: { plugins: [vuetify] } })
  await flushPromises()
  return wrapper
}

function speaker(wrapper: Awaited<ReturnType<typeof mountOverlay>>, name: string) {
  const block = wrapper
    .findAll('.stream-debug-overlay__speaker')
    .find((s) => s.get('.stream-debug-overlay__name').text() === name)
  if (!block) throw new Error(`no block for ${name}`)
  return block
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

    expect(wrapper.find('.debug-panel').exists()).toBe(false)
    expect(getStreamDiagnostics).not.toHaveBeenCalled()
  })

  it('asks connect only while something is cast', async () => {
    casting(false)
    const wrapper = await mountOverlay()
    expect(getStreamDiagnostics).not.toHaveBeenCalled()

    casting(true)
    await flushPromises()
    expect(wrapper.find('.debug-panel').exists()).toBe(true)

    casting(false)
    await flushPromises()
    vi.mocked(getStreamDiagnostics).mockClear()
    vi.advanceTimersByTime(10_000)
    expect(getStreamDiagnostics).not.toHaveBeenCalled()
    expect(wrapper.find('.debug-panel').exists()).toBe(false)
  })

  it('flags a speaker that stopped reading an open connection', async () => {
    vi.mocked(getStreamDiagnostics).mockResolvedValue(
      diagnostics(target({ connection: connection({ last_read: 300 }) })),
    )
    casting(true)
    const wrapper = await mountOverlay()

    expect(wrapper.get('.debug-readings__value--bad').text()).toContain('STALLED')
  })

  it('does not flag a connection that has sent everything', async () => {
    vi.mocked(getStreamDiagnostics).mockResolvedValue(
      diagnostics(
        target({
          connection: connection({ open: false, outcome: 'source finished', last_read: 300 }),
        }),
      ),
    )
    casting(true)
    const wrapper = await mountOverlay()

    expect(wrapper.text()).not.toContain('STALLED')
  })

  it('names a speaker without a Sonos model by its kind', async () => {
    vi.mocked(getStreamDiagnostics).mockResolvedValue(
      diagnostics(
        target({
          type: 'airplay',
          name: 'Den',
          state: null,
          connection: connection({ model: null }),
        }),
      ),
    )
    casting(true)
    const wrapper = await mountOverlay()

    expect(speaker(wrapper, 'Den').get('.stream-debug-overlay__kind').text()).toBe('airplay')
    expect(speaker(wrapper, 'Den').find('.stream-debug-overlay__state').exists()).toBe(false)
  })

  describe('several speakers at once', () => {
    it('marks the one speaker that stalled, not the others reading fine', async () => {
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(
          target({ type: 'chromecast', name: 'Kitchen', connection: connection({ model: null }) }),
          target({
            type: 'dlna',
            name: 'Receiver',
            device: null,
            ahead: null,
            connection: connection({ model: null, last_read: 120 }),
          }),
        ),
      )
      casting(true)
      const wrapper = await mountOverlay()

      expect(speaker(wrapper, 'Receiver').classes()).toContain('stream-debug-overlay__speaker--bad')
      expect(speaker(wrapper, 'Receiver').text()).toContain('STALLED')
      expect(speaker(wrapper, 'Kitchen').classes()).not.toContain(
        'stream-debug-overlay__speaker--bad',
      )
      expect(speaker(wrapper, 'Kitchen').text()).not.toContain('STALLED')
    })

    it('shows a problem reported by a speaker other than the first', async () => {
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(
          target(),
          target({
            type: 'chromecast',
            name: 'Kitchen',
            problem: 'IDLE (ERROR)',
            problem_age: 4,
          }),
        ),
      )
      casting(true)
      const wrapper = await mountOverlay()

      expect(speaker(wrapper, 'Kitchen').text()).toContain('IDLE (ERROR)')
      expect(speaker(wrapper, 'Study').text()).not.toContain('IDLE (ERROR)')
    })

    it('says which speaker a Sonos follower plays through', async () => {
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(
          target(),
          target({ name: 'Lounge', follows: 'Study', connection: null, device: null, ahead: null }),
        ),
      )
      casting(true)
      const wrapper = await mountOverlay()

      expect(speaker(wrapper, 'Lounge').text()).toContain('Study')
      expect(speaker(wrapper, 'Lounge').classes()).toContain('stream-debug-overlay__speaker--good')
    })

    it('measures each speaker’s read rate against its own previous reading', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(
          target({ name: 'Study', connection: connection({ age: 40, bytes: 1_000_000 }) }),
          target({ name: 'Den', connection: connection({ age: 40, bytes: 5_000_000 }) }),
        ),
      )
      casting(true)
      const wrapper = await mountOverlay()

      now.mockReturnValue(102_000)
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(
          target({ name: 'Study', connection: connection({ age: 42, bytes: 1_204_800 }) }),
          target({ name: 'Den', connection: connection({ age: 42, bytes: 5_000_000 }) }),
        ),
      )
      vi.advanceTimersByTime(2000)
      await flushPromises()

      expect(speaker(wrapper, 'Study').text()).toContain('100 KiB/s')
      expect(speaker(wrapper, 'Den').text()).not.toContain('100 KiB/s')
      expect(speaker(wrapper, 'Den').text()).toContain('0 KiB/s')
      now.mockRestore()
    })

    it('copies every speaker’s readings under its name', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      vi.mocked(getStreamDiagnostics).mockResolvedValue(
        diagnostics(target(), target({ type: null, name: '10.0.0.40', connection: null })),
      )
      casting(true)
      const wrapper = await mountOverlay()

      await wrapper.get('.debug-panel__copy').trigger('click')

      const copied = writeText.mock.calls[0]![0] as string
      expect(copied).toContain('Study (S3 · PLAYING)')
      expect(copied).toContain('10.0.0.40 (not a target')
      expect(copied).toContain('  Ahead: 331.0s')
    })
  })
})
