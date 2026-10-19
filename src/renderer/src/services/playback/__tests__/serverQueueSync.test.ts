import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { ServerPlayQueue } from '@/services/subsonic/client'

vi.mock('@/services/audioEngine', () => ({
  getAudioEngine: () => ({ load: vi.fn(), play: vi.fn(), stop: vi.fn(), pause: vi.fn() }),
}))

/** A Navidrome holding one queue: what Beacon saves lands here, and
 * another app's save is a test setting `queue` itself. */
interface FakeServer {
  queue: ServerPlayQueue | null
}

// The module keeps what it has saved and restored between calls, so each
// test gets a fresh copy of it - and of the stores it reads. Passing the
// previous instance's server along is a restart of the app.
async function load(server: FakeServer = { queue: null }) {
  vi.resetModules()
  const sync = await import('../serverQueueSync')
  const { usePlaybackStore } = await import('@/stores/playback')
  const { useAuthStore } = await import('@/stores/auth')
  const { useLibraryStore } = await import('@/stores/library')
  const { useConnectStore } = await import('@/stores/connect')
  const { emitter } = await import('@/emitter')
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.serverUrl = 'http://navidrome'
  auth.username = 'bob'
  auth.serverType = 'subsonic'
  auth.authenticated = true
  const client = {
    getOpenSubsonicExtensions: vi.fn(async () => new Set(['indexBasedQueue'])),
    getPlayQueue: vi.fn(async (_byIndex: boolean) => server.queue),
    savePlayQueue: vi.fn(async (ids: string[], currentIndex: number, position: number) => {
      server.queue = {
        songs: ids.map((id) => makeSong(id)),
        currentIndex,
        position: Math.round(position * 1000) / 1000,
        changed: Date.now(),
        changedBy: 'beacon',
      }
    }),
    streamUrl: () => 'http://media/song',
  }
  const library = useLibraryStore()
  vi.spyOn(library, 'client').mockReturnValue(
    client as unknown as ReturnType<typeof library.client>,
  )
  const toasts: unknown[] = []
  emitter.on('toast', (toast) => toasts.push(toast))
  return {
    sync,
    playback: usePlaybackStore(),
    auth,
    client,
    server,
    toasts,
    connect: useConnectStore(),
  }
}

function serverQueue(overrides: Partial<ServerPlayQueue> = {}): ServerPlayQueue {
  return {
    songs: [makeSong('x'), makeSong('y')],
    currentIndex: 1,
    position: 30,
    changed: Date.now() - 60_000,
    changedBy: 'feishin',
    ...overrides,
  }
}

