import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import type { PressedRecord } from '@/services/library/statsMilestones'
import StatsShelf from '../StatsShelf.vue'

const DAY = 86400
const ONE: PressedRecord = {
  number: 1,
  tier: 'bronze',
  plays: 2000,
  holds: 2500,
  step: 50,
  earnedAt: null,
  tookSeconds: null,
}
const TWO: PressedRecord = {
  number: 2,
  tier: 'gold',
  plays: 4000,
  holds: 5000,
  step: 100,
  earnedAt: Date.UTC(2026, 2, 14, 12) / 1000,
  tookSeconds: 90 * DAY,
}

function mountShelf(records: PressedRecord[], seen: number | null = null, attached = false) {
  return mount(StatsShelf, {
    attachTo: attached ? document.body : undefined,
    props: { records, seen },
    global: { plugins: [i18n], stubs: { VTooltip: true } },
  })
}

const details = (wrapper: ReturnType<typeof mountShelf>, record: number) =>
  wrapper.find(`[data-record="${record}"]`).attributes('aria-label')

describe('StatsShelf', () => {
  it('is not there before the first full record', () => {
    expect(mountShelf([]).find('ul').exists()).toBe(false)
  })

  it('says when a record filled up and how long it took', () => {
    const text = details(mountShelf([ONE, TWO]), 2)
    expect(text).toContain('Gold record')
    expect(text).toContain('4,000')
    expect(text).toContain('March 14, 2026')
    expect(text).toContain('3 months')
  })

  it('tells what a record is worth apart from the total it was full at', () => {
    const wrapper = mountShelf([ONE, TWO])
    const text = details(wrapper, 2)

    expect(text).toContain('5,000 plays')
    expect(text).toContain('4,000 plays overall')
    expect(wrapper.find('[data-record="2"] .stats-shelf__label').text()).toBe('5k')
  })

  it('counts a short one in days', () => {
    expect(details(mountShelf([{ ...TWO, tookSeconds: 12 * DAY }]), 2)).toContain('12 days')
  })

  it('says so when the date lies before the log', () => {
    const text = details(mountShelf([ONE]), 1)
    expect(text).toContain('before the play history')
  })

  it('holds back a record that is still being announced', () => {
    const places = mountShelf([ONE, TWO], 1).findAll('.stats-shelf__place')
    expect(places[0]?.classes()).not.toContain('is-waiting')
    expect(places[1]?.classes()).toContain('is-waiting')
  })

  it('makes one pile per tier with the newest on top', () => {
    const piles = mountShelf([
      ONE,
      { ...ONE, number: 2, plays: 3000 },
      { ...TWO, number: 3 },
    ]).findAll('.stats-shelf__pile')
    expect(piles).toHaveLength(2)
    const discs = piles[0]?.findAll('[data-record]') ?? []
    expect(discs.map((disc) => disc.attributes('data-record'))).toEqual(['1', '2'])
  })

  const diamonds = (count: number): PressedRecord[] =>
    Array.from({ length: count }, (_, index) => ({
      ...ONE,
      number: index + 1,
      tier: 'diamond',
    }))

  it('shows a long pile as its newest few and says how many there are', () => {
    const wrapper = mountShelf(diamonds(12))
    expect(wrapper.findAll('[data-record]')).toHaveLength(5)
    expect(wrapper.find('[data-record="12"]').exists()).toBe(true)
    expect(wrapper.find('.stats-shelf__count').text()).toBe('×12')
  })

  it('does not count one still in the air', () => {
    expect(mountShelf(diamonds(12), 11).find('.stats-shelf__count').text()).toBe('×11')
  })

  it('needs no count while every record shows', () => {
    expect(mountShelf(diamonds(5)).find('.stats-shelf__count').exists()).toBe(false)
  })

  describe('with the details shown nearby', () => {
    function point(element: Element, type: string, pointerType: string): void {
      const event = new MouseEvent(type, { bubbles: false })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      element.dispatchEvent(event)
    }

    function inline() {
      return mount(StatsShelf, {
        props: { records: [ONE, TWO], seen: null, inlineDetails: true },
        global: { plugins: [i18n], stubs: { VTooltip: true } },
      })
    }

    const lastDetail = (wrapper: ReturnType<typeof inline>) =>
      wrapper.emitted('detail')?.at(-1)?.[0] as string[] | null

    it('has no tooltip', () => {
      expect(inline().find('v-tooltip-stub').exists()).toBe(false)
    })

    it('hands over the record under the pointer and lets go off the shelf', async () => {
      const wrapper = inline()

      point(wrapper.find('[data-record="2"]').element, 'pointerenter', 'mouse')
      await flushPromises()
      expect(lastDetail(wrapper)?.[0]).toBe('Gold record')

      point(wrapper.element, 'pointerleave', 'mouse')
      await flushPromises()
      expect(lastDetail(wrapper)).toBeNull()
    })

    it('stays with a record while the pointer crosses to the next', async () => {
      const wrapper = inline()
      point(wrapper.find('[data-record="2"]').element, 'pointerenter', 'mouse')
      point(wrapper.find('[data-record="2"]').element, 'pointerleave', 'mouse')
      await flushPromises()

      expect(lastDetail(wrapper)?.[0]).toBe('Gold record')
    })

    it('leaves a finger to its taps', async () => {
      const wrapper = inline()

      point(wrapper.find('[data-record="2"]').element, 'pointerenter', 'touch')
      await flushPromises()

      expect(wrapper.emitted('detail')).toBeUndefined()
    })

    it('follows the keyboard', async () => {
      const wrapper = inline()
      const disc = wrapper.find('[data-record="1"]')

      await disc.trigger('focus')
      expect(lastDetail(wrapper)?.[0]).toBe('Bronze record')

      await disc.trigger('blur')
      expect(lastDetail(wrapper)).toBeNull()
    })
  })

  describe('by touch', () => {
    async function tap(wrapper: ReturnType<typeof mountShelf>, type: string): Promise<void> {
      const disc = wrapper.find('[data-record="1"]')
      const down = new MouseEvent('pointerdown', { bubbles: true })
      Object.defineProperty(down, 'pointerType', { value: type })
      disc.element.dispatchEvent(down)
      await disc.trigger('click')
    }

    it('fans out the pile that was tapped', async () => {
      const wrapper = mountShelf([ONE, TWO])
      await tap(wrapper, 'touch')
      expect(wrapper.findAll('.stats-shelf__pile')[0]?.classes()).toContain('is-open')
    })

    it('answers only once the pile is fanned out', async () => {
      const wrapper = mountShelf([ONE, TWO])
      const tooltip = wrapper.find('v-tooltip-stub')
      await tap(wrapper, 'touch')
      expect(tooltip.attributes('model-value')).toBe('false')
      await tap(wrapper, 'touch')
      expect(tooltip.attributes('model-value')).toBe('true')
    })

    it('leaves that to hover for a mouse', async () => {
      const wrapper = mountShelf([ONE, TWO])
      await tap(wrapper, 'mouse')
      expect(wrapper.find('.is-open').exists()).toBe(false)
    })

    it('closes when tapping elsewhere', async () => {
      const wrapper = mountShelf([ONE, TWO], null, true)
      await tap(wrapper, 'touch')
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.is-open').exists()).toBe(false)
    })
  })
})
