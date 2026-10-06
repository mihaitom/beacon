import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { findHelpDoc } from '@/services/help/docs'
import HelpDialog from '../HelpDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function openOn(id: Parameters<typeof findHelpDoc>[0]) {
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
    await openOn('faq')
    const link = content().querySelector<HTMLAnchorElement>('a[data-help-doc="party-mode"]')!
    link.click()
    await flushPromises()
    expect(content().querySelector('#over-the-internet')).not.toBeNull()
  })
})
