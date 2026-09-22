import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AlphabetIndexBar from '../AlphabetIndexBar.vue'

function buttonFor(wrapper: VueWrapper, letter: string) {
  return wrapper.findAll('button').find((button) => button.text() === letter)
}

describe('AlphabetIndexBar', () => {
  it('marks the letter of the section on screen', () => {
    const wrapper = mount(AlphabetIndexBar, {
      props: { available: new Set(['A', 'K']), active: 'K' },
    })

    expect(buttonFor(wrapper, 'K')?.attributes('aria-current')).toBe('true')
    expect(buttonFor(wrapper, 'A')?.attributes('aria-current')).toBeUndefined()
  })

  it('disables a letter no item starts with', () => {
    const wrapper = mount(AlphabetIndexBar, {
      props: { available: new Set(['A']) },
    })

    expect(buttonFor(wrapper, 'A')?.attributes('disabled')).toBeUndefined()
    expect(buttonFor(wrapper, 'B')?.attributes('disabled')).toBeDefined()
  })
})
