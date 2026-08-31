import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { useAuthStore } from '@/stores/auth'
import CoverArt, { MAX_CONCURRENT_LOADS as MAX } from '../CoverArt.vue'

const vuetify = createVuetify({ components, directives })

/** Stand-in for the browser's IntersectionObserver so a test can say
 * exactly when a cover scrolls in and back out again — jsdom has none, and
 * what's under test here is precisely the timing between those two. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  disconnected = false
  observed: unknown = null

  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: unknown): void {
    // The real API throws on anything that isn't an Element, and this
    // component is a fragment (template comments between its two root
    // branches), so `$el` is a comment node rather than the box being
    // watched — a difference jsdom would otherwise happily swallow.
    if (!(target instanceof Element)) {
      throw new TypeError("parameter 1 is not of type 'Element'")
    }
    this.observed = target
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }

  emit(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function lastObserver(): FakeIntersectionObserver {
  const observer = FakeIntersectionObserver.instances.at(-1)
  if (!observer) throw new Error('nothing observed')
  return observer
}

/** One fetch the component started, which the test decides the fate of —
 * whether it succeeds, fails, or is still on the wire when the cover is
 * scrolled away. */
interface Request {
  url: string
  aborted: boolean
  done: boolean
  succeed(): void
  fail(): void
}

let requests: Request[] = []

function inFlight(): Request[] {
  return requests.filter((r) => !r.aborted && !r.done)
}

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request: Request = {
      url,
      aborted: false,
      done: false,
      succeed() {
        request.done = true
        resolve({ ok: true, blob: async () => new Blob(['img']) } as Response)
      },
      fail() {
        request.done = true
        resolve({ ok: false, status: 404 } as Response)
      },
    }
    init?.signal?.addEventListener('abort', () => {
      request.aborted = true
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
    requests.push(request)
  })
}

/** Lets the component's fetch → blob → render chain run to completion.
 * flushPromises() can't be used here: it waits on a real timer, and these
 * tests drive the settle delay with fake ones. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

const mounted: ReturnType<typeof mount>[] = []

function mountCover(props: Record<string, unknown> = {}) {
  const wrapper = mount(CoverArt, {
    props: { coverArtId: 'cover-1', size: 48, ...props },
    global: { plugins: [vuetify] },
  })
  mounted.push(wrapper)
  return wrapper
}

/** Brings a cover to the point where it would fetch: into view, past the
 * settle delay, and through the concurrency queue if there is room.
 *
 * Generic (rather than `wrapper: ReturnType<typeof mount>`) so the caller's
 * own specific wrapper type — CoverArt's actual props, not the bare
 * fallback `mount()`'s unparameterized overload resolves to — survives the
 * round trip. Passing it straight through as `wrapper: ReturnType<typeof
 * mount>` used to widen every caller's wrapper to that generic type,
 * breaking hasImage()'s own more specific parameter type below. */
async function scrollIntoRest<T extends ReturnType<typeof mount>>(wrapper: T): Promise<T> {
  lastObserver().emit(true)
  vi.advanceTimersByTime(200)
  await flush()
  return wrapper
}

function unmount(wrapper: ReturnType<typeof mount>) {
  wrapper.unmount()
  mounted.splice(mounted.indexOf(wrapper), 1)
}

function hasImage(wrapper: ReturnType<typeof mountCover>): boolean {
  return wrapper.find('.v-img').exists()
}

