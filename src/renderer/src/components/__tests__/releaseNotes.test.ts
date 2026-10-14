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

  it('asks GitHub only once someone picks them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('## [Unreleased]\n\n- A feature still in the works\n'))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountNotes()
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()

    wrapper.vm.selectedVersion = 'upcoming'
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('A feature still in the works')
    wrapper.unmount()
  })

  it('says it failed and can try again', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountNotes()
    wrapper.vm.selectedVersion = 'upcoming'
    await flushPromises()

    expect(document.body.textContent).toContain(i18n.global.t('releaseNotes.upcomingFailed'))

    fetchMock.mockResolvedValue(new Response('## [Unreleased]\n\n- Back online\n'))
    const retry = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(i18n.global.t('common.retry')),
    )
    retry?.click()
    await flushPromises()

    expect(document.body.textContent).toContain('Back online')
    wrapper.unmount()
  })
})
