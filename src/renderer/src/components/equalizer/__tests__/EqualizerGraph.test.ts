// The curve graph: dragging, the keyboard and a double click change one
// band, and a band's point stays put while its neighbours move. Not the
// drawing.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import EqualizerGraph from '../EqualizerGraph.vue'

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function graph(gains = FLAT, props: Record<string, unknown> = {}) {
  const wrapper = mount(EqualizerGraph, {
    props: { gains, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  // jsdom lays nothing out: the graph is the component's own 400 x 220.
  const el = wrapper.find('.eq-graph').element as HTMLElement
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 220, right: 400, bottom: 220 }) as DOMRect
  return wrapper
}

function changes(wrapper: ReturnType<typeof graph>): [number, number][] {
  return (wrapper.emitted('change') ?? []) as [number, number][]
}

/** jsdom has no PointerEvent; a MouseEvent carries what the graph reads. */
async function pointer(
  wrapper: ReturnType<typeof graph>,
  type: string,
  init: MouseEventInit = {},
): Promise<void> {
  wrapper.find('.eq-graph').element.dispatchEvent(new MouseEvent(type, { button: 0, ...init }))
  await wrapper.vm.$nextTick()
}

function handleTops(wrapper: ReturnType<typeof graph>): string[] {
  return wrapper.findAll('.eq-graph__handle').map((h) => (h.element as HTMLElement).style.top)
}

describe('EqualizerGraph', () => {
  it('leaves the other points where they are when one band moves', async () => {
    const wrapper = graph()
    const before = handleTops(wrapper)
    await wrapper.setProps({ gains: [0, 8, 0, 0, 0, 0, 0, 0, 0, 0] })
    const after = handleTops(wrapper)
    expect(after[1]).not.toBe(before[1])
    expect(after.filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1))
  })

  it('a drag changes the band it started on, however far it goes sideways', async () => {
    const wrapper = graph()
    const x31 = parseFloat((wrapper.find('.eq-graph__handle').element as HTMLElement).style.left)
    await pointer(wrapper, 'pointerdown', { clientX: x31, clientY: 0 })
    await pointer(wrapper, 'pointermove', { clientX: 390, clientY: 220 })
    await pointer(wrapper, 'pointerup')
    expect(changes(wrapper)).toEqual([
      [0, 12],
      [0, -12],
    ])
  })

  it('a double click puts a band back to 0', async () => {
    const wrapper = graph([0, 0, 0, 0, 0, 0, 0, 0, 0, 5])
    await wrapper.find('.eq-graph').trigger('dblclick', { clientX: 399 })
    expect(changes(wrapper)).toEqual([[9, 0]])
  })

  it('takes the keyboard on a focused point, within the range', async () => {
    const wrapper = graph([0, 0, 11, 0, 0, 0, 0, 0, 0, 0])
    const handle = wrapper.findAll('.eq-graph__handle')[2]!
    await handle.trigger('keydown', { key: 'ArrowDown' })
    await handle.trigger('keydown', { key: 'PageUp' })
    await handle.trigger('keydown', { key: 'Delete' })
    expect(changes(wrapper)).toEqual([
      [2, 10],
      [2, 12],
      [2, 0],
    ])
  })

  it('does nothing while disabled', async () => {
    const wrapper = graph(FLAT, { disabled: true })
    await pointer(wrapper, 'pointerdown', { clientX: 30, clientY: 0 })
    await wrapper.findAll('.eq-graph__handle')[0]!.trigger('keydown', { key: 'ArrowUp' })
    expect(changes(wrapper)).toEqual([])
  })
})