describe('CoverArt', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({
      connectUrl: 'http://beacon.test',
      credential: 'u=thomas&t=abc&s=def',
    })
    vi.useFakeTimers()
    requests = []
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    // jsdom has neither, and the component's whole point is that it holds
    // the image itself rather than letting <img src> fetch it.
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:cover-${++n}`)
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    // Unmounting frees any concurrency slot the cover still holds — the
    // bookkeeping is module-wide, so a leak here would change the next test.
    while (mounted.length) mounted.pop()!.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('requests nothing for a cover that is merely scrolled past', () => {
    // The reported symptom: scrolling a 15,000-song list to the bottom
    // fetched every single cover on the way, because entering the viewport
    // was all it took. A row passed at scrolling speed is on screen for a
    // frame or two, nowhere near the settle delay.
    mountCover()
    lastObserver().emit(true)
    vi.advanceTimersByTime(20)
    lastObserver().emit(false)
    vi.advanceTimersByTime(5000)

    expect(requests).toHaveLength(0)
  })

  it('fetches and shows a cover the scroll comes to rest on', async () => {
    const wrapper = await scrollIntoRest(mountCover())
    expect(requests[0]!.url).toContain('getCoverArt.view')

    requests[0]!.succeed()
    await flush()

    expect(hasImage(wrapper)).toBe(true)
    expect(wrapper.html()).toContain('blob:cover-1')
  })

  it('watches its own box, not the fragment comment node in front of it', () => {
    const wrapper = mountCover()

    expect(lastObserver().observed).toBe(wrapper.find('.cover-art').element)
  })

  it('watches the right element in the rounded (avatar) variant too', () => {
    // That branch's ref resolves to a component rather than an element.
    const wrapper = mountCover({ rounded: true })

    expect(lastObserver().observed).toBeInstanceOf(Element)
    expect(wrapper.html()).toContain('v-avatar')
  })

  it('shows the skeleton, not the missing-cover icon, while gated', () => {
    // A gated cover is "not loaded yet", not "has no art" — falling back to
    // the placeholder icon here would make a fast scroll look like a
    // library full of songs without artwork.
    const wrapper = mountCover()

    expect(wrapper.find('.cover-art-skeleton').exists()).toBe(true)
    expect(wrapper.find('.mdi-album').exists()).toBe(false)
  })

  it('shows the fallback icon when there is no cover at all', () => {
    const wrapper = mountCover({ coverArtId: null })

    expect(wrapper.find('.cover-art-skeleton').exists()).toBe(false)
    expect(wrapper.find('.cover-art-fallback').exists()).toBe(true)
  })

  it('leaves an image on a foreign host to <img>, and does not fetch it', async () => {
    // Artist photos come from the media server as pre-signed URLs on
    // someone else's CDN, radio favicons from the station's own site.
    // Neither sends CORS headers, so fetching them fails outright where a
    // plain <img src> renders them - and neither goes anywhere near the
    // infrastructure the fetch path exists to protect.
    const wrapper = await scrollIntoRest(mountCover({ imageUrl: 'http://cdn.example/artist.jpg' }))

    expect(requests).toHaveLength(0)
    expect(wrapper.html()).toContain('http://cdn.example/artist.jpg')
  })

  it('falls back to the next candidate when a foreign photo 404s', async () => {
    // An artist without a photo must still end up showing the album cover.
    const wrapper = await scrollIntoRest(mountCover({ imageUrl: 'http://cdn.example/artist.jpg' }))

    wrapper.findComponent({ name: 'VImg' }).vm.$emit('error')
    await flush()
    expect(requests[0]!.url).toContain('getCoverArt.view')

    requests[0]!.succeed()
    await flush()

    expect(wrapper.html()).toContain('blob:cover-1')
  })

  it('loads immediately where there is no IntersectionObserver', async () => {
    // jsdom, or a browser old enough to lack it: a cover that never appears
    // would be a worse failure than one requested too eagerly.
    vi.stubGlobal('IntersectionObserver', undefined)
    mountCover()
    await flush()

    expect(requests).toHaveLength(1)
  })

  // ── cancelling what nobody is looking at any more ─────────────────────────
  // The reason the fetching isn't left to <v-img src>: a request already on
  // the wire has to be stoppable. Vuetify's VImg renders a plain <img>, and
  // whether tearing that down aborts the request is up to the browser's
  // garbage collector — not something to build a network budget on.

  it('aborts a fetch still on the wire when the cover scrolls out of view', async () => {
    await scrollIntoRest(mountCover())
    expect(inFlight()).toHaveLength(1)

    lastObserver().emit(false)
    await flush()

    expect(requests[0]!.aborted).toBe(true)
  })

  it('aborts a fetch still on the wire when the row is unmounted', async () => {
    // What a virtualized list does by the hundred while scrolling.
    const wrapper = await scrollIntoRest(mountCover())

    unmount(wrapper)
    await flush()

    expect(requests[0]!.aborted).toBe(true)
  })

  it('fetches again when a cancelled cover comes back into view', async () => {
    // Cancelling has to be recoverable: scrolling past something and then
    // back to it is ordinary browsing, and must not leave a permanent hole.
    const wrapper = mountCover()
    const observer = lastObserver()
    await scrollIntoRest(wrapper)
    observer.emit(false)
    await flush()
    expect(requests[0]!.aborted).toBe(true)

    observer.emit(true)
    vi.advanceTimersByTime(200)
    await flush()

    expect(requests).toHaveLength(2)
    expect(requests[1]!.aborted).toBe(false)
  })

  it('keeps a cover that has already arrived when it scrolls back out', async () => {
    const wrapper = await scrollIntoRest(mountCover())
    requests[0]!.succeed()
    await flush()

    lastObserver().emit(false)
    await flush()

    expect(hasImage(wrapper)).toBe(true)
  })

  it('keeps watching while the fetch is in flight, and stops once it lands', async () => {
    // Disconnecting at the moment the fetch starts (what it used to do, when
    // a started load couldn't be taken back anyway) would mean never hearing
    // about the scroll-away that should abort it.
    await scrollIntoRest(mountCover())
    const observer = lastObserver()
    expect(observer.disconnected).toBe(false)

    requests[0]!.succeed()
    await flush()

    expect(observer.disconnected).toBe(true)
  })

  it('drops a pending request when its row is unmounted mid-settle', () => {
    const wrapper = mountCover()
    const observer = lastObserver()
    observer.emit(true)
    unmount(wrapper)
    vi.advanceTimersByTime(5000)

    expect(observer.disconnected).toBe(true)
    expect(requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the image it was holding when it goes away', async () => {
    const wrapper = await scrollIntoRest(mountCover())
    requests[0]!.succeed()
    await flush()

    unmount(wrapper)

    // An object URL keeps its blob alive until revoked, and this component
    // exists by the thousand.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover-1')
  })

  // ── how many may load at once ─────────────────────────────────────────────
  // Regression tests for the outage on 2026-08-23: a settling list fired
  // every visible cover at once, which over HTTP/2 the browser no longer
  // caps, and the burst took down the reverse proxy's authorisation
  // middleware — which then denied the casting streams' own media fetches.
  // See docs/playback-bugs/mid-track-drop-reverse-proxy-403.md, "The mechanism".

  it('never has more than the limit fetching at once', async () => {
    for (let i = 0; i < MAX + 4; i++) await scrollIntoRest(mountCover())

    expect(requests).toHaveLength(MAX)
  })

  it('starts a waiting cover as soon as one finishes', async () => {
    for (let i = 0; i < MAX + 1; i++) await scrollIntoRest(mountCover())
    expect(requests).toHaveLength(MAX)

    requests[0]!.succeed()
    await flush()

    expect(requests).toHaveLength(MAX + 1)
  })

  it('hands the place on when a fetch fails, not just when it succeeds', async () => {
    for (let i = 0; i < MAX + 1; i++) await scrollIntoRest(mountCover())

    requests[0]!.fail()
    await flush()

    expect(requests).toHaveLength(MAX + 1)
  })

  it('hands the place on when a fetch is aborted', async () => {
    // The cancellation above must not strand the slot it was holding, or a
    // fast scroll would quietly starve the queue it is meant to protect.
    const covers = []
    for (let i = 0; i < MAX + 1; i++) covers.push(await scrollIntoRest(mountCover()))

    unmount(covers[0]!)
    await flush()

    expect(requests).toHaveLength(MAX + 1)
  })

  it('gives up its place when it scrolls away while still queued', async () => {
    /** Otherwise a fast scroll through a long list still fetches every cover
     * it passed - just spread out over the queue instead of all at once. */
    for (let i = 0; i < MAX + 1; i++) await scrollIntoRest(mountCover())

    lastObserver().emit(false) // the queued one scrolls out of view again
    requests[0]!.succeed()
    await flush()

    expect(requests).toHaveLength(MAX)
  })

  // ── candidates changing mid-fetch (a track/album changing under an
  // already-visible cover, e.g. NowPlayingView.vue's own art) ────────────
  // Regression tests for a real bug (2026-08-24): the candidates() watcher
  // aborted the in-flight fetch and immediately called queueLoad() again,
  // which - with no guard against a load already running - took a *second*
  // concurrency slot and started a second, overlapping loadCandidates()
  // call on the same instance. Both shared this.holdsLoadSlot, so whichever
  // one's `finally` ran last reset it regardless of which fetch it actually
  // belonged to - observed live as a cover stuck on its skeleton forever
  // even though its fetch had already completed successfully.

  it('reuses its held slot instead of taking a second one when candidates change mid-fetch', async () => {
    const wrapper = await scrollIntoRest(mountCover({ coverArtId: 'cover-1' }))
    expect(inFlight()).toHaveLength(1)

    // Simulates a track change while this exact instance (e.g. the
    // now-playing view's own art) is still fetching the previous one.
    await wrapper.setProps({ coverArtId: 'cover-2' })
    await flush()

    // The old fetch was aborted and exactly one new one made - never two
    // racing at once for what is still a single instance.
    expect(requests).toHaveLength(2)
    expect(requests[0]!.aborted).toBe(true)
    expect(requests[1]!.url).toContain('cover-2')
    expect(inFlight()).toHaveLength(1)
  })

  it('shows the new cover after candidates change mid-fetch, not a permanent skeleton', async () => {
    const wrapper = await scrollIntoRest(mountCover({ coverArtId: 'cover-1' }))
    await wrapper.setProps({ coverArtId: 'cover-2' })
    await flush()

    requests[1]!.succeed()
    await flush()

    expect(hasImage(wrapper)).toBe(true)
  })

  it('does not orphan a still-queued load when candidates change before it ever starts', async () => {
    for (let i = 0; i < MAX; i++) await scrollIntoRest(mountCover())
    // The (MAX+1)th has no slot yet - still sitting in `waiting`.
    const queued = await scrollIntoRest(mountCover({ coverArtId: 'cover-queued-1' }))
    expect(requests).toHaveLength(MAX)

    // Its own candidates change again before it was ever granted a slot.
    await queued.setProps({ coverArtId: 'cover-queued-2' })
    await flush()

    // Freeing a slot must start exactly one request for this instance (the
    // current candidate) - not a leftover one for the stale candidate plus
    // a fresh one for the new one.
    requests[0]!.succeed()
    await flush()

    expect(requests).toHaveLength(MAX + 1)
    expect(requests[MAX]!.url).toContain('cover-queued-2')
  })

  // Regression tests for a second real bug (2026-08-31): after a first
  // attempt that failed, an always-visible cover - the player bar's own art
  // - stayed empty for the rest of the app's life. The watcher below only
  // re-loaded a cover that was showing something or already fetching, and a
  // failed one is neither; the observer, meanwhile, only ever reports
  // *changes*, and a cover that never leaves the viewport produces no
  // further entry to react to. In the packaged app the first attempt fails
  // routinely: the persisted queue is restored synchronously at startup
  // (playback store init()), so the bar renders a cover art URL built from
  // an auth store that has no credential yet.

  it('retries after auth catches up on a cover whose first attempt failed', async () => {
    useAuthStore().$patch({ connectUrl: 'http://beacon.test', credential: '' })
    const wrapper = await scrollIntoRest(mountCover({ coverArtId: 'cover-1' }))
    requests[0]!.fail()
    await flush()
    expect(hasImage(wrapper)).toBe(false)

    useAuthStore().$patch({ credential: 'u=thomas&t=abc&s=def' })
    await flush()

    expect(requests).toHaveLength(2)
    requests[1]!.succeed()
    await flush()
    expect(hasImage(wrapper)).toBe(true)
  })

  it('retries on the next track after a failed attempt, rather than staying empty', async () => {
    const wrapper = await scrollIntoRest(mountCover({ coverArtId: 'cover-1' }))
    requests[0]!.fail()
    await flush()

    await wrapper.setProps({ coverArtId: 'cover-2' })
    await flush()

    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toContain('cover-2')
  })

  it('still fetches nothing for a cover that is off screen when its candidates change', async () => {
    const wrapper = mountCover({ coverArtId: 'cover-1' })
    lastObserver().emit(true)
    vi.advanceTimersByTime(20)
    lastObserver().emit(false) // scrolled past before it ever settled

    await wrapper.setProps({ coverArtId: 'cover-2' })
    vi.advanceTimersByTime(5000)
    await flush()

    expect(requests).toHaveLength(0)
  })
})
