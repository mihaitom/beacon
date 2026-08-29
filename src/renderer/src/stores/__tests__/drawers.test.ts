import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDrawersStore } from '../drawers'

// Split out of playback.peek-queue-drawer.test.ts when the drawers moved
// into their own store (2026-08-29). What stayed behind there is the other
// half of this: that playSongList()/addToQueue()/queueNext() actually reach
// for these actions at the right moment.

describe('peekQueueDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the drawer and flags that this call is the one opening it', () => {
    const drawers = useDrawersStore()

    drawers.peekQueueDrawer([])

    expect(drawers.queueDrawerOpen).toBe(true)
    // QueueDrawer.vue's own startReveal() reads this to decide whether to
    // wait out the drawer's opening transition before revealing anything —
    // only relevant the moment it's actually opening from closed.
    expect(drawers.queueRevealNeedsOpenDelay).toBe(true)
  })

  it('does not flag an opening delay for a peek while the drawer is already open', () => {
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([]) // first peek: opens it
    expect(drawers.queueRevealNeedsOpenDelay).toBe(true)

    drawers.peekQueueDrawer([]) // second peek: already open, e.g. Play Next mid-browse

    expect(drawers.queueDrawerOpen).toBe(true)
    expect(drawers.queueRevealNeedsOpenDelay).toBe(false)
  })

  it('bumps queueRevealSeq on every call regardless of whether it was already open', () => {
    const drawers = useDrawersStore()

    drawers.peekQueueDrawer([])
    expect(drawers.queueRevealSeq).toBe(1)

    drawers.peekQueueDrawer([])
    expect(drawers.queueRevealSeq).toBe(2)
  })

  it('flags an opening delay again once the drawer has actually closed in between', () => {
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([])
    drawers.setQueueDrawerOpen(false)

    drawers.peekQueueDrawer([])

    expect(drawers.queueRevealNeedsOpenDelay).toBe(true)
  })
})

// QUEUE_DRAWER_PEEK_MS itself isn't exported (module-private, same as the
// timer handle it drives) — 4000 here is that same value, not re-derived.
const QUEUE_DRAWER_PEEK_MS = 4000

describe('peekQueueDrawer auto-close timer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-closes on its own after the peek window, absent anything else happening', () => {
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([])

    vi.advanceTimersByTime(QUEUE_DRAWER_PEEK_MS - 1)
    expect(drawers.queueDrawerOpen).toBe(true)

    vi.advanceTimersByTime(1)
    expect(drawers.queueDrawerOpen).toBe(false)
  })

  it('re-arms the countdown when a second peek lands while the first is still pending, instead of closing on the original schedule', () => {
    // Reported live 2026-08-27: autoplay's own top-up (or any other peek)
    // arriving partway through an already-open peek's countdown used to
    // leave that stale timer running untouched — the drawer then closed on
    // the *original* schedule, potentially right out from under a reveal
    // that had only just started.
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([])

    vi.advanceTimersByTime(QUEUE_DRAWER_PEEK_MS - 1000) // 1s left on the original countdown
    drawers.peekQueueDrawer([]) // a second, independent peek — e.g. autoplay's top-up

    // The original countdown's own deadline passes — still open, because
    // the second peek reset it rather than leaving it to fire on schedule.
    vi.advanceTimersByTime(1000)
    expect(drawers.queueDrawerOpen).toBe(true)

    // A full fresh window after the *second* peek, though, does close it.
    vi.advanceTimersByTime(QUEUE_DRAWER_PEEK_MS - 1000)
    expect(drawers.queueDrawerOpen).toBe(false)
  })

  it('never arms a close timer for a drawer the user opened manually', () => {
    const drawers = useDrawersStore()
    drawers.setQueueDrawerOpen(true)

    drawers.peekQueueDrawer([]) // already open — not this call's to auto-close

    vi.advanceTimersByTime(QUEUE_DRAWER_PEEK_MS * 2)
    expect(drawers.queueDrawerOpen).toBe(true)
  })

  it('does not re-arm after a mouseenter has cancelled the pending close for good', () => {
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([])
    drawers.cancelQueueDrawerAutoClose() // the user is looking at it right now

    drawers.peekQueueDrawer([]) // more content arrives while they're still there

    vi.advanceTimersByTime(QUEUE_DRAWER_PEEK_MS * 2)
    expect(drawers.queueDrawerOpen).toBe(true)
  })
})

describe('the drawer toggles', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('opens and closes the queue drawer, cancelling any pending peek close', () => {
    // Routing through setQueueDrawerOpen() is what keeps a stale peek timer
    // from shutting a drawer the user has just reopened by hand.
    vi.useFakeTimers()
    const drawers = useDrawersStore()
    drawers.peekQueueDrawer([])

    drawers.toggleQueueDrawer()
    expect(drawers.queueDrawerOpen).toBe(false)

    drawers.toggleQueueDrawer()
    expect(drawers.queueDrawerOpen).toBe(true)

    vi.advanceTimersByTime(10_000)
    expect(drawers.queueDrawerOpen).toBe(true)
  })

  it('opens and closes the lyrics drawer', () => {
    const drawers = useDrawersStore()

    drawers.toggleLyricsDrawer()
    expect(drawers.lyricsDrawerOpen).toBe(true)

    drawers.toggleLyricsDrawer()
    expect(drawers.lyricsDrawerOpen).toBe(false)
  })
})
