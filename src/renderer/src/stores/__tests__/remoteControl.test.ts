import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRemoteControlStore } from '../remoteControl'
import { usePlaybackStore } from '../playback'
import { useConnectStore } from '../connect'
import { useAutoplayStore } from '../autoplay'
import * as remoteHttp from '@/services/remoteControl/http'
import * as commands from '@/services/remoteControl/commands'
import { RemoteAgentEventSource } from '@/services/remoteControl/agent'
import { makeSong } from './fixtures'

vi.mock('@/services/remoteControl/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/remoteControl/http')>()
  return {
    ...actual,
    enableRemoteControl: vi.fn(),
    disableRemoteControl: vi.fn(),
    getRemoteControlStatus: vi.fn(),
    sendRemoteKeepalive: vi.fn(),
    pushRemoteState: vi.fn(),
    respondToRemoteQuery: vi.fn(),
  }
})

// The dispatch table itself (routing a command/query to the right store
// action) is commands.test.ts's own responsibility — this file only checks
// that the agent's onCommand/onQuery callbacks actually reach it.
vi.mock('@/services/remoteControl/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/remoteControl/commands')>()
  return {
    ...actual,
    handleRemoteCommand: vi.fn().mockResolvedValue(undefined),
    resolveRemoteQuery: vi.fn().mockResolvedValue({ ok: true }),
  }
})

// A fake EventSource-backed agent — real SSE has no place in a unit test.
// Exposes the same start()/stop()/onCommand/onQuery surface as the real
// class so startAgent()'s wiring can be exercised directly.
class FakeAgent {
  static instances: FakeAgent[] = []
  onCommand: ((message: { type: string; payload: Record<string, unknown> }) => void) | null = null
  onQuery:
    | ((message: { request_id: string; type: string; payload: Record<string, unknown> }) => void)
    | null = null
  started = false
  stopped = false
  constructor(
    public connectUrl: string,
    public connectToken: string,
  ) {
    FakeAgent.instances.push(this)
  }
  start() {
    this.started = true
  }
  stop() {
    this.stopped = true
  }
}

vi.mock('@/services/remoteControl/agent', () => ({
  RemoteAgentEventSource: vi.fn(),
}))

