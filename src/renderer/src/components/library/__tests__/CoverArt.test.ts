import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { useAuthStore } from '@/stores/auth'
import CoverArt from '../CoverArt.vue'

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

function mountCover(props: Record<string, unknown> = {}) {
  return mount(CoverArt, {
    props: { coverArtId: 'cover-1', size: 48, ...props },
    global: { plugins: [vuetify] },
  })
}

function imageCount(wrapper: ReturnType<typeof mountCover>): number {
  return wrapper.findAll('.v-img').length
}

describe('CoverArt', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({
      connectUrl: 'http://beacon.test',
      credential: 'u=thomas&t=abc&s=def',
    })
    vi.useFakeTimers()
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('requests nothing for a cover that is merely scrolled past', () => {
    // The reported symptom: scrolling a 15,000-song list to the bottom
    // fetched every single cover on the way, because entering the viewport
    // was all it took. A row passed at scrolling speed is on screen for a
    // frame or two, nowhere near the settle delay.
    const wrapper = mountCover()
    lastObserver().emit(true)
    vi.advanceTimersByTime(20)
    lastObserver().emit(false)
    vi.advanceTimersByTime(5000)

    expect(imageCount(wrapper)).toBe(0)
  })

  it('requests a cover the scroll actually comes to rest on', async () => {
    const wrapper = mountCover()
    lastObserver().emit(true)
    vi.advanceTimersByTime(200)
    await wrapper.vm.$nextTick()

    expect(imageCount(wrapper)).toBe(1)
    expect(wrapper.html()).toContain('getCoverArt.view')
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

  it('keeps a loaded cover loaded when it scrolls back out of view', async () => {
    const wrapper = mountCover()
    lastObserver().emit(true)
    vi.advanceTimersByTime(200)
    await wrapper.vm.$nextTick()
    lastObserver().emit(false)
    await wrapper.vm.$nextTick()

    expect(imageCount(wrapper)).toBe(1)
  })

  it('stops observing once it has decided to load', () => {
    const wrapper = mountCover()
    const observer = lastObserver()
    observer.emit(true)
    vi.advanceTimersByTime(200)

    expect(observer.disconnected).toBe(true)
    wrapper.unmount()
  })

  it('drops a pending request when its row is unmounted mid-settle', () => {
    // What a virtualized list does by the hundred while scrolling — the
    // timer must not fire against a row that no longer exists.
    const wrapper = mountCover()
    const observer = lastObserver()
    observer.emit(true)
    wrapper.unmount()
    vi.advanceTimersByTime(5000)

    expect(observer.disconnected).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads immediately where there is no IntersectionObserver', async () => {
    // jsdom, or a browser old enough to lack it: a cover that never appears
    // would be a worse failure than one requested too eagerly.
    vi.stubGlobal('IntersectionObserver', undefined)
    const wrapper = mountCover()
    await wrapper.vm.$nextTick()

    expect(imageCount(wrapper)).toBe(1)
  })

  it('shows the fallback icon when there is no cover at all', () => {
    const wrapper = mountCover({ coverArtId: null })

    expect(wrapper.find('.cover-art-skeleton').exists()).toBe(false)
    expect(wrapper.find('.cover-art-fallback').exists()).toBe(true)
  })
})
