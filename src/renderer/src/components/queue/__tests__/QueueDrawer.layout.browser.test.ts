// Real-browser tests for QueueDrawer.vue's scroll-to-current-track and
// reveal-animation behavior — run via `pnpm test:layout`. jsdom never
// actually lays anything out (every getBoundingClientRect() is all-zero
// there, per the unit test file's own TOP_HALF/BOTTOM_HALF comment) and
// applies no real CSS transitions either, so neither "does the current row
// end up centered" nor "does a new row's transform genuinely animate, and
// only once real time has actually elapsed" can be checked against jsdom —
// both need a real layout/rendering engine.
//
// Scroll-to-current pins a real bug (reported live 2026-08-25): the current
// track wasn't centered when the drawer opened. Root cause was in the
// `modelValue` watcher, not in scrollToCurrent() itself — DefaultLayout.vue
// never mounts this component at all until queueDrawerOpen is already true
// (see that watcher's own comment), so on the very first ever open,
// `modelValue` is `true` from this component's first tick of existing —
// there is no false→true *change* within its own lifetime for a plain,
// non-immediate watcher to observe, so it silently never fired and the
// centering scroll never ran. Every later close/reopen already had a live
// instance around to watch a real transition on, which is why this read as
// "sometimes works" rather than "always broken".
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount } from '@vue/test-utils'
import { h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import QueueDrawer from '../QueueDrawer.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

// @vue/test-utils stubs <transition>/<transition-group> out by default,
// which would replace the very thing these tests exist to measure with an
// inert <transition-group-stub>: no enter/leave classes ever applied, so
// every row renders straight at its end state and the reveal looks like it
// simply isn't there. These are real-browser layout tests — they need the
// real components.
const REAL_TRANSITIONS = { transition: false, 'transition-group': false }

// Every test in this file shares one real, persistent page — so a mount
// that's still attached leaks its rows into the next test's own
// document.querySelector('[data-queue-index=...]'), which then measures a
// settled row from the previous test instead of the fresh one it meant to.
// A per-test unmount() at the end of each test body isn't enough: a test
// that fails never reaches its last line, turning one genuine failure into
// a cascade of misleading ones in every test after it.
const mounted: { unmount: () => void }[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

function track<T extends { unmount: () => void }>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

/** Mounts QueueDrawer with `model-value` already `true` from the very
 * first render — the exact shape of DefaultLayout.vue's real first-ever
 * open (the component doesn't exist before then at all), which a
 * subsequent prop *change* can't reproduce. */
function mountAlreadyOpen() {
  return track(
    mount(
      {
        render: () =>
          h(components.VApp, null, { default: () => h(QueueDrawer, { modelValue: true }) }),
      },
      { attachTo: document.body, global: { plugins: [vuetify, i18n], stubs: REAL_TRANSITIONS } },
    ),
  )
}

describe('QueueDrawer scroll-to-current layout', () => {
  it('centers the current track on the very first ever open', async () => {
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    const songs = Array.from({ length: 60 }, (_, i) => makeSong(String(i), { title: `Song ${i}` }))
    playback.setQueue(songs, 30) // deep enough that it starts off-screen

    mountAlreadyOpen()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const container = document.querySelector('.queue-scroll') as HTMLElement
    const currentRow = document.querySelector('[data-queue-index="30"]') as HTMLElement
    const containerRect = container.getBoundingClientRect()
    const rowRect = currentRow.getBoundingClientRect()

    // The regression: this used to be 0 — the row never scrolled into view
    // at all on a fresh mount.
    expect(container.scrollTop).toBeGreaterThan(0)
    const rowCenter = rowRect.top + rowRect.height / 2
    const containerCenter = containerRect.top + containerRect.height / 2
    expect(Math.abs(rowCenter - containerCenter)).toBeLessThan(rowRect.height)
  })

  it('still centers it on a later close/reopen, which already worked', async () => {
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    const songs = Array.from({ length: 60 }, (_, i) => makeSong(String(i), { title: `Song ${i}` }))
    playback.setQueue(songs, 45)

    const open = ref(false)
    const host = track(
      mount(
        {
          render: () =>
            h(components.VApp, null, {
              default: () => h(QueueDrawer, { modelValue: open.value }),
            }),
        },
        { attachTo: document.body, global: { plugins: [vuetify, i18n], stubs: REAL_TRANSITIONS } },
      ),
    )
    open.value = true
    await host.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const container = document.querySelector('.queue-scroll') as HTMLElement
    const currentRow = document.querySelector('[data-queue-index="45"]') as HTMLElement
    const containerRect = container.getBoundingClientRect()
    const rowRect = currentRow.getBoundingClientRect()

    expect(container.scrollTop).toBeGreaterThan(0)
    const rowCenter = rowRect.top + rowRect.height / 2
    const containerCenter = containerRect.top + containerRect.height / 2
    expect(Math.abs(rowCenter - containerCenter)).toBeLessThan(rowRect.height)
  })
})

/** Mounts QueueDrawer with its `model-value` driven straight from
 * `playbackStore.queueDrawerOpen`, the same single source of truth
 * DefaultLayout.vue's own `:model-value="playbackStore.queueDrawerOpen"`
 * binding uses in the real app — unlike mountAlreadyOpen() above (a
 * hardcoded `true`, disconnected from the store), this is what the
 * reveal-timing tests below actually need: peekQueueDrawer()'s own
 * `wasAlreadyOpen`/queueRevealNeedsOpenDelay logic reads this exact same
 * store field, so the component's visible open/closed state and the
 * store's own idea of it can never drift apart the way two independently
 * driven refs could. */
function mountBoundToStore() {
  const playback = usePlaybackStore()
  return track(
    mount(
      {
        render: () =>
          h(components.VApp, null, {
            default: () => h(QueueDrawer, { modelValue: playback.queueDrawerOpen }),
          }),
      },
      { attachTo: document.body, global: { plugins: [vuetify, i18n], stubs: REAL_TRANSITIONS } },
    ),
  )
}

// A row on its way *out* keeps its data-queue-index while it fades, and
// .queue-move-leave-active makes it position:absolute rather than removing
// it — so during a queue replacement a plain
// querySelector('[data-queue-index="0"]') can hand back the outgoing row
// from the previous queue instead of the incoming one being measured (it
// then reads a half-faded 0.59 mid-leave, or an empty '' once it's finally
// detached).
function revealRow(index: number) {
  return document.querySelector(
    `[data-queue-index="${index}"]:not(.queue-move-leave-active)`,
  ) as HTMLElement
}

describe('QueueDrawer reveal animation layout', () => {
  it('slides a genuinely new row in from the right, not just fading it', async () => {
    // The already-open case (Play Next while the drawer is open and being
    // watched) — the one originally reported — so this checks the slide
    // itself without the drawer's own 200ms opening wait also elapsing.
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    playback.peekQueueDrawer() // opens it once, same as any real first peek
    mountBoundToStore()
    await new Promise((resolve) => setTimeout(resolve, 300)) // settle the initial reveal

    playback.queueNext([makeSong('new', { title: 'Inserted' })])
    await new Promise((resolve) => setTimeout(resolve, 20)) // mid-transition, not settled yet

    const newRow = document.querySelector('[data-queue-index="1"]') as HTMLElement
    // Still offset to the right and not yet fully opaque this early —
    // TransitionGroup's own .queue-move-enter-active transition is
    // genuinely in flight, not skipped straight to its end state.
    expect(getComputedStyle(newRow).transform).not.toBe('none')
    expect(Number(getComputedStyle(newRow).opacity)).toBeLessThan(1)

    // Comfortably past ROW_ENTER_TRANSITION_MS (300) counted from the
    // frame the entrance actually started on, which is a frame or two
    // after the insert itself — waiting exactly 300 lands right on the
    // boundary and reads a not-quite-finished eased value.
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Settled back to its natural position, fully visible.
    expect(getComputedStyle(newRow).transform).toBe('none')
    expect(getComputedStyle(newRow).opacity).toBe('1')
  })

  it('animates the rows in on a peek that also mounts the drawer for the first time', async () => {
    // DefaultLayout.vue doesn't mount this component at all until the
    // drawer first opens, so a Song Radio started from a closed drawer
    // renders every row as part of this TransitionGroup's *initial*
    // render — which Vue skips animating unless told to `appear`. Without
    // that prop the whole reveal silently doesn't happen on exactly the
    // path most likely to trigger it.
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
    playback.peekQueueDrawer() // before mounting, same order as the real app

    mountBoundToStore()
    await new Promise((resolve) => setTimeout(resolve, 100)) // inside REVEAL_BASE_DELAY_MS

    const firstRow = document.querySelector('[data-queue-index="0"]') as HTMLElement
    // Still waiting out the drawer's own opening transition.
    expect(getComputedStyle(firstRow).opacity).toBe('0')

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(getComputedStyle(firstRow).opacity).toBe('1')
    expect(getComputedStyle(firstRow).transform).toBe('none')
  })

  it('waits for the drawer to actually be open before revealing a Play Next row', async () => {
    // The other stated requirement: a "Play Next" while the drawer is
    // closed must not start sliding the new row in before the drawer
    // itself has visibly finished opening (Vuetify's own
    // VNavigationDrawer transition-duration is 0.2s, matching
    // REVEAL_BASE_DELAY_MS) — a reveal mid-slide-open would be animating
    // something the user can't even see yet.
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    const host = mountBoundToStore() // starts closed — queueDrawerOpen defaults false
    await new Promise((resolve) => setTimeout(resolve, 100))

    // "Play Next" from elsewhere in the app, while this drawer is closed —
    // opens it and inserts in the same call, same as the real store action.
    playback.queueNext([makeSong('new', { title: 'Inserted' })])
    await host.vm.$nextTick()

    const newRow = document.querySelector('[data-queue-index="1"]') as HTMLElement
    await new Promise((resolve) => setTimeout(resolve, 100)) // well before REVEAL_BASE_DELAY_MS
    // Still fully hidden — nothing has started yet.
    expect(getComputedStyle(newRow).opacity).toBe('0')

    // Past REVEAL_BASE_DELAY_MS (200) plus ROW_ENTER_TRANSITION_MS (300),
    // with the same headroom the test above needs.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(getComputedStyle(newRow).opacity).toBe('1')
  })

  it('animates a second full-queue replacement too, not just the first one', async () => {
    // Reported live 2026-08-26: starting a Song Radio animated the queue in
    // the first time and never again. The first time only looked right
    // because DefaultLayout.vue hadn't mounted this component yet, making
    // that one an initial render `appear` covers; from the second time on
    // the instance is still around, so the reveal has to genuinely work on
    // an existing, mounted-but-closed drawer.
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    playback.peekQueueDrawer() // first Song Radio, before the mount
    const host = mountBoundToStore()
    await new Promise((resolve) => setTimeout(resolve, 700)) // let it fully settle

    // The peek's own auto-close timer, fast-forwarded — this is what leaves
    // a mounted-but-closed drawer for the next replacement to arrive into.
    playback.queueDrawerOpen = false
    await host.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Second Song Radio, in playSongList(peek: true)'s real order: the
    // queue swap and the peek in one synchronous tick, with only the track
    // actually starting left to await afterwards.
    playback.setQueue([makeSong('x'), makeSong('y'), makeSong('z')], 0)
    playback.peekQueueDrawer()

    await new Promise((resolve) => setTimeout(resolve, 100)) // inside REVEAL_BASE_DELAY_MS
    const firstRow = revealRow(0)
    // Still waiting out the drawer's own opening transition, rather than
    // having quietly entered and settled while it was shut.
    expect(getComputedStyle(firstRow).opacity).toBe('0')

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(getComputedStyle(firstRow).opacity).toBe('1')
    expect(getComputedStyle(firstRow).transform).toBe('none')
  })

  it('staggers a full-queue replacement into an already-open drawer', async () => {
    // Same replacement, but with the drawer already open and the user
    // watching — no opening delay to wait out, so the rows start straight
    // away, but still one after another rather than all at once.
    await page.viewport(1200, 800)
    setActivePinia(createPinia())
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    playback.peekQueueDrawer()
    mountBoundToStore()
    await new Promise((resolve) => setTimeout(resolve, 700)) // settled, still open

    playback.setQueue([makeSong('x'), makeSong('y'), makeSong('z')], 0)
    playback.peekQueueDrawer()

    // Well into the first row's own entrance (no base delay to wait out for
    // an already-open drawer) but still short of ROW_ENTER_TRANSITION_MS
    // even for it, so all three are mid-flight and their ROW_STAGGER_MS
    // offsets are readable as a gradient.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const rows = [0, 1, 2].map(revealRow)
    const opacities = rows.map((row) => Number(getComputedStyle(row).opacity))
    // The regression this pins: with the peek arriving an await after the
    // mutation, the rows had no delays yet when Vue rendered them, so all
    // three entered together and this read a flat 1/1/1.
    expect(opacities[0]).toBeGreaterThan(0)
    expect(opacities[0]).toBeGreaterThan(opacities[1]!)
    expect(opacities[1]).toBeGreaterThan(opacities[2]!)

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(rows.map((row) => getComputedStyle(row).opacity)).toEqual(['1', '1', '1'])
  })
})
