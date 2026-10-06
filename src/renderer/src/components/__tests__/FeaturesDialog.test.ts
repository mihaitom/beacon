import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import FeaturesDialog from '../FeaturesDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function open() {
  const wrapper = mount(FeaturesDialog, {
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  emitter.emit('openFeatures')
  await flushPromises()
  return document.querySelector('.beacon-markdown') as HTMLElement
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('FeaturesDialog', () => {
  it("shows the README's feature list", async () => {
    const content = await open()
    expect(content.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('opens a bundled doc it links to in the help dialog', async () => {
    const content = await open()
    const emit = vi.spyOn(emitter, 'emit')
    content.querySelector<HTMLAnchorElement>('a[data-help-page="party-mode"]')!.click()
    expect(emit).toHaveBeenCalledWith('openHelp', { page: 'party-mode', anchor: null })
  })
})
