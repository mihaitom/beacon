import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import QueueDrawer from '../QueueDrawer.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

// QueueDrawer's <v-navigation-drawer> registers with Vuetify's layout
// system unconditionally (unlike v-footer, that isn't gated behind an
// `app` prop) — mounting it directly throws "Could not find injected
// layout" without a <v-app> ancestor to provide that. `host` is the real
// mount root; `drawer` is what test code actually asserts against.
function mountDrawer() {
  const host = mount(
    { components: { QueueDrawer }, template: '<v-app><queue-drawer model-value /></v-app>' },
    { global: { plugins: [vuetify, i18n] } },
  )
  return host.findComponent(QueueDrawer)
}

// jsdom never actually lays anything out — every element's
// getBoundingClientRect() is {top: 0, height: 0, ...} regardless of real
// DOM position. QueueDrawer's insertBeforeIndex() compares
// event.clientY against that rect's own vertical midpoint, so under jsdom
// the midpoint is always 0: a positive clientY reliably reads as "bottom
// half of the row", zero or negative as "top half" — not a real geometry
// check here, but a deterministic stand-in for driving the same branch.
// Each row's own reveal stagger, as QueueDrawer binds it: the inline
// transition-delay revealDelayStyle() produces, or undefined for a row
// that isn't part of the current reveal at all.
function revealDelays(wrapper: ReturnType<typeof mountDrawer>) {
  return wrapper.findAll('.queue-row').map((row) => {
    const match = /transition-delay:\s*([^;]+)/.exec(row.attributes('style') ?? '')
    return match ? match[1]!.trim() : undefined
  })
}

const TOP_HALF = { clientY: 0 }
const BOTTOM_HALF = { clientY: 1 }

