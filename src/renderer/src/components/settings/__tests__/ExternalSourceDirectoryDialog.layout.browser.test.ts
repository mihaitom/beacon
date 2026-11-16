// Real-browser test that the community apps fit a phone - run via
// `pnpm test:layout`. A long repository address or a long button next to
// it is exactly what jsdom lays out as nothing at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts, see PrivacyDialog.layout.browser.test.ts.
import '@/assets/main.css'
import 'vuetify/styles'
import { applyLocale, getLocale, i18n, SUPPORTED_LOCALES } from '@/i18n'
import ExternalSourceDirectoryDialog from '../ExternalSourceDirectoryDialog.vue'

vi.mock('@/services/externalSourceDirectory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/externalSourceDirectory')>()),
  fetchDirectory: vi.fn(async () => [
    {
      name: 'A source with a rather long name for its tab',
      description: 'Plays folders of music files as albums and artists, with covers and search.',
      repository: 'https://github.com/mihaitom/beacon/tree/main/docs/examples/folder-source',
      author: 'someone-with-a-long-login',
      icon: 'mdi-folder-music',
      image: null,
    },
  ]),
}))

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

async function open(width: number, height: number) {
  await page.viewport(width, height)
  // Inside a v-app, or v-dialog has no overlay container to render into.
  const wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h(ExternalSourceDirectoryDialog, { modelValue: true }),
        }),
    },
    {
      attachTo: document.body,
      global: {
        plugins: [vuetify, i18n],
        mocks: { $emitter: { emit: () => {}, on: () => {}, off: () => {} } },
      },
    },
  )
  wrappers.push(wrapper)
  // The dialog's enter transition, and the list arriving.
  await new Promise((resolve) => setTimeout(resolve, 450))
  return document.querySelector('.source-directory') as HTMLElement
}

describe('ExternalSourceDirectoryDialog layout', () => {
  afterEach(async () => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
    await page.viewport(1280, 900)
  })

  it('fits a phone in every language, a long address cut rather than pushing out', async () => {
    const original = getLocale()
    try {
      for (const locale of SUPPORTED_LOCALES) {
        applyLocale(locale)
        const card = await open(390, 844)
        const body = card.querySelector('.v-card-text') as HTMLElement
        expect(body.scrollWidth, locale).toBeLessThanOrEqual(body.clientWidth)

        const box = card.querySelector('.source-directory__card')!.getBoundingClientRect()
        const add = card.querySelector('.source-directory__open')!.getBoundingClientRect()
        const repo = card.querySelector('.source-directory__repo')!.getBoundingClientRect()
        expect(add.right, locale).toBeLessThanOrEqual(box.right)
        expect(repo.right, locale).toBeLessThanOrEqual(add.left)
        while (wrappers.length) wrappers.pop()?.unmount()
        document.body.innerHTML = ''
      }
    } finally {
      applyLocale(original)
    }
  })
})
