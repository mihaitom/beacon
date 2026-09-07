import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { AUTOPLAY_BATCH_SIZE, useAutoplayStore } from '../autoplay'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { useDrawersStore } from '../drawers'
import { usePlaybackStore } from '../playback'
import * as connectPlayback from '@/services/connect/playback'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import type { SubsonicClient } from '@/services/subsonic/client'
import { makeSong, makeStatus } from './fixtures'

vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn() }))

vi.mock('@/services/connect/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/connect/playback')>()
  return { ...actual, updateQueue: vi.fn() }
})

/** Autoplay tops the queue back up shortly before it would run dry, so
 * playback never just stops on its own — see the store's own
 * AUTOPLAY_TRIGGER_REMAINING. */
describe('maybeAutoplay', () => {
  let similar: ReturnType<typeof vi.fn>

  function stubSimilar(
    result: { songs: ReturnType<typeof makeSong>[]; plexPassRequired?: boolean } = { songs: [] },
  ): void {
    similar = vi.fn().mockResolvedValue({ plexPassRequired: false, ...result })
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      getSimilarSongs2: similar,
    } as unknown as SubsonicClient)
  }

  beforeEach(() => {
    vi.useFakeTimers() // the queue peek on a top-up arms a real close timer
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    useAutoplayStore().enabled = true
  })

  afterEach(() => {
    emitter.all.clear()
    vi.useRealTimers()
  })

  it('tops the queue up once it is down to the last song or so', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x'), makeSong('y')] })
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    await playback.maybeAutoplay()

    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b', 'x', 'y'])
  })

  /** How many songs a top-up adds is the app's own answer now, not a
   * setting: the four-way select in Settings asked people to pick a number
   * none of them could have an opinion about before trying it. Pinned to
   * the literal 10 rather than to the constant alone, so changing it back
   * is a deliberate edit here too, not something a refactor does quietly. */
  it('adds ten songs, the number the app settled on', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: Array.from({ length: 30 }, (_, i) => makeSong(`x${i}`)) })
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    await playback.maybeAutoplay()

    expect(playback.queue).toHaveLength(2 + 10)
    expect(AUTOPLAY_BATCH_SIZE).toBe(10)
  })

  // Reported live 2026-09-07: ten asked for, five already in the queue,
  // three added. The batch size counts songs that actually extend the
  // queue, so the request has to over-fetch by however much of it the
  // queue could swallow.
  it('still adds ten new songs when half the pool is already queued', async () => {
    const playback = usePlaybackStore()
    const queued = Array.from({ length: 20 }, (_, i) => makeSong(`q${i}`))
    // What a real pool looks like once the queue grew out of it: every
    // second candidate is something this queue already holds.
    stubSimilar({
      songs: Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? makeSong(`q${i / 2}`) : makeSong(`new${i}`),
      ),
    })
    playback.setQueue(queued, queued.length - 1)

    await playback.maybeAutoplay()

    const added = playback.queue.slice(20).map((s) => s.id)
    expect(added).toHaveLength(10)
    expect(added.every((id) => id.startsWith('new'))).toBe(true)
  })

  it('asks for enough candidates that a queue-length worth of repeats cannot starve it', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalledWith('b', 12)
  })

  // Without a ceiling the request grows with the queue forever — a session
  // left running all day would ask for hundreds of candidates to use ten.
  it('stops asking for more candidates once the queue is very long', async () => {
    const playback = usePlaybackStore()
    const queue = Array.from({ length: 300 }, (_, i) => makeSong(`q${i}`))
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue(queue, queue.length - 1)

    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalledWith('q299', 100)
  })

  it('leaves a queue with plenty left in it alone', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')], 0)

    await playback.maybeAutoplay()

    expect(similar).not.toHaveBeenCalled()
  })

  it('stays out of the way while it is switched off', async () => {
    const playback = usePlaybackStore()
    useAutoplayStore().enabled = false
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue([makeSong('a')], 0)

    await playback.maybeAutoplay()

    expect(similar).not.toHaveBeenCalled()
  })

  it('has nothing to extend for a radio station', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue([makeSong('a')], 0)
    playback.radioStation = {
      id: 'r1',
      name: 'Chill FM',
      streamUrl: 'https://stream.example/chill',
      homePageUrl: null,
    }

    await playback.maybeAutoplay()

    expect(similar).not.toHaveBeenCalled()
  })

  it('leaves a repeating queue alone, which never runs out by itself', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x')] })
    playback.setQueue([makeSong('a')], 0)
    playback.repeatMode = 'all'

    await playback.maybeAutoplay()

    expect(similar).not.toHaveBeenCalled()
  })

  it('has no seed to work from before anything is playing', async () => {
    const playback = usePlaybackStore()
    stubSimilar({ songs: [makeSong('x')] })

    await playback.maybeAutoplay()

    expect(similar).not.toHaveBeenCalled()
  })

  it('skips over songs already sitting in the queue rather than re-adding them', async () => {
    // A small library's recommendation pool keeps circling back to what
    // has just been played; without this, a top-up could add nothing new
    // and the queue would still run out.
    const playback = usePlaybackStore()
    const a = makeSong('a')
    stubSimilar({ songs: [makeSong('a'), makeSong('x')] })
    playback.setQueue([a], 0)

    await playback.maybeAutoplay()

    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'x'])
  })

  // A library small enough that its whole similar-songs pool is already in
  // the queue: nothing to add is a normal end, not an error. The queue runs
  // out and playback stops there, rather than the same songs being cycled
  // back in to keep it going.
  it('adds nothing, quietly, once the pool holds nothing the queue lacks', async () => {
    const playback = usePlaybackStore()
    const drawers = useDrawersStore()
    stubSimilar({ songs: [makeSong('a'), makeSong('b')] })
    playback.setQueue([makeSong('a'), makeSong('b')], 1)

    // Counted across the call, not read as a state: setQueue() above peeks
    // on its own, so what matters is that the top-up adds no peek of its
    // own on top of it.
    const peeksBefore = drawers.queueRevealSeq

    await playback.maybeAutoplay()

    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'b'])
    // "Quietly" is the whole point: a top-up that added nothing must not
    // peek the queue drawer open at whoever is listening, and would on
    // every song change from here to the end of the queue.
    expect(drawers.queueRevealSeq).toBe(peeksBefore)
  })

  // Casting turns every status tick into a top-up call (adoptCastQueue()),
  // so a pool with nothing left to give was re-asked every ~2s for as long
  // as the last song played — a request storm at exactly the library size
  // where the answer can never change.
  it('asks once for a seed that came back empty, not on every status tick', async () => {
    const playback = usePlaybackStore()
    const library = Array.from({ length: 10 }, (_, i) => makeSong(`s${i}`))
    stubSimilar({ songs: library })
    playback.setQueue(library, library.length - 1)

    for (let tick = 0; tick < 10; tick++) await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalledOnce()
  })

  it('asks again once the queue has grown past the seed it gave up on', async () => {
    const playback = usePlaybackStore()
    const library = [makeSong('s0'), makeSong('s1')]
    stubSimilar({ songs: library })
    playback.setQueue(library, 1)

    await playback.maybeAutoplay()
    // Anything extending the queue moves the seed, and the new one has
    // never been asked — a manual "add to queue" while listening, say.
    playback.addToQueue([makeSong('manual')])
    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalledTimes(2)
    expect(similar.mock.calls.at(-1)![0]).toBe('manual')
  })

  it('runs one top-up at a time, however many song changes ask for one', async () => {
    // A cast session gets a status tick every couple of seconds, so several
    // calls can land before the first round trip even returns.
    const playback = usePlaybackStore()
    let release = (): void => {}
    const pending = new Promise<{ songs: never[]; plexPassRequired: boolean }>((resolve) => {
      release = () => resolve({ songs: [], plexPassRequired: false })
    })
    similar = vi.fn().mockReturnValue(pending)
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      getSimilarSongs2: similar,
    } as unknown as SubsonicClient)
    playback.setQueue([makeSong('a')], 0)

    const first = playback.maybeAutoplay()
    await playback.maybeAutoplay()

    expect(similar).toHaveBeenCalledOnce()

    release()
    await first
  })

  it('turns itself off, and says why, on a server that needs a Plex Pass', async () => {
    // A standing setting, unlike Song Radio's one-off — leaving it on would
    // mean the same refusal at every single song change.
    const playback = usePlaybackStore()
    const toasts: { title: string }[] = []
    emitter.on('toast', (toast) => toasts.push(toast as { title: string }))
    stubSimilar({ songs: [], plexPassRequired: true })
    playback.setQueue([makeSong('a')], 0)

    await playback.maybeAutoplay()

    expect(useAutoplayStore().enabled).toBe(false)
    expect(toasts[0]!.title).toBe(i18n.global.t('player.autoplay'))
  })

  it('leaves the queue as it is when the lookup fails', async () => {
    const playback = usePlaybackStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    similar = vi.fn().mockRejectedValue(new Error('502'))
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
      getSimilarSongs2: similar,
    } as unknown as SubsonicClient)
    playback.setQueue([makeSong('a')], 0)

    await playback.maybeAutoplay()

    expect(playback.queue.map((s) => s.id)).toEqual(['a'])

    // The lock has to come back off, or nothing would ever top up again.
    stubSimilar({ songs: [makeSong('x')] })
    await playback.maybeAutoplay()
    expect(playback.queue.map((s) => s.id)).toEqual(['a', 'x'])
  })
})

