import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import { VBtn } from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePlaybackStore } from '@/stores/playback'
import { makeStatus } from '@/stores/__tests__/fixtures'
import { emitter } from '@/emitter'
import MobileDevicePicker from '../MobileDevicePicker.vue'
import MobileDeviceRow from '../MobileDeviceRow.vue'

const vuetify = createVuetify({ components, directives })

// v-bottom-sheet teleports its content to the document body, so the usual
// wrapper queries find nothing — attaching to the document and querying it
// directly is what actually reaches the rendered sheet.
function mountPicker() {
  return mount(MobileDevicePicker, {
    props: { modelValue: true },
    attachTo: document.body,
    global: {
      plugins: [vuetify, i18n],
      // $emitter is a global property (see main.ts), not something a
      // bare mount() sets up.
      mocks: { $emitter: emitter },
    },
  })
}

function rescanButton(wrapper: ReturnType<typeof mountPicker>) {
  return wrapper.getComponent<typeof VBtn>('.mobile-device-picker__rescan')
}

function doneButton(wrapper: ReturnType<typeof mountPicker>) {
  return wrapper.findAllComponents<typeof VBtn>(VBtn).at(-1)!
}

function withDevices(sonos: string[]) {
  const connect = useConnectStore()
  connect.devices = {
    sonos: sonos.map((name) => ({ name })),
    airplay: [],
    chromecast: [],
    dlna: [],
  } as unknown as typeof connect.devices
  return connect
}

describe('MobileDevicePicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('re-seeds an untouched sheet while it stays open', async () => {
    const connect = withDevices(['Kitchen', 'Living Room'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    // Another client casting, or a device dropping off the network. The
    // sheet only ever seeded on open before, so anything happening after
    // that left it describing a target set that no longer existed — and
    // "Done" then applied that stale set as the user's intent.
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents(MobileDeviceRow).map((r) => r.props('selected'))).toEqual([
      true,
      false,
    ])
  })

  it('never re-seeds over a selection the user is in the middle of making', async () => {
    const connect = withDevices(['Kitchen', 'Living Room'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()

    await wrapper.findAllComponents(MobileDeviceRow)[1]!.vm.$emit('toggle')
    connect.status = makeStatus({ targets: [{ name: 'Kitchen', type: 'sonos' }] })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents(MobileDeviceRow).map((r) => r.props('selected'))).toEqual([
      false,
      true,
    ])
  })

  it('take-over adds the device to what is already playing', async () => {
    const connect = withDevices(['Kitchen', 'Living Room'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    connect.status = makeStatus({ targets: [{ name: 'Living Room', type: 'sonos' }] })
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    const applySpy = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()

    await wrapper.findAllComponents(MobileDeviceRow)[0]!.vm.$emit('take-over')
    await wrapper.vm.$nextTick()

    // A claimed row's tap is inert (MobileDeviceRow.vue's onRowClick()), so
    // this is the only way to pick such a device — castTo() made it the
    // only way to lose every other speaker at the same time.
    expect(applySpy).toHaveBeenCalledWith(
      [
        expect.objectContaining({ name: 'Living Room', type: 'sonos' }),
        { name: 'Kitchen', type: 'sonos' },
      ],
      true,
    )
    // Ticked even though nothing was tapped, and counted as applied — so
    // a later "Done" doesn't turn round and stop the device just taken.
    expect(wrapper.findAllComponents(MobileDeviceRow).map((r) => r.props('selected'))).toEqual([
      true,
      true,
    ])
  })

  it('reports a failed apply and keeps the sheet open to retry from', async () => {
    const connect = withDevices(['Kitchen'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    vi.spyOn(usePlaybackStore(), 'applyTargets').mockRejectedValue(new Error('offline'))
    connect.errors.message = 'Speaker unreachable.'
    const toast = vi.fn()
    emitter.on('toast', toast)

    await wrapper.findAllComponents(MobileDeviceRow)[0]!.vm.$emit('toggle')
    await doneButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()

    // This sheet has no inline error surface the way the desktop picker
    // does, so a failure used to make "Done" simply do nothing visible
    // while the rejection went unhandled.
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'Speaker unreachable.' }),
    )
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    emitter.off('toast', toast)
  })

  it('stays open on a takeover conflict so the dialog says which device', async () => {
    const connect = withDevices(['Kitchen'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    vi.spyOn(usePlaybackStore(), 'applyTargets').mockImplementation(async () => {
      connect.pendingTakeover = {
        device: { name: 'Kitchen', type: 'sonos' },
        owner: 'someone else',
        retry: async () => {},
      }
    })

    await wrapper.findAllComponents(MobileDeviceRow)[0]!.vm.$emit('toggle')
    await doneButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('closes without applying anything when the selection was never touched', async () => {
    const connect = withDevices(['Kitchen'])
    vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    const applySpy = vi.spyOn(usePlaybackStore(), 'applyTargets').mockResolvedValue()

    await doneButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()

    expect(applySpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('kicks off a fresh scan from the rescan button, and locks it while one runs', async () => {
    const connect = useConnectStore()
    // Before mounting: an open sheet refreshes on its own (see the
    // modelValue watcher), and a real call there leaves isScanning true
    // long enough to disable the button this test is about to click.
    const refreshSpy = vi.spyOn(connect, 'refreshDevices').mockResolvedValue()
    const wrapper = mountPicker()
    await wrapper.vm.$nextTick()
    refreshSpy.mockClear()

    const rescan = rescanButton(wrapper)
    expect(rescan.props('icon')).toBe('mdi-refresh')

    await rescan.trigger('click')
    expect(refreshSpy).toHaveBeenCalledWith(true)

    // Same reason as ConnectDevicePicker.vue's: overlapping scans would let
    // the first one to return clear isScanning while the second still runs.
    connect.isScanning = true
    await wrapper.vm.$nextTick()

    expect(rescan.props('loading')).toBe(true)
    expect(rescan.props('disabled')).toBe(true)
  })
})
