import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { useRemoteControlStore } from '@/stores/remoteControl'
import RemoteControlPairingDialog from '../RemoteControlPairingDialog.vue'

// The dialog draws a real QR code onto a <canvas> when it opens, which
// jsdom has no 2D context for. What is under test here is when the dialog
// takes itself away, not what it paints.
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }))

const vuetify = createVuetify({ components, directives })

function mountDialog() {
  const store = useRemoteControlStore()
  store.enabled = true
  store.password = 'secret'
  store.pin = '123456'
  store.lanIp = '192.168.0.2'
  store.port = 9181
  const wrapper = mount(RemoteControlPairingDialog, {
    props: { modelValue: false },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: emitter },
    },
  })
  return { wrapper, store }
}

/** Opens it the way the button does, through the prop, so the dialog's own
 * modelValue watcher runs — that is what arms the behaviour below. */
async function open(wrapper: ReturnType<typeof mountDialog>['wrapper']) {
  await wrapper.setProps({ modelValue: true })
  await wrapper.vm.$nextTick()
}

/** What the dialog asks its parent to do, if anything. */
function closeRequests(wrapper: ReturnType<typeof mountDialog>['wrapper']) {
  return (wrapper.emitted('update:modelValue') ?? []).filter((event) => event[0] === false)
}

describe('RemoteControlPairingDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** By the time the code has been scanned the user is holding a phone,
   * and putting it down to reach for the mouse is enough friction that
   * the dialog just stays open instead. Whether the pairing worked is
   * already plain on the phone, so this closes rather than announcing
   * anything. */
  it('closes itself once a phone is on the line', async () => {
    const { wrapper, store } = mountDialog()
    await open(wrapper)

    store.phoneCount += 1
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(1)
  })

  /** The dialog also carries the PIN, the address with its copy button and
   * "regenerate". A window that vanishes mid-action, because of something
   * that happened on another device, is the part of this worth being
   * careful about. */
  it('stays put once it has been used for something else', async () => {
    const { wrapper, store } = mountDialog()
    await open(wrapper)
    await (wrapper.vm as unknown as { copyAddress(): Promise<void> }).copyAddress()

    store.phoneCount += 1
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(0)
  })

  /** Phones connect and reconnect all the time on their own. Only a dialog
   * that is actually on screen has anything to do about it. */
  it('does nothing about a phone while it is not even open', async () => {
    const { wrapper, store } = mountDialog()

    store.phoneCount += 1
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(0)
  })

  /** A phone dropping off is not a pairing. The dialog is very likely
   * open *because* one just went away and the user is setting it up
   * again. */
  it('ignores the count going down', async () => {
    const { wrapper, store } = mountDialog()
    // Settled before opening: a watcher runs on the next flush, so setting
    // this and opening in the same one would arrive as a phone connecting
    // into an already-open dialog.
    store.phoneCount = 1
    await wrapper.vm.$nextTick()
    await open(wrapper)

    store.phoneCount = 0
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(0)
  })

  /** Switching Remote Control off moved in here from the button, which has
   * to stay the way back to the pairing code. */
  it('turns remote control off and closes', async () => {
    const { wrapper, store } = mountDialog()
    const disableSpy = vi.spyOn(store, 'disable').mockResolvedValue()
    await open(wrapper)

    await (wrapper.vm as unknown as { turnOff(): Promise<void> }).turnOff()

    expect(disableSpy).toHaveBeenCalledOnce()
    expect(closeRequests(wrapper)).toHaveLength(1)
  })

  it('stays open with an error toast when turning off fails', async () => {
    const { wrapper, store } = mountDialog()
    vi.spyOn(store, 'disable').mockRejectedValue(new Error('network down'))
    const toastSpy = vi.fn()
    emitter.on('toast', toastSpy)
    await open(wrapper)

    await (wrapper.vm as unknown as { turnOff(): Promise<void> }).turnOff()

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: "Couldn't disable Remote Control." }),
    )
    expect(closeRequests(wrapper)).toHaveLength(0)
    emitter.off('toast', toastSpy)
  })

  /** Reopened, it is back to being just a QR code — the guard above is
   * about the session it was raised in, not a permanent mark. */
  it('is armed again the next time it opens', async () => {
    const { wrapper, store } = mountDialog()
    await open(wrapper)
    await (wrapper.vm as unknown as { copyAddress(): Promise<void> }).copyAddress()
    await wrapper.setProps({ modelValue: false })

    await open(wrapper)
    store.phoneCount += 1
    await wrapper.vm.$nextTick()

    expect(closeRequests(wrapper)).toHaveLength(1)
  })
})