/** Autoplay decides whether the *backend* tops the queue up while casting
 * (routes/stream.py's _maybe_autoplay_topup), which makes it a setting of
 * the session rather than of one device. */
describe('Autoplay while casting', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(connectPlayback.updateQueue).mockResolvedValue({ status: 'ok' })
  })

  function castTo(): void {
    useConnectStore().status = makeStatus({
      targets: [{ name: 'Living Room', type: 'sonos' }],
    })
  }

  it('tells connect the moment it is switched off, not at the next song', async () => {
    // Until it hears, the backend keeps appending songs from the value it
    // still holds — which is exactly what "turned it off and the queue kept
    // growing" looked like.
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    castTo()
    useAutoplayStore().enabled = true

    playback.setAutoplayEnabled(false)

    expect(useAutoplayStore().enabled).toBe(false)
    expect(connectPlayback.updateQueue).toHaveBeenCalledWith(
      ['a', 'b'],
      0,
      expect.objectContaining({ autoplayEnabled: false }),
    )
  })

  it('keeps it to this device when nothing is being cast to', () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)

    playback.setAutoplayEnabled(true)

    expect(useAutoplayStore().enabled).toBe(true)
    expect(connectPlayback.updateQueue).not.toHaveBeenCalled()
  })

  it('adopts what the session reports, rather than trusting its own storage', async () => {
    // A phone that only ever sent transport commands never corrected the
    // session's value, so it showed "off" over a queue that was visibly
    // growing.
    const playback = usePlaybackStore()
    const song = makeSong('a')
    playback.setQueue([song], 0)
    useAutoplayStore().enabled = false

    await playback.adoptCastQueue(makeStatus({ queue: ['a'], autoplay_enabled: true }))

    expect(useAutoplayStore().enabled).toBe(true)
  })

  it('adopts it being switched off elsewhere too', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a')], 0)
    useAutoplayStore().enabled = true

    await playback.adoptCastQueue(makeStatus({ queue: ['a'], autoplay_enabled: false }))

    expect(useAutoplayStore().enabled).toBe(false)
  })
})
