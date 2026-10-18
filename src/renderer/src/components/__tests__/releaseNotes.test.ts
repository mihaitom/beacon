import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import ReleaseNotes, { renderNotes } from '../releaseNotes.vue'

describe('release notes', () => {
  it('opens a link in a window of its own, not in place of the app', () => {
    const html = renderNotes('Please [open an issue](https://github.com/mihaitom/beacon/issues).')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does the same for a bare address', () => {
    expect(renderNotes('See https://example.com for more.')).toContain('target="_blank"')
  })
})

describe('upcoming changes', () => {
  const vuetify = createVuetify({ components, directives })

  function mountNotes() {
    const wrapper = mount(ReleaseNotes, {
      global: { plugins: [vuetify, i18n, createPinia()] },
      attachTo: document.body,
    })
    wrapper.vm.visible = true
    return wrapper
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  type NotesVm = {
    selectedVersion: string
    readonly versionOptions: { title: string; value: string }[]
    openDialog(autoOpen?: boolean): void
  }

  async function openWith(changelog: string) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(changelog))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountNotes()
    const vm = wrapper.vm as unknown as NotesVm
    vm.openDialog()
    await flushPromises()
    return { wrapper, vm, fetchMock }
  }

  const values = (vm: NotesVm) => vm.versionOptions.map((option) => option.value)

  it('offers what is in development only when there is something in it', async () => {
    const { wrapper, vm } = await openWith('## [Unreleased]\n\n- A feature still in the works\n')

    expect(values(vm)[0]).toBe('upcoming')
    vm.selectedVersion = 'upcoming'
    await flushPromises()
    expect(document.body.textContent).toContain('A feature still in the works')
    wrapper.unmount()
  })

  it('leaves it out while the development changelog lists nothing new', async () => {
    const { wrapper, vm } = await openWith('## [Unreleased]\n\n### Added\n\n### Fixed\n')

    expect(values(vm)).not.toContain('upcoming')
    wrapper.unmount()
  })

  it('offers each release newer than this one as its own version', async () => {
    const { wrapper, vm } = await openWith(
      '## [Unreleased]\n\n## [99.1.0] - 2099-02-01\n\n- Later still\n\n## [99.0.0] - 2099-01-01\n\n- The next one\n',
    )

    expect(values(vm).slice(0, 2)).toEqual(['99.1.0', '99.0.0'])
    vm.selectedVersion = '99.0.0'
    await flushPromises()
    expect(document.body.textContent).toContain('The next one')
    wrapper.unmount()
  })

  it('asks GitHub once per run, and again after a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountNotes()
    const vm = wrapper.vm as unknown as NotesVm

    vm.openDialog()
    await flushPromises()
    // Nothing to offer, rather than an entry that only says it failed.
    expect(values(vm)).not.toContain('upcoming')

    fetchMock.mockResolvedValue(new Response('## [Unreleased]\n\n- Back online\n'))
    vm.openDialog()
    await flushPromises()
    vm.openDialog()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(values(vm)).toContain('upcoming')
    wrapper.unmount()
  })
})
