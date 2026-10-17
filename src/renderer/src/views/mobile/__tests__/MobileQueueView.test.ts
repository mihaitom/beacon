import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import MobileQueueRow from '@/components/mobile/MobileQueueRow.vue'
import MobileQueueView from '../MobileQueueView.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

const vuetify = createVuetify({ components, directives })

function mountView() {
  return mount(MobileQueueView, {
    global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
  })
}

/** The tail of a real drag: the browser dispatches pointerup, then
 * synthesises a click from the same pointer sequence onto whichever
 * element the press and the release share. A mouse does that within the
 * same task; `delayTasks` is how the same tail arrives from touch, which
 * doesn't (see the phone case below). */
async function endDragOverRow(
  wrapper: ReturnType<typeof mountView>,
  index: number,
  delayTasks = false,
) {
  window.dispatchEvent(new Event('pointerup'))
  await wrapper.vm.$nextTick()
  if (delayTasks) await vi.advanceTimersByTimeAsync(0)
  wrapper.findAllComponents(MobileQueueRow)[index]!.trigger('click')
  await wrapper.vm.$nextTick()
}

/** Drags row `from` onto the far side of row `to` — a real reorder, unlike
 * the release-in-place drags the click tests use. */
function dragRowOnto(wrapper: ReturnType<typeof mountView>, from: number, to: number) {
  wrapper.findAllComponents(MobileQueueRow)[from]!.vm.$emit('drag-start', new Event('pointerdown'))
  const vm = wrapper.vm as unknown as { overIndex: number; overHalf: 'before' | 'after' }
  vm.overIndex = to
  vm.overHalf = 'after'
}

