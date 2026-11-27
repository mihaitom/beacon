import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import MobileSectionScrubber from '../MobileSectionScrubber.vue'

const vuetify = createVuetify({ components, directives })

// jsdom lays nothing out, so the rail's geometry comes from the window
// alone: it starts 12px down and ends 12px from the bottom.
const RAIL_TOP = 12
const RAIL_HEIGHT = window.innerHeight - 2 * RAIL_TOP
const SECTIONS = ['A', 'B', 'C', 'D']

let pane: HTMLElement

beforeEach(() => {
  pane = document.createElement('div')
  pane.className = 'v-main'
  Object.defineProperty(pane, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(pane, 'clientHeight', { value: 700, configurable: true })
  document.body.appendChild(pane)
})

afterEach(() => {
  pane.remove()
  vi.useRealTimers()
})

function mountScrubber(available = SECTIONS) {
  return mount(MobileSectionScrubber, {
    props: { sections: SECTIONS, available: new Set(available), active: 'A' },
    global: { plugins: [vuetify, i18n] },
    attachTo: document.body,
  })
}

/** The y of the middle of section `index` on the rail. */
const yOf = (index: number) => RAIL_TOP + (index + 0.5) * (RAIL_HEIGHT / SECTIONS.length)

// jsdom keeps an element's scrollTop at 0 whatever is set.
function scroll(to: number) {
  Object.defineProperty(pane, 'scrollTop', { value: to, configurable: true })
  pane.dispatchEvent(new Event('scroll'))
}

/** A pointer event at `clientY` - vue-test-utils' trigger cannot set one on
 * jsdom's events, which have it as a getter. */
async function pointer(element: { element: Element; vm?: unknown }, type: string, clientY = 0) {
  element.element.dispatchEvent(new MouseEvent(type, { clientY, bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MobileSectionScrubber', () => {
  it('stays out of sight until the list moves, and goes again once it stops', async () => {
    vi.useFakeTimers()
    const wrapper = mountScrubber()
    expect(wrapper.classes()).not.toContain('mobile-scrubber--shown')

    scroll(800)
    await wrapper.vm.$nextTick()
    expect(wrapper.classes()).toContain('mobile-scrubber--shown')

    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.classes()).not.toContain('mobile-scrubber--shown')
  })

  it('scrubs section by section while the grip is dragged', async () => {
    const wrapper = mountScrubber()
    const grip = wrapper.get('.mobile-scrubber__grip')

    await pointer(grip, 'pointerdown', yOf(0))
    await pointer(grip, 'pointermove', yOf(2))
    await pointer(grip, 'pointermove', yOf(3))

    expect(wrapper.emitted('select')).toEqual([['C'], ['D']])
    expect(wrapper.get('.mobile-scrubber__bubble').text()).toBe('D')

    await pointer(grip, 'pointerup')
    expect(wrapper.classes()).not.toContain('mobile-scrubber--open')
  })

  it('lands on the nearest section the list has when the thumb is over an empty one', async () => {
    const wrapper = mountScrubber(['A', 'D'])
    const grip = wrapper.get('.mobile-scrubber__grip')

    await pointer(grip, 'pointerdown', yOf(0))
    await pointer(grip, 'pointermove', yOf(2))

    expect(wrapper.emitted('select')).toEqual([['D']])
  })

  it('opens the rail on a tap to pick from, and closes it on a tap beside it', async () => {
    const wrapper = mountScrubber()
    const grip = wrapper.get('.mobile-scrubber__grip')

    await pointer(grip, 'pointerdown', 300)
    await pointer(grip, 'pointerup')
    expect(wrapper.classes()).toContain('mobile-scrubber--open')
    expect(wrapper.emitted('select')).toBeUndefined()

    const sections = wrapper.findAll('.mobile-scrubber__section')
    await sections[1]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['B']])

    await pointer(wrapper.get('.mobile-scrubber__scrim'), 'pointerdown')
    expect(wrapper.classes()).not.toContain('mobile-scrubber--open')
  })

  it('does not offer a section the list has none of', () => {
    const wrapper = mountScrubber(['A', 'C'])
    const off = wrapper
      .findAll('.mobile-scrubber__section')
      .filter((button) => button.attributes('disabled') !== undefined)
      .map((button) => button.text())
    expect(off).toEqual(['B', 'D'])
  })
})
