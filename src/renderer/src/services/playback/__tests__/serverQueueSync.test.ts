import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { ServerPlayQueue } from '@/services/subsonic/client'

vi.mock('@/services/audioEngine', () => ({
  getAudioEngine: () => ({ load: vi.fn(), play: vi.fn(), stop: vi.fn(), pause: vi.fn() }),
}))

// The module keeps what it has saved and restored between calls, so each
// test gets a fresh copy of it - and of the stores it reads.
async function load() {
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
    getPlayQueue: vi.fn(async (): Promise<ServerPlayQueue | null> => null),
    savePlayQueue: vi.fn(async () => {}),
    streamUrl: () => 'http://media/song',
  }
  const library = useLibraryStore()
  vi.spyOn(library, 'client').mockReturnValue(
    client as unknown as ReturnType<typeof library.client>,
  )
  const toasts: unknown[] = []
  emitter.on('toast', (toast) => toasts.push(toast))
  return { sync, playback: usePlaybackStore(), auth, client, toasts, connect: useConnectStore() }
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
      keepalive: false,
    })
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

    expect(client.savePlayQueue).toHaveBeenCalledWith(['a'], 0, 0, {
      byIndex: false,
      keepalive: false,
    })
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
    const { sync, playback, client, toasts } = await load()
    playback.setQueue([makeSong('a')], 0)
    playback.addToQueue([makeSong('b')])
    await sync.saveServerQueue()
    // The server's copy is a few seconds older than our own clock says.
    client.getPlayQueue.mockResolvedValue(
      serverQueue({ songs: [makeSong('z')], currentIndex: 0, changed: Date.now() + 2000 }),
    )

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

afterEach(() => {
  vi.restoreAllMocks()
})
