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
import { VOLUME_SETTLE_MS, _resetVolumeGuards } from '@/services/connect/volumeGuard'
import { _resetVolumeWrites } from '@/services/connect/volumeWrite'

const vuetify = createVuetify({ components, directives })

let currentWrapper: VueWrapper | null = null

async function mountControls(type: 'sonos' | 'chromecast' = 'sonos', latencyMs = 0) {
  setActivePinia(createPinia())
  // Module-level and keyed by device - a settle window left over from the
  // previous test swallows this one's first reading, and the slider then
  // comes up disabled with nothing to drag.
  _resetVolumeGuards()
  // Same reason, one module over: a value still queued from the previous
  // test goes out during this one and shows up in its call list.
  _resetVolumeWrites()
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

function touchAt(x: number, y: number, target: Element): Touch {
  return new Touch({ identifier: 1, target, clientX: x, clientY: y })
}

function fireTouch(type: string, on: EventTarget, x: number, y: number, target: Element) {
  const touches = type === 'touchstart' || type === 'touchmove' ? [touchAt(x, y, target)] : []
  on.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches,
      targetTouches: touches,
      changedTouches: [touchAt(x, y, target)],
    }),
  )
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
  const at = (f: number) => box.left + box.width * f

  const from = 0.3
  fireTouch('touchstart', thumb, at(from), y, thumb)
  await new Promise((resolve) => setTimeout(resolve, 16))
  // A finger produces a stream of moves, not one jump - steps of about a
  // frame, which is what decides how many commands the speaker is sent.
  for (let step = 1; step <= steps; step++) {
    fireTouch('touchmove', window, at(from + ((fraction - from) * step) / steps), y, thumb)
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  fireTouch('touchend', thumb, at(fraction), y, thumb)
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

  // The reported bug, and the shape of the fix: a finger reports every
  // frame, and each move used to go straight out. Two dozen requests to a
  // speaker answering in its own time meant its readings disagreed with the
  // slider for as long as the backlog took to clear, and the slider was put
  // back to roughly where the drag began. The speaker is now told once, on
  // release - the way the LAN remote has always done it, see
  // static/remote/js/views/now-playing.js.
  it('tells the speaker once for a whole drag, on release', async () => {
    const { setDeviceVolume } = await mountControls('sonos', 60)

    await dragTo(0.85, 25)
    // Nothing may have gone out yet: the finger has lifted, but a move is
    // not a command.
    const duringDrag = setDeviceVolume.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 300))

    const sent = setDeviceVolume.mock.calls.map((call) => call[2] as number)
    expect(duringDrag).toBeLessThanOrEqual(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(Number(label().replace('%', '')))
  })

  // What all of this is actually for: the speaker goes on reporting the old
  // level for a while after the drag, and that must not reach the slider.
  it('keeps the released level while the speaker still reports the old one', async () => {
    await mountControls('sonos', 300)
    await dragTo(0.85, 25)
    const released = label()
    expect(released).not.toBe('30%')

    const connect = useConnectStore()
    for (let tick = 0; tick < 8; tick++) {
      connect.status = makeStatus({
        targets: [{ name: 'Kitchen', type: 'sonos', volume: 30, volume_push: true }],
      })
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    expect(label()).toBe(released)
  })
})

// A drag does not always end in a touchend. The browser takes the touch
// away - `touchcancel`, no touchend - as soon as it decides the gesture was
// a scroll, which on a phone is a drag a few pixels off the horizontal, and
// the track is the easy thing to hit rather than the thumb. What that used
// to leave behind was not confined to the gesture: Vuetify's slider never
// finished its drag, so the window-level touchmove listener it had
// installed stayed installed and went on driving the slider from any later
// finger anywhere on the page - a swipe up the page near its left edge set
// the speaker to 0. See services/sliderTouchCancel.ts.
describe('a drag the browser takes away', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
    vi.restoreAllMocks()
  })

  async function cancelDragOnTrack() {
    const track = document.querySelector('.v-slider-track')! as HTMLElement
    const box = track.getBoundingClientRect()
    const y = box.top + box.height / 2
    fireTouch('touchstart', track, box.left + box.width * 0.5, y, track)
    await new Promise((resolve) => setTimeout(resolve, 16))
    fireTouch('touchmove', window, box.left + box.width * 0.55, y + 20, track)
    await new Promise((resolve) => setTimeout(resolve, 16))
    fireTouch('touchcancel', track, box.left + box.width * 0.55, y + 40, track)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  it('keeps the level it was taken away at, and lets go of the slider', async () => {
    const { setDeviceVolume } = await mountControls()

    await cancelDragOnTrack()
    const afterCancel = label()
    expect(afterCancel).not.toBe('30%')
    setDeviceVolume.mockClear()

    // A later, unrelated finger: a swipe up the page, nowhere near the
    // slider.
    const elsewhere = document.querySelector('.mobile-transport__row')! as HTMLElement
    fireTouch('touchstart', elsewhere, 5, 5, elsewhere)
    fireTouch('touchmove', window, 5, 300, elsewhere)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(setDeviceVolume).not.toHaveBeenCalled()
    expect(label()).toBe(afterCancel)
  })

  // The other half of never finishing the drag: the guard was left holding
  // one, and from then on the slider ignored every reading the speaker sent
  // - turning the dial on the speaker itself no longer showed up here.
  it('believes the speaker again afterwards', async () => {
    await mountControls()
    await cancelDragOnTrack()

    const connect = useConnectStore()
    connect.status = makeStatus({
      targets: [{ name: 'Kitchen', type: 'sonos', volume: 12, volume_push: true }],
    })
    // Past the settle window a change of our own opens (see
    // volumeGuard.VOLUME_SETTLE_MS), which is meant to expire - unlike a
    // drag, which only ends when the finger lifts.
    await new Promise((resolve) => setTimeout(resolve, VOLUME_SETTLE_MS + 100))
    connect.status = makeStatus({
      targets: [{ name: 'Kitchen', type: 'sonos', volume: 13, volume_push: true }],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(label()).toBe('13%')
  })

  // And what keeps the browser from taking the drag away in the first
  // place: the track Vuetify ships is `touch-action: pan-y`, which lets the
  // page claim any drag with a vertical component to it (see base.css).
  it('claims a drag on the track rather than leaving it to the page', async () => {
    await mountControls()
    const track = document.querySelector('.v-slider-track')!
    expect(getComputedStyle(track).touchAction).toBe('none')
  })
})
