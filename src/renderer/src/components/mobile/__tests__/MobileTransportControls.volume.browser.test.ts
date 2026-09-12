// The cast volume slider under a real finger. jsdom cannot answer this: a
// test there drives update:modelValue itself, so it only ever confirms the
// handler, never that Vuetify fires it from a touch at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import MobileTransportControls from '../MobileTransportControls.vue'
import { useConnectStore } from '@/stores/connect'
import { makeStatus } from '@/stores/__tests__/fixtures'
import { _resetVolumeGuards } from '@/services/connect/volumeGuard'

const vuetify = createVuetify({ components, directives })

let currentWrapper: VueWrapper | null = null

async function mountControls(type: 'sonos' | 'chromecast' = 'sonos', latencyMs = 0) {
  setActivePinia(createPinia())
  // Module-level and keyed by device - a settle window left over from the
  // previous test swallows this one's first reading, and the slider then
  // comes up disabled with nothing to drag.
  _resetVolumeGuards()
  const connect = useConnectStore()
  vi.spyOn(connect, 'getDeviceVolume').mockResolvedValue(30)
  // A speaker does not answer instantly: a SOAP/UPnP round trip over the
  // LAN is tens of milliseconds, and that latency is the whole reason the
  // writes have to be serialised at all.
  const setDeviceVolume = vi
    .spyOn(connect, 'setDeviceVolume')
    .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, latencyMs)))
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(MobileTransportControls),
        }),
    },
    {
      attachTo: document.body,
      global: { plugins: [vuetify, i18n], stubs: { SongWaveform: true, MobileDevicePicker: true } },
    },
  )
  currentWrapper = wrapper
  connect.status = makeStatus({
    targets: [{ name: 'Kitchen', type, volume: 30, volume_push: type === 'sonos' }],
  })
  await wrapper.vm.$nextTick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { wrapper, setDeviceVolume }
}

function label(): string {
  return document.querySelector('.mobile-transport__volume-value')!.textContent!.trim()
}

/** A real press-move-release over the slider, the way a finger does it.
 * Touch events, not pointer ones: Vuetify's slider binds touchstart /
 * touchmove / touchend (see vuetify/lib/components/VSlider/slider.js), and
 * a PointerEvent drag moves nothing at all. */
async function dragTo(fraction: number, steps = 1) {
  const track = document.querySelector('.v-slider-track')! as HTMLElement
  const box = track.getBoundingClientRect()
  const y = box.top + box.height / 2
  const thumb = document.querySelector('.v-slider-thumb')! as HTMLElement

  function touchAt(x: number): Touch {
    return new Touch({ identifier: 1, target: thumb, clientX: x, clientY: y })
  }
  function fire(type: string, x: number, target: EventTarget) {
    const touches = type === 'touchend' ? [] : [touchAt(x)]
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches: [touchAt(x)],
      }),
    )
  }

  const from = 0.3
  fire('touchstart', box.left + box.width * from, thumb)
  await new Promise((resolve) => setTimeout(resolve, 16))
  // A finger produces a stream of moves, not one jump - steps of about a
  // frame, which is what decides how many commands the speaker is sent.
  for (let step = 1; step <= steps; step++) {
    const at = from + ((fraction - from) * step) / steps
    fire('touchmove', box.left + box.width * at, window)
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  fire('touchend', box.left + box.width * fraction, thumb)
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Control: the same synthetic drag against a bare v-slider. If this does
 * not move either, the events above are wrong and the test proves nothing
 * about the component. */
describe('the drag harness itself', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
  })

  it('moves a plain v-slider', async () => {
    const seen: number[] = []
    currentWrapper = mount(
      {
        render: () =>
          h(components.VApp, null, {
            default: () =>
              h(components.VSlider, {
                modelValue: 30,
                max: 100,
                step: 1,
                'onUpdate:modelValue': (value: number) => seen.push(value),
              }),
          }),
      },
      { attachTo: document.body, global: { plugins: [vuetify, i18n] } },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    await dragTo(0.8)

    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('the cast volume slider under a real drag', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
    vi.restoreAllMocks()
  })

  it('keeps the dragged-to level after the finger lifts, and sends it once', async () => {
    const { setDeviceVolume } = await mountControls()
    expect(label()).toBe('30%')

    await dragTo(0.8)

    expect(label()).not.toBe('30%')
    expect(setDeviceVolume).toHaveBeenCalled()
    expect(setDeviceVolume.mock.calls.at(-1)?.slice(0, 2)).toEqual(['sonos', 'Kitchen'])
  })

  // The reported bug: a finger reports every frame, and each move used to
  // go straight out. Two dozen unserialised requests land in whatever order
  // the speaker answers them, so it ends up at an arbitrary one of them -
  // often near where the drag began. See services/connect/volumeWrite.ts.
  it('does not flood the speaker over one drag, and ends on the released level', async () => {
    const { setDeviceVolume } = await mountControls('sonos', 60)

    await dragTo(0.85, 25)
    // Long enough for the last queued write to go out after the finger
    // lifted - that one is what leaves the speaker where it was released.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const sent = setDeviceVolume.mock.calls.map((call) => call[2] as number)
    expect(sent.length).toBeLessThan(25)
    expect(sent.at(-1)).toBe(Number(label().replace('%', '')))
  })
})
