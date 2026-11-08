import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import type { PressedRecord } from '@/services/library/statsMilestones'
import StatsShelf from '../StatsShelf.vue'

const DAY = 86400
const ONE: PressedRecord = { number: 1, plays: 2000, step: 50, earnedAt: null, tookSeconds: null }
const TWO: PressedRecord = {
  number: 2,
  plays: 4000,
  step: 100,
  earnedAt: Date.UTC(2026, 2, 14, 12) / 1000,
  tookSeconds: 90 * DAY,
}

function mountShelf(records: PressedRecord[], seen: number | null = null) {
  return mount(StatsShelf, {
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
    expect(text).toContain('4,000')
    expect(text).toContain('March 14, 2026')
    expect(text).toContain('3 months')
  })

  it('counts a short one in days', () => {
    expect(details(mountShelf([{ ...TWO, tookSeconds: 12 * DAY }]), 2)).toContain('12 days')
  })

  it('says so when the date lies before the log', () => {
    const text = details(mountShelf([ONE]), 1)
    expect(text).toContain('before the play history')
  })

  it('holds back a record that is still being announced', () => {
    const slots = mountShelf([ONE, TWO], 1).findAll('li')
    expect(slots[0]?.classes()).not.toContain('is-waiting')
    expect(slots[1]?.classes()).toContain('is-waiting')
  })
})
