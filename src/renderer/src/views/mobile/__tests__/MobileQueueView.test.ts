import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { usePlaybackStore } from '@/stores/playback'
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
 * element the press and the release share. Dispatched in one turn, as the
 * browser does, so the ordering the fix depends on is what is under test. */
async function endDragOverRow(wrapper: ReturnType<typeof mountView>, index: number) {
  window.dispatchEvent(new Event('pointerup'))
  await wrapper.vm.$nextTick()
  wrapper.findAllComponents(MobileQueueRow)[index]!.trigger('click')
  await wrapper.vm.$nextTick()
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

    /** The suppression lasts exactly one task — a tap afterwards is a tap,
     * not the tail of the drag before it. */
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
