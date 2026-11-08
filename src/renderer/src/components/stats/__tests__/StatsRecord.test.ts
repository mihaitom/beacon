import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { grooveRadius, recordProgress } from '@/services/library/statsMilestones'
import StatsRecord from '../StatsRecord.vue'

// At its natural size, so client coordinates are the SVG's own units.
const BOX = { left: 0, top: 0, width: 640, height: 560 } as DOMRect
const CENTRE_X = 270
const CENTRE_Y = 280

function mountRecord(passedPlays = 0): VueWrapper {
  const wrapper = mount(StatsRecord, {
    props: { record: recordProgress(13459), passedPlays },
    global: { plugins: [i18n] },
  })
  vi.spyOn(wrapper.find('svg').element, 'getBoundingClientRect').mockReturnValue(BOX)
  return wrapper
}

/** VTU cannot set clientX on the event it builds. */
async function pointAt(wrapper: VueWrapper, clientX: number): Promise<void> {
  wrapper
    .find('svg')
    .element.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY: CENTRE_Y }))
  await wrapper.vm.$nextTick()
}

function pointAtGroove(wrapper: VueWrapper, n: number): Promise<void> {
  return pointAt(wrapper, CENTRE_X + grooveRadius(n))
}

function lastLine(wrapper: VueWrapper): unknown {
  return wrapper.emitted('hover-line')?.at(-1)?.[0]
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('pointing at the record', () => {
  it('says what the groove under the pointer stands for', async () => {
    const wrapper = mountRecord()
    await pointAtGroove(wrapper, 5)

    // The first platinum: from 10,000 at 100 a groove.
    expect(lastLine(wrapper)).toContain('10,400')
    expect(lastLine(wrapper)).toContain('10,500')
  })

  it('names a milestone engraved on that groove', async () => {
    const wrapper = mountRecord(11000)
    await pointAtGroove(wrapper, 10)

    expect(lastLine(wrapper)).toContain('11,000 reached')
  })

  it('goes quiet on the label and when the pointer leaves', async () => {
    const wrapper = mountRecord()
    await pointAtGroove(wrapper, 5)
    await pointAt(wrapper, CENTRE_X)
    expect(lastLine(wrapper)).toBe('')

    await pointAtGroove(wrapper, 5)
    await wrapper.find('svg').trigger('pointerleave')
    expect(lastLine(wrapper)).toBe('')
  })
})
