// Real-browser test for the lights dialog's preview - run via
// `pnpm test:layout`. It paints from requestAnimationFrame, which jsdom
// does not run, so only a real browser can say whether the lamps light up
// at all. They once stayed grey.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import LightsStage from '../LightsStage.vue'

const wrappers: VueWrapper[] = []

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})

function frames(n = 6): Promise<void> {
  return new Promise((resolve) => {
    let left = n
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  })
}

function lit(wrapper: VueWrapper): boolean[] {
  return wrapper
    .findAll('.lights-stage__lamp')
    .map((lamp) => getComputedStyle(lamp.element).backgroundColor)
    .map((colour) => {
      const [r, g, b] = colour.match(/\d+/g)!.map(Number)
      return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 10
    })
}

function mountStage(props: Record<string, unknown> = {}) {
  const wrapper = mount(LightsStage, {
    props: { lights: 2, lightStyle: 'pulse', palette: [[255, 0, 0]], ...props },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('LightsStage', () => {
  it('lights every lamp', async () => {
    const wrapper = mountStage()
    await frames()
    expect(lit(wrapper)).toEqual([true, true])
  })

  it('keeps lighting them when the area gets more lights and fewer again', async () => {
    const wrapper = mountStage()
    await frames()
    await wrapper.setProps({ lights: 5 })
    await frames()
    expect(lit(wrapper)).toEqual([true, true, true, true, true])
    await wrapper.setProps({ lights: 3 })
    await frames()
    expect(lit(wrapper)).toEqual([true, true, true])
  })

  it('still lights them, dimmed, while the lights are switched off', async () => {
    const wrapper = mountStage({ on: false })
    await frames()
    expect(lit(wrapper)).toEqual([true, true])
  })

  it('gives every lamp its own colour in the rotation', async () => {
    const wrapper = mountStage({ rotate: true, lights: 3, lightStyle: 'calm' })
    await frames()
    const colours = wrapper
      .findAll('.lights-stage__lamp')
      .map((lamp) => getComputedStyle(lamp.element).backgroundColor)
    expect(new Set(colours).size).toBe(3)
  })

  it('every style and a palette light up', async () => {
    for (const lightStyle of ['pulse', 'calm', 'party', 'wave']) {
      const wrapper = mountStage({
        lightStyle,
        lights: 4,
        palette: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      })
      await frames()
      expect(lit(wrapper), lightStyle).toEqual([true, true, true, true])
    }
  })
})