describe('remoteControl store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(remoteHttp.enableRemoteControl).mockReset()
    vi.mocked(remoteHttp.disableRemoteControl).mockReset()
    vi.mocked(remoteHttp.getRemoteControlStatus).mockReset()
    vi.mocked(remoteHttp.sendRemoteKeepalive).mockReset().mockResolvedValue(undefined)
    vi.mocked(remoteHttp.pushRemoteState).mockReset().mockResolvedValue(undefined)
    vi.mocked(remoteHttp.respondToRemoteQuery).mockReset().mockResolvedValue(undefined)
    vi.mocked(commands.handleRemoteCommand).mockClear()
    vi.mocked(commands.resolveRemoteQuery).mockClear()
    FakeAgent.instances = []
    // A plain `function`, not an arrow — mockImplementation() invokes this
    // with `new` (agent.ts does `new RemoteAgentEventSource(...)`), which
    // an arrow function can't be called with at all.
    vi.mocked(RemoteAgentEventSource).mockImplementation(function (
      this: unknown,
      url: string,
      token: string,
    ) {
      return new FakeAgent(url, token) as unknown as RemoteAgentEventSource
    })
  })

  afterEach(() => {
    // The relay's timers/agent connection live in plain module-level `let`s
    // (see remoteControl.ts's own comment on why — not Pinia state), so
    // they survive setActivePinia(createPinia()) above and would otherwise
    // leak into the next test (a stray keepalive/poll interval still
    // ticking, or startAgent() short-circuiting on an agent a previous test
    // already created).
    useRemoteControlStore().stopRelay()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('enable / disable', () => {
    it('enable() adopts the returned credentials and starts the relay', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '123456',
        lan_ip: '192.168.1.5',
        port: 8080,
      })
      const store = useRemoteControlStore()

      await store.enable()

      expect(store.enabled).toBe(true)
      expect(store.password).toBe('secret')
      expect(store.pin).toBe('123456')
      expect(store.lanIp).toBe('192.168.1.5')
      expect(store.port).toBe(8080)
      expect(store.needsRegenerate).toBe(false)
      // startRelay()'s own startAgent() — the clearest externally-observable
      // sign the relay actually came up.
      expect(FakeAgent.instances).toHaveLength(1)
      expect(FakeAgent.instances[0]!.started).toBe(true)
    })

    it('disable() resets local state and stops the relay even if the backend call fails', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '123456',
        lan_ip: '192.168.1.5',
        port: 8080,
      })
      vi.mocked(remoteHttp.disableRemoteControl).mockRejectedValue(new Error('network down'))
      const store = useRemoteControlStore()
      await store.enable()
      const agent = FakeAgent.instances[0]!

      await expect(store.disable()).rejects.toThrow('network down')

      expect(store.enabled).toBe(false)
      expect(store.password).toBeNull()
      expect(store.pin).toBeNull()
      expect(store.needsRegenerate).toBe(false)
      expect(agent.stopped).toBe(true)
    })
  })

  describe('refreshStatus', () => {
    it('does nothing when connect is unreachable', async () => {
      vi.mocked(remoteHttp.getRemoteControlStatus).mockRejectedValue(new Error('ECONNREFUSED'))
      const store = useRemoteControlStore()

      await store.refreshStatus()

      expect(store.enabled).toBe(false)
      expect(FakeAgent.instances).toHaveLength(0)
    })

    it('adopts a disabled status without starting the relay', async () => {
      vi.mocked(remoteHttp.getRemoteControlStatus).mockResolvedValue({
        enabled: false,
        pin: null,
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()

      await store.refreshStatus()

      expect(store.enabled).toBe(false)
      expect(FakeAgent.instances).toHaveLength(0)
    })

    it('starts the relay for an enabled status, flagging needsRegenerate since this session never saw the password', async () => {
      vi.mocked(remoteHttp.getRemoteControlStatus).mockResolvedValue({
        enabled: true,
        pin: '654321',
        lan_ip: '10.0.0.9',
        port: 9000,
      })
      const store = useRemoteControlStore()

      await store.refreshStatus()

      expect(store.enabled).toBe(true)
      expect(store.needsRegenerate).toBe(true)
      expect(FakeAgent.instances).toHaveLength(1)
    })

    it('does not need regenerating when this session already holds the password (e.g. right after enable())', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '123456',
        lan_ip: '192.168.1.5',
        port: 8080,
      })
      const store = useRemoteControlStore()
      await store.enable()
      vi.mocked(remoteHttp.getRemoteControlStatus).mockResolvedValue({
        enabled: true,
        pin: '123456',
        lan_ip: '192.168.1.5',
        port: 8080,
      })

      await store.refreshStatus()

      expect(store.needsRegenerate).toBe(false)
    })
  })

  describe('startAgent', () => {
    it('is idempotent — a second call while already connected does not open another connection', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      await store.enable()

      store.startAgent()

      expect(FakeAgent.instances).toHaveLength(1)
    })

    it('routes an incoming command to handleRemoteCommand()', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      await store.enable()
      const agent = FakeAgent.instances[0]!

      agent.onCommand?.({ type: 'next', payload: { foo: 'bar' } })
      await Promise.resolve()

      expect(commands.handleRemoteCommand).toHaveBeenCalledWith('next', { foo: 'bar' })
    })

    it('resolves an incoming query and posts the answer back', async () => {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      await store.enable()
      const agent = FakeAgent.instances[0]!
      vi.mocked(commands.resolveRemoteQuery).mockResolvedValue({ items: [1, 2] })

      agent.onQuery?.({ request_id: 'req-1', type: 'songs-request', payload: {} })
      await Promise.resolve()
      await Promise.resolve()

      expect(commands.resolveRemoteQuery).toHaveBeenCalledWith('songs-request', {})
      expect(remoteHttp.respondToRemoteQuery).toHaveBeenCalledWith('req-1', { items: [1, 2] })
    })
  })

  describe('startKeepalive', () => {
    it('sends one immediately, then repeats on the interval, swallowing failures either way', async () => {
      vi.useFakeTimers()
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      vi.mocked(remoteHttp.sendRemoteKeepalive).mockRejectedValue(new Error('down'))
      const store = useRemoteControlStore()

      await store.enable()
      await vi.advanceTimersByTimeAsync(0)
      expect(remoteHttp.sendRemoteKeepalive).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(20_000)
      expect(remoteHttp.sendRemoteKeepalive).toHaveBeenCalledTimes(2)
    })
  })

  describe('state push', () => {
    async function enableStore() {
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      await store.enable()
      return store
    }

    it('pushes an initial snapshot immediately on relay start', async () => {
      await enableStore()

      expect(remoteHttp.pushRemoteState).toHaveBeenCalledOnce()
      const snapshot = vi.mocked(remoteHttp.pushRemoteState).mock.calls[0]![0]
      expect(snapshot).toMatchObject({
        playing: false,
        current_song: null,
        queue: [],
        queue_index: -1,
        casting: [],
        device_volume: null,
      })
    })

    it('debounces a burst of playback/connect/autoplay mutations into a single extra push', async () => {
      vi.useFakeTimers()
      await enableStore()
      vi.mocked(remoteHttp.pushRemoteState).mockClear()
      const playback = usePlaybackStore()
      const connect = useConnectStore()
      const autoplay = useAutoplayStore()

      playback.isPlaying = true
      connect.connected = true
      autoplay.enabled = true
      // Not yet — STATE_PUSH_DEBOUNCE_MS (300ms) hasn't elapsed.
      expect(remoteHttp.pushRemoteState).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300)

      expect(remoteHttp.pushRemoteState).toHaveBeenCalledOnce()
      const snapshot = vi.mocked(remoteHttp.pushRemoteState).mock.calls[0]![0] as Record<
        string,
        unknown
      >
      expect(snapshot.playing).toBe(true)
      expect(snapshot.autoplay).toBe(true)
    })

    it('includes the current song/queue in the pushed snapshot', async () => {
      const store = await enableStore()
      vi.mocked(remoteHttp.pushRemoteState).mockClear()
      const playback = usePlaybackStore()
      const song = makeSong('a', { title: 'Track A' })
      playback.setQueue([song], 0)
      store.reportDeviceVolume(0) // cheap way to force a push without fake timers below

      await vi.waitFor(() => expect(remoteHttp.pushRemoteState).toHaveBeenCalled())
      const snapshot = vi.mocked(remoteHttp.pushRemoteState).mock.calls.at(-1)![0] as Record<
        string,
        unknown
      >
      expect(snapshot.current_song).toMatchObject({ id: 'a', title: 'Track A' })
      expect(snapshot.queue).toEqual([expect.objectContaining({ id: 'a' })])
    })
  })

  describe('device volume poll + reportDeviceVolume', () => {
    it('reportDeviceVolume() before the relay has ever started is a harmless no-op', () => {
      const store = useRemoteControlStore()
      expect(() => store.reportDeviceVolume(42)).not.toThrow()
    })

    it('polls the single active target and pushes a snapshot only when the value actually changes', async () => {
      vi.useFakeTimers()
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      const connect = useConnectStore()
      connect.status = {
        current_song: null,
        stream_info: {
          label: 'mp3-192k (fallback)',
          content_type: 'audio/mpeg',
          transcoding: true,
          source_codec: null,
          source_sample_rate: null,
          source_bit_depth: null,
          source_bitrate_kbps: null,
          target_sample_rate: null,
          target_bit_depth: null,
          target_bitrate_kbps: null,
          transcode_reason: null,
          active_connections: 0,
          loop_lag: 0,
        },
        queue: [],
        current_song_index: -1,
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off',
        elapsed: 0,
        ended: false,
        paused: false,
        radio: null,
        streaming: false,
        targets: [{ name: 'Kitchen', type: 'sonos' }],
        total_songs: 0,
        displaced: false,
        interrupted: false,
      }
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      await store.enable()
      // The immediate poll() inside startDeviceVolumePoll() resolves
      // asynchronously and, since deviceVolumeCache started at null, its
      // first real value (30) is itself a "change" — schedulePushSnapshot()
      // queues its own 300ms-debounced push, on top of startStatePush()'s
      // own immediate seed push. Advancing past STATE_PUSH_DEBOUNCE_MS lets
      // that settle before mockClear(), instead of it firing later and
      // being mistaken for a push the "same value again" case below caused.
      await vi.advanceTimersByTimeAsync(300)
      vi.mocked(remoteHttp.pushRemoteState).mockClear()

      // Same value again — no new push.
      await vi.advanceTimersByTimeAsync(4000)
      expect(remoteHttp.pushRemoteState).not.toHaveBeenCalled()

      // Value changes — triggers a push, and reportDeviceVolume()'s own
      // "immediate update" path is exercised the same way commands.ts's
      // 'volume' command uses it, via the store action directly.
      getVolumeSpy.mockResolvedValue(45)
      await vi.advanceTimersByTimeAsync(4000)
      expect(remoteHttp.pushRemoteState).toHaveBeenCalledOnce()
      const snapshot = vi.mocked(remoteHttp.pushRemoteState).mock.calls[0]![0] as Record<
        string,
        unknown
      >
      expect(snapshot.device_volume).toBe(45)
    })

    it('reports device_volume as null once there is no longer exactly one active target', async () => {
      vi.useFakeTimers()
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      const connect = useConnectStore()
      connect.status = {
        current_song: null,
        stream_info: {
          label: 'mp3-192k (fallback)',
          content_type: 'audio/mpeg',
          transcoding: true,
          source_codec: null,
          source_sample_rate: null,
          source_bit_depth: null,
          source_bitrate_kbps: null,
          target_sample_rate: null,
          target_bit_depth: null,
          target_bitrate_kbps: null,
          transcode_reason: null,
          active_connections: 0,
          loop_lag: 0,
        },
        queue: [],
        current_song_index: -1,
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off',
        elapsed: 0,
        ended: false,
        paused: false,
        radio: null,
        streaming: false,
        targets: [{ name: 'Kitchen', type: 'sonos' }],
        total_songs: 0,
        displaced: false,
        interrupted: false,
      }
      vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      await store.enable()
      // See the previous test's identical comment — settles the initial
      // poll's own debounced push (null -> 30) before mockClear(), so it
      // can't fire later and be mistaken for the one this test actually
      // means to assert on.
      await vi.advanceTimersByTimeAsync(300)
      vi.mocked(remoteHttp.pushRemoteState).mockClear()

      connect.status = { ...connect.status, targets: [] }
      await vi.advanceTimersByTimeAsync(4000)

      // Two independent triggers legitimately both fire here: connect's own
      // $subscribe reacts to the targets change immediately, and the next
      // poll() tick separately notices the cache itself is now stale and
      // resets it — not a bug, just two different signals ("targets
      // changed" vs. "the polled value changed") that happen to land in the
      // same window. Every push in it should already read device_volume as
      // null either way, since that's derived from activeTargets.length at
      // push time, not from whether the cache has caught up yet.
      expect(remoteHttp.pushRemoteState).toHaveBeenCalled()
      for (const [snapshot] of vi.mocked(remoteHttp.pushRemoteState).mock.calls) {
        expect((snapshot as Record<string, unknown>).device_volume).toBeNull()
      }
    })

    // Regression test: Sonos volume/mute reaches connectStore.status by
    // push (see connectStore.isVolumePushCapable()) - this poll used to
    // call getDeviceVolume() every tick regardless of type, one of several
    // surfaces that silently kept doing so after DeviceListItem.vue's own
    // fix, caught live 2026-08-25.
    it('stops calling getDeviceVolume for a push-capable target once a pushed reading exists', async () => {
      vi.useFakeTimers()
      vi.mocked(remoteHttp.enableRemoteControl).mockResolvedValue({
        password: 'secret',
        pin: '1',
        lan_ip: '',
        port: 0,
      })
      const store = useRemoteControlStore()
      const connect = useConnectStore()
      connect.status = {
        current_song: null,
        stream_info: {
          label: 'mp3-192k (fallback)',
          content_type: 'audio/mpeg',
          transcoding: true,
          source_codec: null,
          source_sample_rate: null,
          source_bit_depth: null,
          source_bitrate_kbps: null,
          target_sample_rate: null,
          target_bit_depth: null,
          target_bitrate_kbps: null,
          transcode_reason: null,
          active_connections: 0,
          loop_lag: 0,
        },
        queue: [],
        current_song_index: -1,
        original_queue: [],
        shuffle: false,
        repeat_mode: 'off',
        elapsed: 0,
        ended: false,
        paused: false,
        radio: null,
        streaming: false,
        // No volume field yet — the first tick still has nothing pushed,
        // same gap DeviceListItem.vue's always-on-activation fetch covers.
        targets: [{ name: 'Kitchen', type: 'sonos' }],
        total_songs: 0,
        displaced: false,
        interrupted: false,
      }
      const getVolumeSpy = vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
      await store.enable()
      await vi.advanceTimersByTimeAsync(300)
      expect(getVolumeSpy).toHaveBeenCalled()

      // A push now lands (e.g. someone changed it via the Sonos app).
      connect.status = {
        ...connect.status,
        targets: [{ name: 'Kitchen', type: 'sonos', volume: 55 }],
      }
      getVolumeSpy.mockClear()
      vi.mocked(remoteHttp.pushRemoteState).mockClear()
      await vi.advanceTimersByTimeAsync(4000)

      expect(getVolumeSpy).not.toHaveBeenCalled()
      const snapshot = vi.mocked(remoteHttp.pushRemoteState).mock.calls.at(-1)?.[0] as Record<
        string,
        unknown
      >
      expect(snapshot.device_volume).toBe(55)
    })
  })
})
