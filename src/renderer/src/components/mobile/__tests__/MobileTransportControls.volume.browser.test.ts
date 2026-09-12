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

/** Drive the native range the way the browser does while a finger drags
 * it: set the value, fire `input`, and fire `change` once on release. The
 * browser owns the gesture itself, which is the whole point of using one -
 * a synthetic touch sequence would be testing our own event faking, not
 * the drag. */
function range(): HTMLInputElement {
  return document.querySelector('.touch-volume-slider') as HTMLInputElement
}

async function dragTo(percent: number, steps = 20) {
  const el = range()
  const from = Number(el.value)
  for (let step = 1; step <= steps; step++) {
    el.value = String(Math.round(from + ((percent - from) * step) / steps))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('the cast volume slider', () => {
  afterEach(() => {
    currentWrapper?.unmount()
    currentWrapper = null
    vi.restoreAllMocks()
  })

  // Why a native range at all: Vuetify's VSlider binds touchstart passively
  // and moves with { passive: true }, so it can never preventDefault and
  // has no way to stop the browser taking a drag for a scroll mid-gesture.
  // On real hardware that showed as a drag moving a few percent and
  // stopping, or doing nothing, while a tap always worked - and it
  // reproduced on no emulator, because an emulated drag travels exactly
  // horizontally and a finger never does. A native range is dragged by the
  // browser itself, so there is no gesture to lose.
  it('is a native range the browser drags itself', async () => {
    await mountControls()
    const el = range()

    expect(el.tagName).toBe('INPUT')
    expect(el.type).toBe('range')
    // The page still must not claim a slightly-off-horizontal drag.
    expect(getComputedStyle(el).touchAction).toBe('none')
  })

  it('keeps the dragged-to level after the finger lifts, and sends it once', async () => {
    const { setDeviceVolume } = await mountControls()
    expect(label()).toBe('30%')

    await dragTo(80)

    expect(label()).toBe('80%')
    expect(setDeviceVolume.mock.calls.at(-1)?.slice(0, 2)).toEqual(['sonos', 'Kitchen'])
  })

  // The speaker is told once per drag, the way the LAN remote has always
  // done it (an `input` listener that only paints, a `change` listener that
  // sends - see static/remote/js/views/now-playing.js). Sending every move
  // instead meant a drag became ~25 requests to a speaker answering in its
  // own time, and its readings then disagreed with the slider until the
  // backlog cleared.
  it('tells the speaker once for a whole drag, on release', async () => {
    const { setDeviceVolume } = await mountControls('sonos', 60)

    await dragTo(85, 25)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const sent = setDeviceVolume.mock.calls.map((call) => call[2] as number)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(85)
  })

  // What the guard is actually for: the speaker goes on reporting the old
  // level for a while after a change, and that must not reach the slider.
  it('keeps the released level while the speaker still reports the old one', async () => {
    await mountControls('sonos', 300)
    await dragTo(85, 25)

    const connect = useConnectStore()
    for (let tick = 0; tick < 8; tick++) {
      connect.status = makeStatus({
        targets: [{ name: 'Kitchen', type: 'sonos', volume: 30, volume_push: true }],
      })
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    expect(label()).toBe('85%')
  })

  // And it does expire - a hand on the speaker's own dial still shows up.
  it('believes the speaker again once it has had time to catch up', async () => {
    await mountControls('sonos', 0)
    await dragTo(85, 5)

    await new Promise((resolve) => setTimeout(resolve, VOLUME_SETTLE_MS + 200))
    useConnectStore().status = makeStatus({
      targets: [{ name: 'Kitchen', type: 'sonos', volume: 12, volume_push: true }],
    })
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(label()).toBe('12%')
  })
})
