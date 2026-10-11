import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { newRule, withOperator, type RuleNode } from '@/services/navidrome/smartRules'
import SmartRuleValue from '../SmartRuleValue.vue'

const vuetify = createVuetify({ components, directives })

function rule(field: string, operator: RuleNode['operator'], value: RuleNode['value']): RuleNode {
  return { ...withOperator(newRule(field), operator), value }
}

function mountValue(r: RuleNode) {
  return mount(SmartRuleValue, {
    props: { rule: r },
    global: { plugins: [vuetify, i18n] },
  })
}

function emitted(wrapper: ReturnType<typeof mountValue>): unknown[] {
  return (wrapper.emitted('update') ?? []).map((args) => args[0])
}

describe('SmartRuleValue', () => {
  it('shows a duration in minutes and saves it in seconds', async () => {
    const wrapper = mountValue(rule('duration', 'gt', 300))
    const input = wrapper.find('input')

    expect((input.element as HTMLInputElement).value).toBe('5')
    await input.setValue('8')

    expect(emitted(wrapper)).toEqual([480])
  })

  it('reads days in the largest unit that fits', () => {
    const wrapper = mountValue(rule('lastplayed', 'notInTheLast', 180))

    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('6')
    expect(wrapper.text()).toContain(i18n.global.t('smartPlaylists.units.months'))
  })

  it('saves the days for an amount in the chosen unit', async () => {
    const wrapper = mountValue(rule('lastplayed', 'inTheLast', 14))

    await wrapper.find('input').setValue('3')

    // 3 weeks, the unit 14 days read as.
    expect(emitted(wrapper)).toEqual([21])
  })

  it('keeps the amount when the unit changes, and saves the new days', () => {
    const wrapper = mountValue(rule('lastplayed', 'inTheLast', 14))

    ;(wrapper.vm as unknown as { setDayUnit(unit: string): void }).setDayUnit('months')

    expect(emitted(wrapper)).toEqual([60])
  })

  it('gives "between" two numbers and changes only the one typed in', async () => {
    const wrapper = mountValue(rule('year', 'inTheRange', [1990, 1999]))
    const inputs = wrapper.findAll('input')

    expect(inputs).toHaveLength(2)
    await inputs[1]!.setValue('2005')

    expect(emitted(wrapper)).toEqual([[1990, 2005]])
  })

  it('clears a number that is emptied rather than saving a zero', async () => {
    const wrapper = mountValue(rule('year', 'gt', 1990))

    await wrapper.find('input').setValue('')

    expect(emitted(wrapper)).toEqual([null])
  })

  it('shows a date the way the app’s language writes it', () => {
    const wrapper = mountValue(rule('dateadded', 'before', '2020-01-05'))

    const shown = (wrapper.find('input').element as HTMLInputElement).value
    expect(shown).toBe(
      new Intl.DateTimeFormat(i18n.global.locale as unknown as string, {
        dateStyle: 'medium',
      }).format(new Date(2020, 0, 5)),
    )
  })

  it('saves the day picked in the calendar and closes it', async () => {
    const wrapper = mountValue(rule('dateadded', 'before', null))
    const vm = wrapper.vm as unknown as { dateMenu: boolean }
    vm.dateMenu = true
    await wrapper.vm.$nextTick()

    wrapper
      .findComponent({ name: 'VDatePicker' })
      .vm.$emit('update:modelValue', new Date(2021, 5, 30))
    await wrapper.vm.$nextTick()

    expect(emitted(wrapper)).toEqual(['2021-06-30'])
    expect(vm.dateMenu).toBe(false)
  })

  it('shows stars for a rating', () => {
    const wrapper = mountValue(rule('rating', 'gt', 3))

    expect(wrapper.findComponent({ name: 'VRating' }).exists()).toBe(true)
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
  })

  it('needs no value at all for "has no value"', () => {
    const wrapper = mountValue(rule('genre', 'isMissing', null))

    expect(wrapper.find('input').exists()).toBe(false)
  })
})
