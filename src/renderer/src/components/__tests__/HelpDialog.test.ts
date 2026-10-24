import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { HELP_PAGES, isFaqPage, pageFor } from '@/services/help/docs'
import HelpDialog from '../HelpDialog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function openOn(id: string) {
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
    const target = HELP_PAGES.find((page) => !isFaqPage(page))!
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
    const page = HELP_PAGES.find((p) => isFaqPage(p) && p !== pageFor('faq'))!
    const anchor = [...page.anchors].at(-1)!
    const wrapper = await openOn('faq')
    emitter.emit('openHelp', { page: page.id, anchor })
    await flushPromises()
    expect((wrapper.vm as unknown as { pageId: string }).pageId).toBe(page.id)
    expect(content().querySelector(`[id="${anchor}"]`)).not.toBeNull()
  })

  it('switches between the setups of a tab group', async () => {
    await openOn('party-mode')
    const tab = content().querySelector<HTMLElement>('#authelia')!
    const panel = content().querySelector<HTMLElement>('#authelia-panel')!
    expect(panel.hidden).toBe(true)
    tab.click()
    expect(panel.hidden).toBe(false)
    expect(tab.getAttribute('aria-selected')).toBe('true')
    const first = content().querySelector<HTMLElement>('.help-tabs__panel')!
    expect(first.hidden).toBe(true)
  })

  it('opens the tab a link points into', async () => {
    const wrapper = await openOn('party-mode')
    ;(wrapper.vm as unknown as { scrollTo(anchor: string): Promise<void> }).scrollTo('authelia')
    await flushPromises()
    expect(content().querySelector<HTMLElement>('#authelia-panel')!.hidden).toBe(false)
  })

  it('finds a question by searching and opens it there', async () => {
    const wrapper = await openOn('party-mode')
    const input = document.querySelector<HTMLInputElement>('.help-dialog__search input')!
    input.value = 'devices found'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    const result = document.querySelector<HTMLButtonElement>('.help-dialog__result')!
    expect(result.textContent).toContain('No devices found')
    expect(result.querySelector('mark')).not.toBeNull()
    result.click()
    await flushPromises()
    const vm = wrapper.vm as unknown as { pageId: string }
    expect(vm.pageId).toBe('faq/troubleshooting')
    expect(content().querySelector('#no-devices-found')!.classList).toContain('help-flash')
  })

  it('says so when a search finds nothing', async () => {
    await openOn('faq')
    const input = document.querySelector<HTMLInputElement>('.help-dialog__search input')!
    input.value = 'xyzzyplugh'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(document.querySelector('.help-dialog__result')).toBeNull()
    expect(document.querySelector('.help-dialog__empty')).not.toBeNull()
  })

  it("lists the open page's questions and goes back to where a link was followed", async () => {
    const wrapper = await openOn('faq')
    const vm = wrapper.vm as unknown as { pageId: string }
    const first = vm.pageId
    expect(document.querySelectorAll('.help-dialog__toc-entry').length).toBeGreaterThan(0)
    expect(document.querySelector('[aria-label="Back"]')).toBeNull()
    const guide = [
      ...document.querySelectorAll<HTMLElement>('.help-dialog__toc .v-list-item'),
    ].find((item) => item.textContent?.trim() === 'Party mode')!
    guide.click()
    await flushPromises()
    expect(vm.pageId).toBe('party-mode')
    document.querySelector<HTMLElement>('[aria-label="Back"]')!.click()
    await flushPromises()
    expect(vm.pageId).toBe(first)
    expect(document.querySelector('[aria-label="Back"]')).toBeNull()
  })

  it('starts afresh each time it is opened', async () => {
    const wrapper = await openOn('faq')
    const vm = wrapper.vm as unknown as {
      go(page: string): void
      history: unknown[]
      query: string
    }
    vm.go('party-mode')
    vm.query = 'sonos'
    emitter.emit('openHelp', 'transcoding-decisions')
    await flushPromises()
    expect(vm.history).toEqual([])
    expect(vm.query).toBe('')
  })
})
