import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import VolumeFader from '../VolumeFader.vue'

const vuetify = createVuetify({ components, directives })

/** jsdom lays nothing out, so the row is given a width of 200px at x=0:
 * a pointer at x is x/2 percent. */
function mountFader(props: Record<string, unknown> = {}) {
  const wrapper = mount(VolumeFader, {
    props: { label: 'Kitchen', modelValue: 30, ...props },
    global: { plugins: [vuetify] },
  })
  const el = wrapper.element as HTMLElement
  el.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect
  el.setPointerCapture = () => {}
  return wrapper
}

function pointer(type: string, init: { clientX: number; pointerType: string }) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
  Object.assign(event, { pointerId: 1, button: 0, ...init })
  return event
}

function levels(wrapper: ReturnType<typeof mountFader>): number[] {
  return (wrapper.emitted('update:modelValue') ?? []).map((args) => args[0] as number)
}

describe('VolumeFader', () => {
  it('sets the level where the mouse presses and follows the drag', () => {
    const wrapper = mountFader()
    const el = wrapper.element

    el.dispatchEvent(pointer('pointerdown', { clientX: 100, pointerType: 'mouse' }))
    el.dispatchEvent(pointer('pointermove', { clientX: 150, pointerType: 'mouse' }))
    el.dispatchEvent(pointer('pointermove', { clientX: 400, pointerType: 'mouse' }))
    el.dispatchEvent(pointer('pointerup', { clientX: 400, pointerType: 'mouse' }))

    expect(levels(wrapper)).toEqual([50, 75, 100])
    expect(wrapper.emitted('start')).toHaveLength(1)
    expect(wrapper.emitted('end')).toHaveLength(1)
  })

  it('leaves a tap with a finger alone - it may be the start of a scroll', () => {
    const wrapper = mountFader()
    const el = wrapper.element

    el.dispatchEvent(pointer('pointerdown', { clientX: 100, pointerType: 'touch' }))
    el.dispatchEvent(pointer('pointermove', { clientX: 103, pointerType: 'touch' }))
    el.dispatchEvent(pointer('pointerup', { clientX: 103, pointerType: 'touch' }))

    expect(levels(wrapper)).toEqual([])
    expect(wrapper.emitted('start')).toBeUndefined()
  })

  it('takes a finger once it moves sideways, and lets go if the browser takes the gesture', () => {
    const wrapper = mountFader()
    const el = wrapper.element

    el.dispatchEvent(pointer('pointerdown', { clientX: 100, pointerType: 'touch' }))
    el.dispatchEvent(pointer('pointermove', { clientX: 120, pointerType: 'touch' }))
    el.dispatchEvent(pointer('pointercancel', { clientX: 120, pointerType: 'touch' }))

    expect(levels(wrapper)).toEqual([60])
    expect(wrapper.emitted('end')).toHaveLength(1)
  })

  it('steps with the arrow keys and jumps with Home/End', async () => {
    const wrapper = mountFader()

    await wrapper.trigger('keydown', { key: 'ArrowRight' })
    await wrapper.trigger('keydown', { key: 'ArrowDown' })
    await wrapper.trigger('keydown', { key: 'End' })
    await wrapper.trigger('keydown', { key: 'Home' })

    expect(levels(wrapper)).toEqual([35, 25, 100, 0])
  })

  it('does nothing as a name-only row, or before the device has answered', async () => {
    for (const props of [{ plain: true }, { modelValue: null }, { adjustable: false }]) {
      const wrapper = mountFader(props)
      wrapper.element.dispatchEvent(pointer('pointerdown', { clientX: 100, pointerType: 'mouse' }))
      await wrapper.trigger('keydown', { key: 'ArrowRight' })

      expect(levels(wrapper)).toEqual([])
    }
  })

  it('shows the spread when the speakers under a master differ', () => {
    expect(mountFader({ modelValue: 40, floor: 20 }).text()).toContain('20–40%')
    expect(mountFader({ modelValue: 40, floor: 40 }).text()).toContain('40%')
    expect(mountFader({ modelValue: 40, floor: 40 }).text()).not.toContain('–')
  })

  it('removes without setting a level', async () => {
    const wrapper = mountFader({ removeLabel: 'Stop playing on Kitchen' })

    await wrapper.get('.fader__remove').trigger('pointerdown')
    await wrapper.get('.fader__remove').trigger('click')

    expect(wrapper.emitted('remove')).toHaveLength(1)
    expect(levels(wrapper)).toEqual([])
  })
})