describe('MobileQueueView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usePlaybackStore().setQueue([makeSong('a'), makeSong('b')], 1)
  })

  it('marks the queue position with a speaker icon', () => {
    const wrapper = mountView()

    expect(wrapper.findAll('.mobile-queue-row--current')).toHaveLength(1)
    expect(wrapper.findAll('.mdi-volume-high')).toHaveLength(1)
  })

  describe('reordering', () => {
    /** Reported live 2026-09-05: dragging a row to a new position also
     * started playing it. MobileQueueRow's own `!dragging` guard was meant
     * to cover exactly this, but dragIndex is back to null by the time the
     * synthesised click arrives. */
    it('does not play the row a drag just finished on', async () => {
      const wrapper = mountView()
      const playback = usePlaybackStore()
      const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

      wrapper.findAllComponents(MobileQueueRow)[0]!.vm.$emit('drag-start', new Event('pointerdown'))
      await endDragOverRow(wrapper, 0)

      expect(playAtIndex).not.toHaveBeenCalled()
    })

    /** The suppression covers exactly one click — a tap afterwards is a
     * tap, not the tail of the drag before it. */
    it('plays again on the next tap after a drag', async () => {
      vi.useFakeTimers()
      const wrapper = mountView()
      const playback = usePlaybackStore()
      const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

      wrapper.findAllComponents(MobileQueueRow)[0]!.vm.$emit('drag-start', new Event('pointerdown'))
      await endDragOverRow(wrapper, 0)
      expect(playAtIndex).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(0)
      await wrapper.findAllComponents(MobileQueueRow)[0]!.trigger('click')

      expect(playAtIndex).toHaveBeenCalledWith(0)
      vi.useRealTimers()
    })

    /** Reported live 2026-09-12, phone only: swapping two rows started
     * playing the one that had just been moved. Touch doesn't synthesise
     * its click in the same task as pointerup the way a mouse does, so a
     * suppression that expired on the next task was already gone again by
     * the time the click landed. */
    it('does not play the row a swap just moved, when the click trails the drag', async () => {
      vi.useFakeTimers()
      const playback = usePlaybackStore()
      playback.setQueue([makeSong('a'), makeSong('b'), makeSong('c')], 0)
      const wrapper = mountView()
      const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

      dragRowOnto(wrapper, 1, 2)
      await endDragOverRow(wrapper, 2, true)

      expect(playback.queue.map((song) => song.id)).toEqual(['a', 'c', 'b'])
      expect(playAtIndex).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('plays a row that was only ever tapped', async () => {
      const wrapper = mountView()
      const playback = usePlaybackStore()
      const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()

      await wrapper.findAllComponents(MobileQueueRow)[1]!.trigger('click')

      expect(playAtIndex).toHaveBeenCalledWith(1)
    })

    /** The same click also ended the station, because playAtIndex() leaves
     * radio — which is how "I reordered the queue" turned into "the radio
     * stopped". The queue only has rows to drag during radio at all
     * because a station no longer clears it. */
    it('leaves a playing station alone', async () => {
      const wrapper = mountView()
      const playback = usePlaybackStore()
      playback.radioStation = {
        id: 'r1',
        name: 'Some Radio',
        streamUrl: 'http://station/stream',
        homePageUrl: null,
      }
      const leaveRadio = vi.spyOn(playback, 'leaveRadio')
      await wrapper.vm.$nextTick()

      wrapper.findAllComponents(MobileQueueRow)[0]!.vm.$emit('drag-start', new Event('pointerdown'))
      await endDragOverRow(wrapper, 0)

      expect(leaveRadio).not.toHaveBeenCalled()
      expect(playback.radioStation).not.toBeNull()
    })

    /** The drop target is found by hit-testing the rows under the finger,
     * and in the virtualized list they share their parent with the
     * scroller's spacers. */
    it('drops below the row the pointer is over the lower half of', async () => {
      const wrapper = mountView()
      const playback = usePlaybackStore()
      const reorderQueue = vi.spyOn(playback, 'reorderQueue')
      for (const row of wrapper.findAllComponents(MobileQueueRow)) {
        const top = row.props('index') * 60
        vi.spyOn(row.element, 'getBoundingClientRect').mockReturnValue(
          DOMRect.fromRect({ x: 0, y: top, width: 300, height: 60 }),
        )
      }

      wrapper.findAllComponents(MobileQueueRow)[0]!.vm.$emit('drag-start', new Event('pointerdown'))
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 60 + 45 }))
      window.dispatchEvent(new Event('pointerup'))

      expect(reorderQueue).toHaveBeenCalledWith(0, 1)
    })

    /** The list rides the shell's pane, and a finger held still near its
     * bottom keeps it scrolling - with the drop target following the rows
     * that pass under it, without the finger moving at all. */
    it('scrolls the pane while the finger holds still near its edge', async () => {
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      })
      vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0))
      const pane = document.createElement('div')
      pane.style.overflowY = 'auto'
      pane.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 300 })
      document.body.append(pane)
      const playback = usePlaybackStore()
      playback.setQueue(
        Array.from({ length: 10 }, (_, i) => makeSong(`s${i}`)),
        0,
      )
      const wrapper = mount(MobileQueueView, {
        attachTo: pane,
        global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
      })
      await wrapper.vm.$nextTick()
      const reorderQueue = vi.spyOn(playback, 'reorderQueue')
      for (const row of wrapper.findAllComponents(MobileQueueRow)) {
        vi.spyOn(row.element, 'getBoundingClientRect').mockImplementation(() =>
          DOMRect.fromRect({
            x: 0,
            y: row.props('index') * 60 - pane.scrollTop,
            width: 300,
            height: 60,
          }),
        )
      }

      wrapper.findAllComponents(MobileQueueRow)[0]!.vm.$emit('drag-start', new Event('pointerdown'))
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 295 }))
      let now = performance.now()
      for (let i = 0; i < 20; i++) {
        now += 16
        frames.splice(0).forEach((callback) => callback(now))
      }
      window.dispatchEvent(new Event('pointerup'))

      expect(pane.scrollTop).toBeGreaterThan(0)
      // Without the scroll, row 4's lower half: in after it, at 4.
      expect(reorderQueue.mock.calls[0]![1]).toBeGreaterThan(4)
      wrapper.unmount()
      pane.remove()
      vi.unstubAllGlobals()
    })
  })

  describe('long press', () => {
    // The sheet loads the playlists for its picker as it opens.
    beforeEach(() => {
      vi.spyOn(useLibraryStore(), 'fetchPlaylists').mockResolvedValue()
    })

    function touch(element: Element, type: string, clientY = 0) {
      const event = Object.assign(new Event(type, { bubbles: true }), {
        pointerType: 'touch',
        clientX: 0,
        clientY,
      })
      element.dispatchEvent(event)
    }
    const touchDown = (element: Element) => touch(element, 'pointerdown')

    it("opens the row's actions once let go without moving, and the release does not play it", async () => {
      vi.useFakeTimers()
      // Attached: the release's click is caught on window.
      const wrapper = mount(MobileQueueView, {
        attachTo: document.body,
        global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
      })
      const playAtIndex = vi.spyOn(usePlaybackStore(), 'playAtIndex').mockResolvedValue()
      const row = wrapper.findAllComponents(MobileQueueRow)[0]!

      touchDown(row.element)
      await vi.advanceTimersByTimeAsync(500)
      expect((wrapper.vm as unknown as { actionsOpen: boolean }).actionsOpen).toBe(false)
      touch(row.element, 'pointerup')
      await row.trigger('click')

      const vm = wrapper.vm as unknown as { actionsOpen: boolean; actionsIndex: number }
      expect(vm.actionsOpen).toBe(true)
      expect(vm.actionsIndex).toBe(0)
      expect(playAtIndex).not.toHaveBeenCalled()
      wrapper.unmount()
      vi.useRealTimers()
    })

    /** No handle: a held row moved is a drag, wherever it was held. */
    it('drags a held row that is then moved, without opening or playing it', async () => {
      vi.useFakeTimers()
      const wrapper = mount(MobileQueueView, {
        attachTo: document.body,
        global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
      })
      const playback = usePlaybackStore()
      const playAtIndex = vi.spyOn(playback, 'playAtIndex').mockResolvedValue()
      const row = wrapper.findAllComponents(MobileQueueRow)[0]!

      touchDown(row.element)
      await vi.advanceTimersByTimeAsync(500)
      touch(row.element, 'pointermove', 40)
      await wrapper.vm.$nextTick()

      const vm = wrapper.vm as unknown as { actionsOpen: boolean; dragIndex: number | null }
      expect(vm.dragIndex).toBe(0)
      touch(row.element, 'pointerup', 40)
      await row.trigger('click')

      expect(vm.actionsOpen).toBe(false)
      expect(playAtIndex).not.toHaveBeenCalled()
      wrapper.unmount()
      vi.useRealTimers()
    })

    it('still plays on a plain tap', async () => {
      vi.useFakeTimers()
      const wrapper = mountView()
      const playAtIndex = vi.spyOn(usePlaybackStore(), 'playAtIndex').mockResolvedValue()
      const row = wrapper.findAllComponents(MobileQueueRow)[0]!

      touchDown(row.element)
      row.element.dispatchEvent(new Event('pointerup'))
      await vi.advanceTimersByTimeAsync(500)
      await row.trigger('click')

      expect((wrapper.vm as unknown as { actionsOpen: boolean }).actionsOpen).toBe(false)
      expect(playAtIndex).toHaveBeenCalledWith(0)
      vi.useRealTimers()
    })
  })

  // Same split QueueRow.vue makes on the desktop: the queue survives a
  // radio station, so its position stays marked while one plays, but
  // nothing in that row is audible.
  it('keeps the marker but drops the speaker icon while a station plays over the queue', async () => {
    const wrapper = mountView()
    usePlaybackStore().radioStation = {
      id: 'r1',
      name: 'Some Radio',
      streamUrl: 'http://station/stream',
      homePageUrl: null,
    }
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.mobile-queue-row--current')).toHaveLength(1)
    expect(wrapper.find('.mdi-volume-high').exists()).toBe(false)
  })
})
