import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { HELP_PAGES, type HelpDocId } from '@/services/help/docs'
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

  it('follows a link to another page inside the dialog', async () => {
    // A link as renderHelpPage() writes one, so this does not depend on
    // which docs happen to link to each other today.
    const target = HELP_PAGES.find((page) => page.doc !== 'faq')!
    const anchor = [...target.anchors].at(-1)!
    const wrapper = await openOn('faq')
    const link = document.createElement('a')
    link.href = `#${anchor}`
    link.dataset.helpPage = target.id
    link.dataset.helpAnchor = anchor
    content().append(link)
    link.click()
    await flushPromises()
    expect((wrapper.vm as unknown as { pageId: string }).pageId).toBe(target.id)
    expect(content().querySelector(`[id="${anchor}"]`)).not.toBeNull()
  })

  it('opens on one page at a heading, as a link from elsewhere asks', async () => {
    const page = HELP_PAGES.find((p) => p.doc === 'faq' && p !== HELP_PAGES[0])!
    const anchor = [...page.anchors].at(-1)!
    const wrapper = await openOn('faq')
    emitter.emit('openHelp', { page: page.id, anchor })
    await flushPromises()
    expect((wrapper.vm as unknown as { pageId: string }).pageId).toBe(page.id)
    expect(content().querySelector(`[id="${anchor}"]`)).not.toBeNull()
  })
})