describe('QueueDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the empty state and no clear/save-as-playlist buttons with nothing queued', () => {
    const wrapper = mountDrawer()

    expect(wrapper.text()).toContain('Queue is empty')
    expect(wrapper.find('.mdi-notification-clear-all').exists()).toBe(false)
    expect(wrapper.find('.mdi-playlist-plus').exists()).toBe(false)
  })

  it('renders one row per queued song, in order, with the current one marked', () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a', { title: 'Song A' }), makeSong('b', { title: 'Song B' })], 1)
    const wrapper = mountDrawer()

    const rows = wrapper.findAll('.queue-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Song A')
    expect(rows[1]!.text()).toContain('Song B')
    expect(rows[0]!.classes()).not.toContain('queue-row--current')
    expect(rows[1]!.classes()).toContain('queue-row--current')
  })

  // The reveal itself is Vue's own TransitionGroup enter transition, which
  // jsdom can't meaningfully run (no layout, no real transitionend) — what
  // *is* assertable here is the part QueueDrawer actually owns: which rows
  // get an inline transition-delay, what that delay is, and that it gets
  // cleaned back off again afterwards.
  it('staggers only genuinely new rows on a peek, leaving already-rendered ones untouched', async () => {
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    const wrapper = mountDrawer()
    // Rendered once already at mount, with no reveal — a fresh mount whose
    // queueRevealSeq is still 0 (no peek caused it) shows its rows plainly.
    expect(revealDelays(wrapper)).toEqual([undefined, undefined])

    // A real caller, not a bare peekQueueDrawer() — "Play Next" splices a
    // genuinely new song into the middle of the queue.
    playback.queueNext([makeSong('new')])
    await wrapper.vm.$nextTick()

    // Only the new row (now at index 1) carries a delay — 'a' and 'b' were
    // already visible and are left alone, so nothing of theirs can linger
    // to slow down some unrelated later transition on the same element.
    // REVEAL_BASE_DELAY_MS, since queueNext()'s own peek is what opened the
    // drawer in the store here (mountDrawer() only ever sets the prop) —
    // the already-open case is the next test's.
    expect(revealDelays(wrapper)).toEqual([undefined, '200ms', undefined])
  })

  it('starts the stagger from 0 for a live update while the drawer is already open', async () => {
    // Regression test (reported live 2026-08-25): "Play Next" into an
    // already-open drawer used to hide and re-reveal the *entire* queue at
    // once, fighting the TransitionGroup move animation already sliding
    // existing rows apart to make room — it read as the whole list
    // jittering rather than a clean insert. There's no drawer-opening
    // transition to wait out here either, unlike the very first peek, so
    // the new row's delay starts at 0 rather than REVEAL_BASE_DELAY_MS.
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    const wrapper = mountDrawer()
    playback.peekQueueDrawer() // opens it once, same as any real first peek
    await vi.advanceTimersByTimeAsync(1000)
    await wrapper.vm.$nextTick()

    playback.queueNext([makeSong('new'), makeSong('newer')])
    await wrapper.vm.$nextTick()

    // Two simultaneously-new rows stagger relative to each other by
    // ROW_STAGGER_MS, counted from within the batch itself rather than
    // from their absolute queue index.
    expect(revealDelays(wrapper)).toEqual([undefined, '0ms', '30ms', undefined])

    // ...and the whole thing is cleaned back off once the last row's
    // entrance has actually finished (30 + ROW_ENTER_TRANSITION_MS + 50).
    await vi.advanceTimersByTimeAsync(380)
    await wrapper.vm.$nextTick()
    expect(playback.queueRevealSongs).toEqual([])
    expect(revealDelays(wrapper)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('staggers every row, after the drawer-opening delay, the very first time it is peeked', async () => {
    // The one case where "reveal everything" remains correct: nothing has
    // rendered yet, so every row genuinely is new to the user's view. This
    // is the real app's actual shape for a first-ever peek — the drawer
    // component itself doesn't mount at all until the first
    // peekQueueDrawer() call (see DefaultLayout.vue), so the peek (and the
    // `immediate: true` watcher handler it triggers) always lands *before*
    // this component's own first render — unlike mountDrawer()'s other
    // callers above, which mount first and peek afterward. Every delay is
    // offset by REVEAL_BASE_DELAY_MS here, so nothing starts sliding in
    // until the drawer itself has finished opening.
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
    playback.peekQueueDrawer()

    const wrapper = mountDrawer()
    await wrapper.vm.$nextTick()

    expect(revealDelays(wrapper)).toEqual(['200ms', '230ms', '260ms'])
    // Rows are part of this component's very first render here, which a
    // TransitionGroup skips animating unless it's told to `appear`.
    expect(wrapper.find('.queue-scroll').exists()).toBe(true)
    expect(wrapper.vm.playbackStore.queueRevealSeq).toBeGreaterThan(0)
  })

  it('shows the clear-all button once there is more than one song, and clears the queue after its staggered fade-out', async () => {
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    const wrapper = mountDrawer()
    const clearSpy = vi.spyOn(playback, 'clearQueue')

    const clearBtn = wrapper.get('.mdi-notification-clear-all').element.closest('button')!
    await clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // Deliberately not called yet — the real state change waits out the
    // rows' own fade-out first (see onClearQueue()'s own comment).
    expect(clearSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(clearSpy).toHaveBeenCalledOnce()
  })

  it('fades rows out bottom-to-top from the visible anchor, instead of all at once', async () => {
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue(
      [makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d'), makeSong('e')],
      0,
    )
    const wrapper = mountDrawer()
    // jsdom never actually lays anything out (every getBoundingClientRect()
    // is all-zero, see this file's own TOP_HALF/BOTTOM_HALF comment for the
    // identical caveat elsewhere), so findVisibleAnchorIndex()'s own
    // measurement can't be exercised here — stub it directly instead,
    // simulating a view scrolled down to row 'd' (index 3).
    vi.spyOn(
      wrapper.vm as unknown as { findVisibleAnchorIndex(): number },
      'findVisibleAnchorIndex',
    ).mockReturnValue(3)

    const clearBtn = wrapper.get('.mdi-notification-clear-all').element.closest('button')!
    await clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.vm.$nextTick()

    // At/below the anchor ('d' index 3, 'e' index 4) fade together with no
    // delay at all — nothing to stagger for rows already past the bottom
    // of what's visible...
    let rows = wrapper.findAll('.queue-row')
    expect(rows[3]!.classes()).toContain('queue-row--clearing')
    expect(rows[4]!.classes()).toContain('queue-row--clearing')
    // ...but sweeping upward past the anchor only actually paces itself
    // once it reaches rows that are on screen ('c'/'b' above it) — this is
    // the actual bug report this test guards against: a single synchronous
    // class toggle across every row (differing only by CSS
    // transition-delay) turned out to just fade everything together
    // instead of staggering.
    expect(rows[2]!.classes()).not.toContain('queue-row--clearing')
    expect(rows[1]!.classes()).not.toContain('queue-row--clearing')

    await vi.advanceTimersByTimeAsync(30)
    await wrapper.vm.$nextTick()

    // 'c' (1 row above the anchor) picks up next, 'b' (2 rows above) still not yet.
    rows = wrapper.findAll('.queue-row')
    expect(rows[2]!.classes()).toContain('queue-row--clearing')
    expect(rows[1]!.classes()).not.toContain('queue-row--clearing')
  })

  it('plays a row on click', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
    const wrapper = mountDrawer()
    const playAtIndexSpy = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

    await wrapper.findAll('.queue-row')[2]!.trigger('click')

    expect(playAtIndexSpy).toHaveBeenCalledWith(2)
  })

  it('removes a song via its row button, but disables it for the currently playing row', async () => {
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b')], 0)
    const wrapper = mountDrawer()
    const removeSpy = vi.spyOn(playback, 'removeFromQueue')

    const rows = wrapper.findAll('.queue-row')
    const currentRemoveBtn = rows[0]!.get('.mdi-close').element.closest('button')!
    expect(currentRemoveBtn.hasAttribute('disabled')).toBe(true)

    const otherRemoveBtn = rows[1]!.get('.mdi-close').element.closest('button')!
    expect(otherRemoveBtn.hasAttribute('disabled')).toBe(false)
    await otherRemoveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(removeSpy).toHaveBeenCalledWith(1)
  })

  describe('save queue as playlist', () => {
    it('opens the create-playlist dialog from the toolbar button', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b')], 0)
      const wrapper = mountDrawer()
      const vm = wrapper.vm as unknown as { createPlaylistDialog: boolean }
      expect(vm.createPlaylistDialog).toBe(false)

      const saveBtn = wrapper.get('.mdi-playlist-plus').element.closest('button')!
      await saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(vm.createPlaylistDialog).toBe(true)
    })

    it('creates a playlist from the queue in its current order, then closes the dialog', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 1)
      const wrapper = mountDrawer()
      const library = useLibraryStore()
      const createSpy = vi.spyOn(library, 'createPlaylist').mockResolvedValue()
      const vm = wrapper.vm as unknown as {
        createPlaylistDialog: boolean
        createPlaylistName: string
        confirmCreatePlaylist(): Promise<void>
      }
      vm.createPlaylistDialog = true
      vm.createPlaylistName = 'My mix'

      await vm.confirmCreatePlaylist()

      // Whole queue, current order — already-played songs included, same
      // list QueueDrawer.vue itself renders, not just what's left to play.
      expect(createSpy).toHaveBeenCalledWith('My mix', ['a', 'b', 'c'])
      expect(vm.createPlaylistDialog).toBe(false)
    })

    it('does nothing when confirmed with a blank name', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a')], 0)
      const wrapper = mountDrawer()
      const library = useLibraryStore()
      const createSpy = vi.spyOn(library, 'createPlaylist').mockResolvedValue()
      const vm = wrapper.vm as unknown as {
        createPlaylistName: string
        confirmCreatePlaylist(): Promise<void>
      }
      vm.createPlaylistName = '   '

      await vm.confirmCreatePlaylist()

      expect(createSpy).not.toHaveBeenCalled()
    })
  })

  describe('drag to reorder', () => {
    it('dropping on the top half of a row inserts before it', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')], 0)
      const wrapper = mountDrawer()
      const reorderSpy = vi.spyOn(playback, 'reorderQueue')
      const rows = wrapper.findAll('.queue-row')

      // Drag row 3 ('d') and drop it on the top half of row 1 ('b') — should
      // land *before* 'b', i.e. reorderQueue(3, 1) with no index shift since
      // the target is already before the dragged item.
      await rows[3]!.get('.queue-row__handle').trigger('dragstart')
      await rows[1]!.trigger('dragover', TOP_HALF)
      await rows[1]!.trigger('drop', TOP_HALF)

      expect(reorderSpy).toHaveBeenCalledWith(3, 1)
    })

    it('dropping on the bottom half of a row inserts after it, shifted for the removal', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c'), makeSong('d')], 0)
      const wrapper = mountDrawer()
      const reorderSpy = vi.spyOn(playback, 'reorderQueue')
      const rows = wrapper.findAll('.queue-row')

      // Drag row 1 ('b') and drop it on the bottom half of row 3 ('d') —
      // insertBeforeIndex would be 4 (after 'd'), but removing 'b' first
      // shifts every later original index left by one, so the actual
      // reorderQueue() target is 3, not 4.
      await rows[1]!.get('.queue-row__handle').trigger('dragstart')
      await rows[3]!.trigger('dragover', BOTTOM_HALF)
      await rows[3]!.trigger('drop', BOTTOM_HALF)

      expect(reorderSpy).toHaveBeenCalledWith(1, 3)
    })

    it('does not reorder when dropped back onto its own original slot', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
      const wrapper = mountDrawer()
      const reorderSpy = vi.spyOn(playback, 'reorderQueue')
      const rows = wrapper.findAll('.queue-row')

      // Dropping row 1 on its own top half: insertBeforeIndex(1) === 1,
      // dropIndex resolves to the same 1 it started at — a no-op drag.
      await rows[1]!.get('.queue-row__handle').trigger('dragstart')
      await rows[1]!.trigger('drop', TOP_HALF)

      expect(reorderSpy).not.toHaveBeenCalled()
    })

    it('shows a drag-over indicator on the row currently under the pointer, cleared on dragleave', async () => {
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
      const wrapper = mountDrawer()
      const rows = wrapper.findAll('.queue-row')

      await rows[0]!.get('.queue-row__handle').trigger('dragstart')
      await rows[2]!.trigger('dragover', BOTTOM_HALF)
      expect(wrapper.findAll('.queue-row')[2]!.classes()).toContain('queue-row--drag-over-after')

      await rows[2]!.trigger('dragleave')
      expect(wrapper.findAll('.queue-row')[2]!.classes()).not.toContain(
        'queue-row--drag-over-after',
      )
    })
  })

  it('switches to virtual scrolling past the queue-length threshold', () => {
    const playback = usePlaybackStore()
    const bigQueue = Array.from({ length: 501 }, (_, i) => makeSong(`s${i}`))
    playback.setQueue(bigQueue, 0)
    const wrapper = mountDrawer()

    expect(wrapper.findComponent({ name: 'VVirtualScroll' }).exists()).toBe(true)
    expect(wrapper.find('.queue-scroll').exists()).toBe(false)
  })
})
