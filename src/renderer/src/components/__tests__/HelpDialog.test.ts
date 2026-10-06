import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { HELP_PAGES, findHelpPage, renderHelpPage, type HelpDocId } from '@/services/help/docs'
import HelpDialog from '../HelpDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function openOn(id: HelpDocId) {
  const wrapper = mount(HelpDialog, {
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  emitter.emit('openHelp', id)
  await flushPromises()
  return wrapper
}

function content(): HTMLElement {
  return document.querySelector('.beacon-markdown') as HTMLElement
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
})

describe('HelpDialog', () => {
  it('opens on the doc it was asked for', async () => {
    await openOn('party-mode')
    expect(content().querySelector('#over-the-internet')).not.toBeNull()
  })

  it('follows a link to another doc inside the dialog', async () => {
    // Any page linking to another doc will do - whichever one does today.
    const from = HELP_PAGES.find((page) =>
      /data-help-page="(?!faq)[^"]+"/.test(page.doc === 'faq' ? renderHelpPage(page) : ''),
    )!
    const wrapper = await openOn('faq')
    ;(wrapper.vm as unknown as { pageId: string }).pageId = from.id
    await flushPromises()
    const link = content().querySelector<HTMLAnchorElement>(
      'a[data-help-page]:not([data-help-page^="faq"])',
    )!
    const target = findHelpPage(link.dataset.helpPage!)
    link.click()
    await flushPromises()
    expect((wrapper.vm as unknown as { pageId: string }).pageId).toBe(target.id)
    expect(content().querySelector(`[id="${link.dataset.helpAnchor}"]`)).not.toBeNull()
  })
})
