import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import CardShelf from '../CardShelf.vue'

const vuetify = createVuetify({ components, directives })

function mountShelf(props: Record<string, unknown> = {}) {
  return mount(CardShelf, {
    props: { title: 'Albums', ...props },
    slots: { default: '<div class="card">one</div><div class="card">two</div>' },
    global: { plugins: [vuetify, i18n] },
  })
}

describe('CardShelf', () => {
  it('renders whatever cards it is given under its own heading', () => {
    const wrapper = mountShelf()

    expect(wrapper.get('.section-title').text()).toBe('Albums')
    expect(wrapper.findAll('.card')).toHaveLength(2)
  })

  it('pages the row sideways by a bit less than its own width', async () => {
    const wrapper = mountShelf()
    const row = wrapper.get('.card-shelf__row').element as HTMLElement
    // jsdom reports 0 for every layout box and has no scrollBy at all.
    // A row three times its own width, scrolled to the middle: the state in
    // which neither chevron is at an end and both are live.
    Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(row, 'scrollWidth', { value: 3000, configurable: true })
    Object.defineProperty(row, 'scrollLeft', { value: 500, writable: true, configurable: true })
    row.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    const scrollBy = vi.fn()
    row.scrollBy = scrollBy

    const [left, right] = wrapper.findAll('.card-shelf__nav button')
    await right!.trigger('click')
    // Short of a full width on purpose, so the card at the edge stays
    // partly visible as a handle on where you were.
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' })

    await left!.trigger('click')
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -800, behavior: 'smooth' })
  })

  /** The measuring itself is shelfScrollEdges.test.ts's subject; this is
   * that answer reaching the right button. A row already at its left edge
   * has nothing to the left, so only that chevron goes dim. */
  it('dims the chevron pointing at an end the row has reached', async () => {
    const wrapper = mountShelf()
    const row = wrapper.get('.card-shelf__row').element as HTMLElement
    Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(row, 'scrollWidth', { value: 3000, configurable: true })
    Object.defineProperty(row, 'scrollLeft', { value: 0, writable: true, configurable: true })

    row.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    const [left, right] = wrapper.findAll('.card-shelf__nav button')
    expect(left!.attributes('disabled')).toBeDefined()
    expect(right!.attributes('disabled')).toBeUndefined()

    row.scrollLeft = 2000
    row.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(left!.attributes('disabled')).toBeUndefined()
    expect(right!.attributes('disabled')).toBeDefined()
  })

  /** Disabled, not removed. The chevrons sit right of the grid toggle, and
   * taking them out of the row lets the spacer pull that toggle rightwards
   * — out from under the pointer that just clicked it, so a second click
   * lands on nothing or on a chevron that has moved into its place. */
  it('keeps the chevrons in place in wrapping mode, disabled', () => {
    const wrapper = mountShelf({ wrap: true })

    const nav = wrapper.find('.card-shelf__nav')
    expect(nav.exists()).toBe(true)
    expect(nav.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.get('.card-shelf__row').classes()).toContain('card-shelf__row--wrap')
    // Same cards either way — the toggle is a layout change, not a
    // different component.
    expect(wrapper.findAll('.card')).toHaveLength(2)
  })

  describe('grid toggle', () => {
    it('is opt-in — a shelf nobody switches has no dead button', () => {
      expect(mountShelf().find('.mdi-view-grid-outline').exists()).toBe(false)
    })

    it('asks its host to switch instead of switching itself', async () => {
      // The host owns the state (and persists it), same split as every
      // other controlled prop in the app.
      const wrapper = mountShelf({ wrapToggle: true })

      await wrapper.get('.mdi-view-grid-outline').element.closest('button')!.click()

      expect(wrapper.emitted('update:wrap')).toEqual([[true]])
      // Nothing changed on its own.
      expect(wrapper.get('.card-shelf__row').classes()).not.toContain('card-shelf__row--wrap')
    })

    it('asks to switch back when it is already wrapping', async () => {
      const wrapper = mountShelf({ wrapToggle: true, wrap: true })

      await wrapper.get('.mdi-view-grid-outline').element.closest('button')!.click()

      expect(wrapper.emitted('update:wrap')).toEqual([[false]])
    })
  })

  it('exposes an action slot next to the heading', () => {
    const wrapper = mount(CardShelf, {
      props: { title: 'Albums' },
      slots: { action: '<button class="shelf-action">Play all</button>' },
      global: { plugins: [vuetify, i18n] },
    })

    expect(wrapper.find('.shelf-action').exists()).toBe(true)
  })
})