describe('saving the queue to the server', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('saves the queue, its current song and position', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 1)
    playback.localPosition = 12

    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a', 'b'], 1, 12, {
      byIndex: true,
      formPost: false,
      keepalive: false,
    })
  })

  it('does not repeat a save that would change nothing', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a')], 0)

    await sync.saveServerQueue()
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  /** Clearing the server copy would take it away from another app that
   * may still want it; a station is not a queue position. */
  it('leaves the server alone with an empty queue or a station playing', async () => {
    const { sync, playback, client } = await load()
    await sync.saveServerQueue()

    playback.setQueue([makeSong('a')], 0)
    playback.radioStation = { id: 'r', name: 'FM', streamUrl: 'http://s', homePageUrl: null }
    await sync.saveServerQueue()

    expect(client.savePlayQueue).not.toHaveBeenCalled()
  })

  it('saves nothing for Jellyfin or Plex', async () => {
    const { sync, playback, auth, client } = await load()
    auth.serverType = 'jellyfin'
    playback.setQueue([makeSong('a')], 0)

    await sync.saveServerQueue()

    expect(client.savePlayQueue).not.toHaveBeenCalled()
  })

  it('uses the plain form where the server has no index form', async () => {
    const { sync, playback, client } = await load()
    client.getOpenSubsonicExtensions.mockResolvedValue(new Set())
    playback.setQueue([makeSong('a')], 0)

    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a'], 0, 0, {
      byIndex: false,
      formPost: false,
      keepalive: false,
    })
  })

  it('posts the queue as a form where the server takes one', async () => {
    const { sync, playback, client } = await load()
    client.getOpenSubsonicExtensions.mockResolvedValue(new Set(['indexBasedQueue', 'formPost']))
    playback.setQueue([makeSong('a')], 0)

    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a'], 0, 0, {
      byIndex: true,
      formPost: true,
      keepalive: false,
    })
  })

  /** No answer says nothing about the server - taken for "no extensions",
   * it would save the plain form for the rest of the session. */
  it('asks for the extensions again after no answer', async () => {
    const { sync, playback, client } = await load()
    client.getOpenSubsonicExtensions.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    playback.setQueue([makeSong('a')], 0)

    expect(await sync.saveServerQueue()).toBe(false)
    expect(await sync.saveServerQueue()).toBe(true)

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a'], 0, 0, {
      byIndex: true,
      formPost: false,
      keepalive: false,
    })
  })

  /** Paused, the position moves by a seek alone - and another app should
   * carry on from there. */
  it('saves a seek made while paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      const { sync, playback, client } = await load()
      sync.initServerQueueSync()
      playback.setQueue([makeSong('a')], 0)
      // The save setQueue itself sets off, out of the way first.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(client.savePlayQueue).toHaveBeenCalledTimes(1)

      playback.localPosition = 40
      await vi.advanceTimersByTimeAsync(2_000)

      expect(client.savePlayQueue).toHaveBeenCalledTimes(2)
      expect(client.savePlayQueue).toHaveBeenLastCalledWith(['a'], 0, 40, expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('only while the server copy is our own', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** The desktop opens on last week's queue, the phone saved a new one
   * this morning, and something happens here before anyone looked. */
  it('does not save over a queue saved elsewhere', async () => {
    const { sync, playback, client, server, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    playback.addToQueue([makeSong('b')])
    playback.isPlaying = true

    await sync.saveServerQueue()

    expect(client.savePlayQueue).not.toHaveBeenCalled()
    expect(server.queue?.changedBy).toBe('feishin')
    expect(toasts).toHaveLength(1)
  })

  /** Two devices both running: the one that didn't save last stops - and
   * starting something new doesn't change that. */
  it('stops saving once another device has saved over it', async () => {
    const { sync, playback, client, server, toasts } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    await sync.saveServerQueue()
    server.queue = serverQueue()

    playback.isPlaying = true
    playback.localPosition = 90
    await sync.saveServerQueue()
    playback.setQueue([makeSong('n')], 0)
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
    expect(server.queue.changedBy).toBe('feishin')
    // Offered once, not on every attempt.
    expect(toasts).toHaveLength(1)
  })

  it('saves on once that queue has been loaded', async () => {
    const { sync, playback, client, server } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    await sync.loadServerQueue()

    playback.addToQueue([makeSong('c')])
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
    expect(server.queue?.songs.map((song) => song.id)).toEqual(['x', 'y', 'c'])
  })

  it('saves over it by hand, and on by itself after that', async () => {
    const { sync, playback, client, server, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)

    await sync.saveServerQueueByHand()
    expect(server.queue?.songs.map((song) => song.id)).toEqual(['a'])
    expect(toasts).toEqual([['success', expect.any(String), expect.any(String)]])

    playback.addToQueue([makeSong('b')])
    await sync.saveServerQueue()
    expect(client.savePlayQueue).toHaveBeenCalledTimes(2)
  })

  it('recognises its own save after a restart', async () => {
    const first = await load()
    first.playback.setQueue([makeSong('a'), makeSong('b')], 1)
    first.playback.localPosition = 12.3456
    await first.sync.saveServerQueue()

    const second = await load(first.server)
    second.playback.setQueue([makeSong('a'), makeSong('b')], 1)
    second.playback.addToQueue([makeSong('c')])
    await second.sync.saveServerQueue()

    expect(second.client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  /** The plain form names the current song by id and hands back its first
   * copy - which must still read as this device's own save. */
  it('recognises its own save of a duplicated song in the plain form', async () => {
    const first = await load()
    first.client.getOpenSubsonicExtensions.mockResolvedValue(new Set())
    first.playback.setQueue([makeSong('a'), makeSong('b'), makeSong('a')], 2)
    await first.sync.saveServerQueue()
    // What the plain getPlayQueue hands back for it.
    first.server.queue!.currentIndex = 0

    const second = await load(first.server)
    second.client.getOpenSubsonicExtensions.mockResolvedValue(new Set())
    second.playback.setQueue([makeSong('a'), makeSong('b'), makeSong('a')], 2)
    second.playback.addToQueue([makeSong('c')])
    await second.sync.saveServerQueue()

    expect(second.client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  /** The one save that can't ask first. */
  it('saves on the way out only while the server copy was its own', async () => {
    const { sync, playback, client, server } = await load()
    sync.initServerQueueSync()
    playback.setQueue([makeSong('a')], 0)
    await sync.saveServerQueue()
    playback.isPlaying = true
    playback.localPosition = 50

    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(client.savePlayQueue).toHaveBeenCalledTimes(2))
    expect(client.savePlayQueue).toHaveBeenLastCalledWith(['a'], 0, 50, {
      byIndex: true,
      formPost: false,
      keepalive: true,
    })

    server.queue = serverQueue()
    playback.localPosition = 80
    await sync.saveServerQueue()
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    expect(client.savePlayQueue).toHaveBeenCalledTimes(2)
  })

  /** Seen as its own an hour ago, the server copy may have been saved
   * over by another device since - so the save that can't ask stays home. */
  it('does not save on the way out over a copy last seen long ago', async () => {
    const { sync, playback, client } = await load()
    sync.initServerQueueSync()
    playback.setQueue([makeSong('a')], 0)
    await sync.saveServerQueue()
    const seenAt = Date.now()

    vi.spyOn(Date, 'now').mockReturnValue(seenAt + 60 * 60_000)
    playback.addToQueue([makeSong('b')])
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  it("forgets what it knew about the server with the playback store's restore", async () => {
    const { sync, playback, client, server } = await load()
    sync.initServerQueueSync()
    playback.setQueue([makeSong('a')], 0)
    await sync.saveServerQueue()
    playback.persistNow()
    server.queue = serverQueue()

    playback.restoreFromStorage()
    playback.isPlaying = true
    playback.localPosition = 70
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })
})

describe('offering the queue saved elsewhere', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('offers a queue from another app, and loads it paused on request', async () => {
    const { sync, playback, client, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as { action: { onClick: () => void } }
    toast.action.onClick()
    expect(playback.queue.map((song) => song.id)).toEqual(['x', 'y'])
    expect(playback.currentIndex).toBe(1)
    expect(playback.localPosition).toBe(30)
    expect(playback.isPlaying).toBe(false)
    // Taking it over is not a change of this device's own to send back.
    await sync.saveServerQueue()
    expect(client.savePlayQueue).not.toHaveBeenCalled()
  })

  it('offers each saved queue once', async () => {
    const { sync, toasts } = await load({ queue: serverQueue() })

    await sync.checkServerQueue({ force: true })
    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(1)
  })

  it('does not interrupt anything playing here', async () => {
    const { sync, playback, client, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true

    await sync.checkServerQueue({ force: true })

    expect(client.getPlayQueue).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(0)
  })

  it("does not offer this device's own last save back to it", async () => {
    const { sync, playback, toasts } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    await sync.saveServerQueue()
    // Moved on here since, so only recognising its own save keeps it quiet.
    playback.currentIndex = 1

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(0)
  })

  it('does not offer what this device already has', async () => {
    const { sync, playback, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('x'), makeSong('y')], 1)
    playback.localPosition = 25

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(0)
  })
})

describe('another Beacon of the same account', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  /** The desktop at home, last used with queue D, while the phone carried
   * on with P on the way. */
  async function desktopAfterPhone() {
    const before = await load()
    before.playback.setQueue([makeSong('d1'), makeSong('d2')], 0)
    await before.sync.saveServerQueue()
    before.server.queue = serverQueue({ changedBy: 'beacon' })
    const desktop = await load(before.server)
    desktop.playback.setQueue([makeSong('d1'), makeSong('d2')], 0)
    return desktop
  }

  it("takes over the phone's queue by itself, paused", async () => {
    const { sync, playback, client, toasts } = await desktopAfterPhone()

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['x', 'y'])
    expect(playback.currentIndex).toBe(1)
    expect(playback.localPosition).toBe(30)
    expect(playback.isPlaying).toBe(false)
    // Neither asked nor announced.
    expect(toasts).toHaveLength(0)
    // Its own from here on.
    playback.addToQueue([makeSong('z')])
    await sync.saveServerQueue()
    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  it('asks instead where the queue here was edited and never saved', async () => {
    const { sync, playback, toasts } = await desktopAfterPhone()
    playback.addToQueue([makeSong('d3')])

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['d1', 'd2', 'd3'])
    expect(toasts).toEqual([expect.objectContaining({ action: expect.anything() })])
  })

  it('only takes over a queue Beacon saved', async () => {
    const { sync, playback, server, toasts } = await desktopAfterPhone()
    server.queue = serverQueue({ changedBy: 'feishin' })

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['d1', 'd2'])
    expect(toasts).toEqual([expect.objectContaining({ action: expect.anything() })])
  })

  /** A reload of a window that was playing resumes by itself - it must not
   * resume the phone's queue instead of its own. */
  it('asks instead on a reload of a window that was playing', async () => {
    const { sync, playback, toasts } = await desktopAfterPhone()
    sessionStorage.setItem('beacon.playback.session-was-playing', String(Date.now()))

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['d1', 'd2'])
    expect(toasts).toHaveLength(1)
  })

  it('leaves it alone when playback starts while the server is asked', async () => {
    const { sync, playback, client, server } = await desktopAfterPhone()
    client.getPlayQueue.mockImplementationOnce(async () => {
      playback.isPlaying = true
      return server.queue
    })

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['d1', 'd2'])
  })

  it('takes it over onto an empty queue', async () => {
    const { sync, playback, server } = await load({ queue: serverQueue({ changedBy: 'beacon' }) })

    await sync.checkServerQueue({ force: true })

    expect(playback.queue.map((song) => song.id)).toEqual(['x', 'y'])
    expect(server.queue?.changedBy).toBe('beacon')
  })
})

describe("the queue toolbar's load button", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** Asked for, so it doesn't wait for something to stop playing - but it
   * doesn't keep playing either. */
  it('replaces a playing queue, paused at the saved song', async () => {
    const { sync, playback } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true

    await sync.loadServerQueue()

    expect(playback.queue.map((song) => song.id)).toEqual(['x', 'y'])
    expect(playback.currentIndex).toBe(1)
    expect(playback.isPlaying).toBe(false)
  })

  it('says so when the server holds no queue', async () => {
    const { sync, playback, toasts } = await load()
    playback.setQueue([makeSong('a')], 0)

    await sync.loadServerQueue()

    expect(toasts).toHaveLength(1)
    expect(playback.queue.map((song) => song.id)).toEqual(['a'])
  })

  it('does not offer the queue it loaded as new afterwards', async () => {
    const { sync, playback, toasts } = await load({ queue: serverQueue() })
    await sync.loadServerQueue()
    // Somewhere else again, so only having taken it can keep the toast away.
    playback.setQueue([makeSong('a')], 0)

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(0)
  })

  it('leaves a cast alone', async () => {
    const { sync, playback, connect } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    vi.spyOn(connect, 'isActive', 'get').mockReturnValue(true)

    await sync.loadServerQueue()

    expect(playback.queue.map((song) => song.id)).toEqual(['a'])
  })
})

describe('whether the buttons have anything to do', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('lets the load button try while it does not know yet', async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a')], 0)

    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it("greys out loading once the server holds this device's own queue", async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    await sync.saveServerQueue()
    // Playing on since the last save, but not a periodic save further.
    playback.localPosition = 20

    expect(sync.serverQueueLoadState()).toBe('current')

    playback.currentIndex = 1
    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it('greys out loading when the server holds no queue', async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a')], 0)

    await sync.refreshServerQueueState()

    expect(sync.serverQueueLoadState()).toBe('empty')
  })

  it('offers loading a queue another device saved since', async () => {
    const { sync, playback, server } = await load()
    playback.setQueue([makeSong('x'), makeSong('y')], 1)
    await sync.saveServerQueue()
    server.queue = serverQueue({ position: 600 })

    await sync.refreshServerQueueState()

    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it('greys out loading while casting', async () => {
    const { sync, connect } = await load()
    vi.spyOn(connect, 'isActive', 'get').mockReturnValue(true)

    expect(sync.serverQueueLoadState()).toBe('casting')
  })

  it('greys out saving with nothing to save', async () => {
    const { sync, playback } = await load()
    expect(sync.canSaveServerQueue()).toBe(false)

    playback.setQueue([makeSong('a')], 0)
    expect(sync.canSaveServerQueue()).toBe(true)
  })
})

// initServerQueueSync() is once per app; without this, each test's copy of
// the module would go on hearing the pagehide of every test after it.
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = []

beforeEach(() => {
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push([target, type, listener])
      add(type, listener, options)
    })
  }
})

afterEach(() => {
  for (const [target, type, listener] of listeners.splice(0)) {
    target.removeEventListener(type, listener)
  }
  vi.restoreAllMocks()
})
