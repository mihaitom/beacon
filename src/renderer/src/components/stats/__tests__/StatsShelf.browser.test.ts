import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@/i18n'
import type { PressedRecord, RecordTier } from '@/services/library/statsMilestones'
import StatsShelf from '../StatsShelf.vue'

const FULL_PILES: [RecordTier, number][] = [
  ['bronze', 4],
  ['silver', 3],
  ['gold', 2],
  ['platinum', 3],
  ['diamond', 12],
]

let number = 0
const RECORDS: PressedRecord[] = FULL_PILES.flatMap(([tier, count]) =>
  Array.from({ length: count }, () => ({
    number: ++number,
    tier,
    plays: number * 500,
    step: 10,
    earnedAt: null,
    tookSeconds: null,
  })),
)

// A 360px phone: the hero's width, and the share of it the shelf gets.
const HERO_WIDTH = 328
const SHELF_WIDTH = 275

describe('StatsShelf layout', () => {
  let wrapper: VueWrapper | null = null
  let frame: HTMLElement | null = null

  afterEach(() => {
    wrapper?.unmount()
    frame?.remove()
  })

  function mountShelf(): HTMLElement {
    frame = document.createElement('div')
    frame.style.cssText = `container-type:inline-size;width:${HERO_WIDTH}px;padding-top:40px`
    frame.innerHTML = `<div style="width:${SHELF_WIDTH}px;margin:auto"></div>`
    document.body.append(frame)
    const style = document.createElement('style')
    style.textContent = '.stats-shelf * { transition: none !important; animation: none !important }'
    frame.append(style)
    wrapper = mount(StatsShelf, {
      attachTo: frame.querySelector('div > div') as HTMLElement,
      props: { records: RECORDS, seen: null, landed: null },
      global: { plugins: [i18n], stubs: { VTooltip: true } },
    })
    return wrapper.element as HTMLElement
  }

  const edges = (element: Element): DOMRect => element.getBoundingClientRect()

  it('fits five full piles side by side on a phone', () => {
    const piles = [...mountShelf().querySelectorAll('.stats-shelf__pile')]
    expect(piles).toHaveLength(5)
    piles.reduce((left, right) => {
      const lastOfLeft = [...left.querySelectorAll('.stats-shelf__disc')].at(-1) as Element
      const firstOfRight = right.querySelector('.stats-shelf__disc') as Element
      expect(edges(lastOfLeft).right).toBeLessThanOrEqual(edges(firstOfRight).left)
      return right
    })
  })

  it('keeps every fan inside the hero', () => {
    const shelf = mountShelf()
    const heroBox = edges(frame as HTMLElement)
    for (const pile of shelf.querySelectorAll('.stats-shelf__pile')) {
      pile.classList.add('is-open')
      for (const disc of pile.querySelectorAll('.stats-shelf__disc')) {
        expect(edges(disc).left).toBeGreaterThanOrEqual(heroBox.left)
        expect(edges(disc).right).toBeLessThanOrEqual(heroBox.right)
      }
      pile.classList.remove('is-open')
    }
  })
})
