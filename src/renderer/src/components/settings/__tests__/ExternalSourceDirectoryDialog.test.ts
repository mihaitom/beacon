// The list of apps by others: that it shows what the list holds, says when
// it could not be read and can ask again, and hands an app on to be added -
// not the copy or the layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { fetchDirectory } from '@/services/externalSourceDirectory'
import ExternalSourceDirectoryDialog from '../ExternalSourceDirectoryDialog.vue'

vi.mock('@/services/externalSourceDirectory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/externalSourceDirectory')>()),
  fetchDirectory: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })

// Teleported otherwise, out of the wrapper's reach.
const INLINE_DIALOG = { template: '<div class="stub-dialog"><slot /></div>' }

const APPS = [
  {
    name: 'Folder',
    description: 'Plays a folder.',
    repository: 'https://github.com/someone/folder',
    icon: 'mdi-album',
  },
]

async function mountDialog() {
  const emit = vi.fn()
  const wrapper = mount(ExternalSourceDirectoryDialog, {
    props: { modelValue: true },
    global: {
      plugins: [vuetify, i18n],
      mocks: { $emitter: { emit, on: vi.fn(), off: vi.fn() } },
      stubs: { VDialog: INLINE_DIALOG },
    },
  })
  await flushPromises()
  return { wrapper, emit }
}

describe('ExternalSourceDirectoryDialog', () => {
  beforeEach(() => vi.mocked(fetchDirectory).mockResolvedValue(APPS))
  afterEach(() => vi.clearAllMocks())

  it('shows each app with a link to its repository', async () => {
    const { wrapper } = await mountDialog()
    const rows = wrapper.findAll('.source-directory__row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('Folder')
    expect(rows[0]!.get('a').attributes('href')).toBe('https://github.com/someone/folder')
    expect(rows[0]!.get('a').attributes('rel')).toContain('noopener')
  })

  it('hands the app on when it is added', async () => {
    const { wrapper } = await mountDialog()
    await wrapper.get('.source-directory__add').trigger('click')
    expect(wrapper.emitted('add')?.[0]).toEqual([APPS[0]])
  })

  it('says when the list could not be read, and asks again', async () => {
    vi.mocked(fetchDirectory).mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper } = await mountDialog()
    expect(wrapper.find('.source-directory__row').exists()).toBe(false)
    const asked = vi.mocked(fetchDirectory).mock.calls.length
    await wrapper.get('.source-directory__retry').trigger('click')
    await flushPromises()
    expect(fetchDirectory).toHaveBeenCalledTimes(asked + 1)
    expect(wrapper.findAll('.source-directory__row')).toHaveLength(1)
  })

  it('leads to the help on listing an app', async () => {
    const { wrapper, emit } = await mountDialog()
    await wrapper.get('.source-directory__list-yours').trigger('click')
    expect(emit).toHaveBeenCalledWith('openHelp', {
      page: 'faq/external-sources',
      anchor: 'how-do-i-list-my-own-app',
    })
  })
})
