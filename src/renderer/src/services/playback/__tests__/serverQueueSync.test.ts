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

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a', 'b'], 1, 12, { byIndex: true })
  })

  /** A desktop left open for a week must not push its week-old queue over
   * the one a phone saved this morning just by being started. */
  it('does not push a queue it merely restored', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a')], 0)
    sync.markQueueRestored(['a'], 0)

    await sync.saveServerQueue()
    expect(client.savePlayQueue).not.toHaveBeenCalled()

    // ...until somebody does something with it here.
    playback.addToQueue([makeSong('b')])
    await sync.saveServerQueue()
    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  it("counts the playback store's own restore as restored", async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a')], 0)
    playback.persistNow()
    playback.$reset()

    playback.restoreFromStorage()
    await sync.saveServerQueue()

    expect(playback.queue).toHaveLength(1)
    expect(client.savePlayQueue).not.toHaveBeenCalled()
  })

  it('does push a restored queue once it plays here', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a')], 0)
    sync.markQueueRestored(['a'], 0)
    playback.isPlaying = true

    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
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

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a'], 0, 0, { byIndex: false })
  })
})

describe('offering the queue saved elsewhere', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('offers a newer queue from another app, and loads it paused on request', async () => {
    const { sync, playback, client, toasts } = await load()
    playback.setQueue([makeSong('a')], 0)
    client.getPlayQueue.mockResolvedValue(serverQueue())

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
    const { sync, client, toasts } = await load()
    client.getPlayQueue.mockResolvedValue(serverQueue())

    await sync.checkServerQueue({ force: true })
    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(1)
  })

  it('does not interrupt anything playing here', async () => {
    const { sync, playback, client, toasts } = await load()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true
    client.getPlayQueue.mockResolvedValue(serverQueue())

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
    const { sync, playback, client, toasts } = await load()
    playback.setQueue([makeSong('x'), makeSong('y')], 1)
    playback.localPosition = 25
    client.getPlayQueue.mockResolvedValue(serverQueue())

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(0)
  })
})

describe("the queue toolbar's load button", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** Asked for, so it doesn't wait for something to stop playing - but it
   * doesn't keep playing either. */
  it('replaces a playing queue, paused at the saved song', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('a')], 0)
    playback.isPlaying = true
    client.getPlayQueue.mockResolvedValue(serverQueue({ changed: 0 }))

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
    const { sync, playback, client, toasts } = await load()
    client.getPlayQueue.mockResolvedValue(serverQueue())
    await sync.loadServerQueue()
    // Somewhere else again, so only having taken it can keep the toast away.
    playback.setQueue([makeSong('a')], 0)

    await sync.checkServerQueue({ force: true })

    expect(toasts).toHaveLength(0)
  })

  it('leaves a cast alone', async () => {
    const { sync, playback, client, connect } = await load()
    playback.setQueue([makeSong('a')], 0)
    vi.spyOn(connect, 'isActive', 'get').mockReturnValue(true)
    client.getPlayQueue.mockResolvedValue(serverQueue())

    await sync.loadServerQueue()

    expect(playback.queue.map((song) => song.id)).toEqual(['a'])
  })
})

describe('whether the load button has anything to load', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('lets the button try while it does not know yet', async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a')], 0)

    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it("is greyed out once the server holds this device's own queue", async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    await sync.saveServerQueue()
    // Playing on since the last save, but not a periodic save further.
    playback.localPosition = 20

    expect(sync.serverQueueLoadState()).toBe('current')

    playback.currentIndex = 1
    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it('is greyed out when the server holds no queue', async () => {
    const { sync, playback } = await load()
    playback.setQueue([makeSong('a')], 0)

    await sync.refreshServerQueueState()

    expect(sync.serverQueueLoadState()).toBe('empty')
  })

  it('offers a queue another device saved since', async () => {
    const { sync, playback, client } = await load()
    playback.setQueue([makeSong('x'), makeSong('y')], 1)
    await sync.saveServerQueue()
    client.getPlayQueue.mockResolvedValue(serverQueue({ position: 600 }))

    await sync.refreshServerQueueState()

    expect(sync.serverQueueLoadState()).toBe('ready')
  })

  it('is greyed out while casting', async () => {
    const { sync, connect } = await load()
    vi.spyOn(connect, 'isActive', 'get').mockReturnValue(true)

    expect(sync.serverQueueLoadState()).toBe('casting')
  })
})

describe('never over a queue saved elsewhere', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** The case the whole check exists for: the desktop opens on last
   * week's queue, the phone saved a new one this morning, and a song gets
   * added here before anyone looked at the toast. */
  it('does not save edits to a stale queue over a newer one', async () => {
    const { sync, playback, client, server, toasts } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    sync.markQueueRestored(['a'], 0)

    playback.addToQueue([makeSong('b')])
    await sync.saveServerQueue()

    expect(client.savePlayQueue).not.toHaveBeenCalled()
    expect(server.queue?.changedBy).toBe('feishin')
    expect(toasts).toHaveLength(1)
  })

  /** Two devices both running: the one that didn't save last stops. */
  it('stops saving once another device has saved over it', async () => {
    const { sync, playback, client, server, toasts } = await load()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    await sync.saveServerQueue()
    server.queue = serverQueue()

    playback.isPlaying = true
    playback.localPosition = 90
    await sync.saveServerQueue()
    playback.localPosition = 120
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
    expect(server.queue.changedBy).toBe('feishin')
    // Offered once, not on every attempt.
    expect(toasts).toHaveLength(1)
  })

  it('saves again once that queue has been taken over', async () => {
    const { sync, playback, client, server } = await load({ queue: serverQueue() })
    playback.setQueue([makeSong('a')], 0)
    sync.markQueueRestored(['a'], 0)
    await sync.loadServerQueue()

    playback.addToQueue([makeSong('c')])
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
    expect(server.queue?.songs.map((song) => song.id)).toEqual(['x', 'y', 'c'])
  })

  /** Playing an album is a "now this", the same as it would be after
   * loading the other queue first. */
  it('lets a whole new queue replace it', async () => {
    const { sync, playback, client } = await load({ queue: serverQueue() })

    playback.setQueue([makeSong('n')], 0)
    await sync.saveServerQueue()

    expect(client.savePlayQueue).toHaveBeenCalledTimes(1)
  })

  it('recognises its own save after a restart', async () => {
    const first = await load()
    first.playback.setQueue([makeSong('a'), makeSong('b')], 1)
    first.playback.localPosition = 12.3456
    await first.sync.saveServerQueue()

    const second = await load(first.server)
    second.playback.setQueue([makeSong('a'), makeSong('b')], 1)
    second.sync.markQueueRestored(['a', 'b'], 1)
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
    second.sync.markQueueRestored(['a', 'b', 'a'], 2)
    second.playback.addToQueue([makeSong('c')])
    await second.sync.saveServerQueue()

    expect(second.client.savePlayQueue).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
