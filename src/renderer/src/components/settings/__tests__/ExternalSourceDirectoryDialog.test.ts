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
    author: 'someone',
    image: null,
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

  it('shows each app with where its repository is', async () => {
    const { wrapper } = await mountDialog()
    const rows = wrapper.findAll('.source-directory__card')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('Folder')
    expect(rows[0]!.get('.source-directory__repo').text()).toBe('github.com/someone/folder')
  })

  it('credits the author with a link to their profile', async () => {
    const { wrapper } = await mountDialog()
    const author = wrapper.get('.source-directory__author')
    expect(author.attributes('href')).toBe('https://github.com/someone')
    expect(author.text()).toContain('@someone')
  })

  it('leads to the project in the browser, nothing installed', async () => {
    const { wrapper } = await mountDialog()
    const open = wrapper.get('.source-directory__open')
    expect(open.attributes('href')).toBe('https://github.com/someone/folder')
    expect(open.attributes('target')).toBe('_blank')
    expect(open.attributes('rel')).toContain('noopener')
  })

  it('shows the picture from the repository, and the icon if it does not load', async () => {
    const image = 'https://raw.githubusercontent.com/someone/folder/main/icon.webp'
    vi.mocked(fetchDirectory).mockResolvedValue([{ ...APPS[0]!, image }])
    const { wrapper } = await mountDialog()
    const img = wrapper.get('.source-directory__art img')
    expect(img.attributes('src')).toBe(image)
    await img.trigger('error')
    expect(wrapper.find('.source-directory__art img').exists()).toBe(false)
    expect(wrapper.find('.source-directory__art .mdi-album').exists()).toBe(true)
  })

  it('says when the list could not be read, and asks again', async () => {
    vi.mocked(fetchDirectory).mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper } = await mountDialog()
    expect(wrapper.find('.source-directory__card').exists()).toBe(false)
    const asked = vi.mocked(fetchDirectory).mock.calls.length
    await wrapper.get('.source-directory__retry').trigger('click')
    await flushPromises()
    expect(fetchDirectory).toHaveBeenCalledTimes(asked + 1)
    expect(wrapper.findAll('.source-directory__card')).toHaveLength(1)
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
