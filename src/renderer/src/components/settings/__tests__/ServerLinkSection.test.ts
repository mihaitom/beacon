// Pairing with a server: a refusal says why, and the key does not stay in
// the form once it has been used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import ServerLinkSection from '../ServerLinkSection.vue'
import {
  getServerLink,
  pairServerLink,
  unpairServerLink,
  type ServerLinkStatus,
} from '@/services/connect/serverLink'

vi.mock('@/services/connect/serverLink', () => ({
  getServerLink: vi.fn(),
  pairServerLink: vi.fn(),
  unpairServerLink: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const UNPAIRED: ServerLinkStatus = { available: true, linked: false }
const PAIRED: ServerLinkStatus = {
  available: true,
  linked: true,
  url: 'https://beacon.example',
  remote_username: 'alice',
  state: 'connected',
  last_sync_at: null,
  unsent: 0,
}

async function mountSection() {
  const emit = vi.fn()
  const wrapper = mount(ServerLinkSection, {
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
    },
  })
  await flushPromises()
  return { wrapper, emit }
}

async function submit(wrapper: Awaited<ReturnType<typeof mountSection>>['wrapper']) {
  await wrapper.setData({ url: 'https://beacon.example', key: 'the-key' })
  await (wrapper.vm as unknown as { pair(): Promise<void> }).pair()
  await flushPromises()
}

describe('ServerLinkSection', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {}
    vi.mocked(getServerLink).mockReset().mockResolvedValue(UNPAIRED)
    vi.mocked(pairServerLink).mockReset()
    vi.mocked(unpairServerLink).mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('is not offered in a browser', async () => {
    delete (window as unknown as { api?: unknown }).api
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
    expect(getServerLink).not.toHaveBeenCalled()
  })

  it('is not offered where connect refuses it', async () => {
    vi.mocked(getServerLink).mockResolvedValue({ available: false, linked: false })
    const { wrapper } = await mountSection()
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('sends what was entered and forgets the key afterwards', async () => {
    vi.mocked(pairServerLink).mockResolvedValue(PAIRED)
    const { wrapper } = await mountSection()
    await submit(wrapper)
    expect(pairServerLink).toHaveBeenCalledWith('https://beacon.example', 'the-key')
    expect((wrapper.vm as unknown as { key: string }).key).toBe('')
  })

  it('says why a pairing was refused and keeps the form', async () => {
    vi.mocked(pairServerLink).mockResolvedValue({
      available: true,
      linked: false,
      error: 'wrong_key',
    })
    const { wrapper } = await mountSection()
    await submit(wrapper)
    expect(wrapper.text()).toContain(i18n.global.t('settings.serverLinkWrongKey'))
    expect((wrapper.vm as unknown as { key: string }).key).toBe('the-key')
  })

  it('shows what stands in the way of a working pairing', async () => {
    vi.mocked(getServerLink).mockResolvedValue({ ...PAIRED, state: 'blocked' })
    const { wrapper } = await mountSection()
    expect(wrapper.text()).toContain(i18n.global.t('settings.serverLinkBlocked'))
  })

  it('reports a request that failed outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pairServerLink).mockRejectedValue(new Error('offline'))
    const { wrapper, emit } = await mountSection()
    await submit(wrapper)
    expect(emit).toHaveBeenCalledWith('toast', expect.objectContaining({ level: 'error' }))
  })

  it('goes back to the form after disconnecting', async () => {
    vi.mocked(getServerLink).mockResolvedValue(PAIRED)
    vi.mocked(unpairServerLink).mockResolvedValue(UNPAIRED)
    const { wrapper } = await mountSection()
    await (wrapper.vm as unknown as { unpair(): Promise<void> }).unpair()
    await flushPromises()
    expect((wrapper.vm as unknown as { link: ServerLinkStatus }).link.linked).toBe(false)
  })
})
