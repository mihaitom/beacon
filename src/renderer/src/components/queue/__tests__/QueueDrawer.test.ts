import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
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
const TOP_HALF = { clientY: 0 }
const BOTTOM_HALF = { clientY: 1 }

describe('QueueDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the empty state and no clear button with nothing queued', () => {
    const wrapper = mountDrawer()

    expect(wrapper.text()).toContain('Queue is empty')
    expect(wrapper.find('.mdi-notification-clear-all').exists()).toBe(false)
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

  it('reveals rows one at a time after a peek, via a class toggle rather than remounting them', async () => {
    vi.useFakeTimers()
    const playback = usePlaybackStore()
    playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
    const wrapper = mountDrawer()

    playback.peekQueueDrawer()
    await wrapper.vm.$nextTick()

    // Every row starts hidden, waiting on its own staggered timer...
    let rows = wrapper.findAll('.queue-row')
    expect(rows[0]!.classes()).toContain('queue-row--reveal-pending')
    expect(rows[1]!.classes()).toContain('queue-row--reveal-pending')

    await vi.advanceTimersByTimeAsync(200) // REVEAL_BASE_DELAY_MS
    await wrapper.vm.$nextTick()

    // ...the first one reveals once that elapses, the next one not yet.
    rows = wrapper.findAll('.queue-row')
    expect(rows[0]!.classes()).not.toContain('queue-row--reveal-pending')
    expect(rows[1]!.classes()).toContain('queue-row--reveal-pending')

    await vi.advanceTimersByTimeAsync(30)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.queue-row')[1]!.classes()).not.toContain('queue-row--reveal-pending')
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
