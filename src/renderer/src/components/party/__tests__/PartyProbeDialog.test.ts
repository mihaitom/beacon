import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { probeParty, type ProbeResult } from '@/services/party/http'
import { h, nextTick, ref } from 'vue'
import PartyProbeDialog from '../PartyProbeDialog.vue'

vi.mock('@/services/party/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/party/http')>()),
  probeParty: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const t = (key: string, values: Record<string, unknown> = {}) => i18n.global.t(key, values)

/** Opened as the party dialog opens it - which is what starts the test. */
async function runWith(result: ProbeResult) {
  vi.mocked(probeParty).mockResolvedValue(result)
  const open = ref(false)
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () =>
            h(PartyProbeDialog, { modelValue: open.value, origin: 'https://beacon.example.com' }),
        }),
    },
    { attachTo: document.body, global: { plugins: [vuetify, i18n], mocks: { $emitter: emitter } } },
  )
  mounted.push(wrapper)
  open.value = true
  await nextTick()
  await flushPromises()
  return { text: () => document.body.textContent ?? '' }
}

const mounted: ReturnType<typeof mount>[] = []

describe('the online party setup test', () => {
  beforeEach(() => {
    i18n.global.locale = 'en' as never
    vi.mocked(probeParty).mockReset()
  })

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount())
    document.body.innerHTML = ''
  })

  it('runs as soon as it opens, against the address the party link points at', async () => {
    await runWith({ steps: [], addresses: [], public_addresses: [] })
    expect(probeParty).toHaveBeenCalledWith('https://beacon.example.com')
  })

  it('says what each step found, and nothing about DNS when guests can get in', async () => {
    const wrapper = await runWith({
      steps: [
        { id: 'address', status: 'ok', code: '', detail: 'beacon.example.com' },
        { id: 'dns', status: 'ok', code: 'public', detail: '93.184.215.14' },
        { id: 'reach', status: 'ok', code: '', detail: '' },
      ],
      addresses: ['93.184.215.14'],
      public_addresses: [],
    })
    expect(wrapper.text()).toContain(
      t('party.probe.codes.dns.public', { host: 'beacon.example.com', addresses: '93.184.215.14' }),
    )
    expect(wrapper.text()).not.toContain(t('party.probe.dnsHint'))
    expect(wrapper.text()).toContain(t('party.probe.phoneHint'))
  })

  it('points at DNS where a name only the home network knows could be why', async () => {
    const wrapper = await runWith({
      steps: [
        { id: 'address', status: 'ok', code: '', detail: '' },
        { id: 'dns', status: 'ok', code: 'private', detail: '' },
        { id: 'reach', status: 'warn', code: 'local-only', detail: '' },
      ],
      addresses: ['192.168.1.10'],
      public_addresses: [],
    })
    expect(wrapper.text()).toContain(t('party.probe.dnsHint'))
  })

  it('points at DNS when the party could not be reached at all', async () => {
    const wrapper = await runWith({
      steps: [
        { id: 'address', status: 'ok', code: '', detail: '' },
        { id: 'dns', status: 'ok', code: 'public', detail: '' },
        { id: 'reach', status: 'unclear', code: 'unreachable', detail: '' },
      ],
      addresses: ['93.184.215.14'],
      public_addresses: [],
    })
    expect(wrapper.text()).toContain(t('party.probe.dnsHint'))
  })

  it('opens the proxy setups in the help', async () => {
    const opened = vi.fn()
    emitter.on('openHelp', opened)
    await runWith({ steps: [], addresses: [], public_addresses: [] })
    ;(document.querySelector('.party-probe__hint a') as HTMLElement).click()
    expect(opened).toHaveBeenCalledWith({ page: 'party-mode', anchor: 'over-the-internet' })
    emitter.off('openHelp', opened)
  })

  it('says where public DNS does not know the name, the cause guests outside run into', async () => {
    const wrapper = await runWith({
      steps: [
        { id: 'dns', status: 'ok', code: 'private', detail: '' },
        { id: 'public-dns', status: 'fail', code: 'missing', detail: '' },
        { id: 'reach', status: 'warn', code: 'local-only', detail: '' },
      ],
      addresses: ['10.2.2.7'],
      public_addresses: [],
    })
    expect(wrapper.text()).toContain(t('party.probe.dnsHint'))
  })

  it('needs no DNS hint once the way in from the internet worked', async () => {
    const wrapper = await runWith({
      steps: [
        { id: 'dns', status: 'ok', code: 'private', detail: '' },
        { id: 'public-dns', status: 'ok', code: 'public', detail: '' },
        { id: 'reach', status: 'ok', code: 'home', detail: '' },
        { id: 'reach-public', status: 'ok', code: '', detail: '' },
      ],
      addresses: ['10.2.2.7'],
      public_addresses: ['93.184.215.14'],
    })
    expect(wrapper.text()).not.toContain(t('party.probe.dnsHint'))
    expect(wrapper.text()).toContain(
      t('party.probe.codes.reach-public.ok', { publicAddresses: '93.184.215.14' }),
    )
  })

  it('words a failure from the internet like one from here', async () => {
    const wrapper = await runWith({
      steps: [{ id: 'reach-public', status: 'fail', code: 'login', detail: '' }],
      addresses: [],
      public_addresses: ['93.184.215.14'],
    })
    expect(wrapper.text()).toContain(t('party.probe.codes.reach.login'))
  })
})
