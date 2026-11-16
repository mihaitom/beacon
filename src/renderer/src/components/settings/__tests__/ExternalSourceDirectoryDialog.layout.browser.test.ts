// Real-browser test that the community apps fit a phone - run via
// `pnpm test:layout`. A long repository address or a long button next to
// it is exactly what jsdom lays out as nothing at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const LONG_APP = {
  name: 'A source with a rather long name for its tab',
  description: 'Plays folders of music files as albums and artists, with covers and search.',
  repository: 'https://github.com/mihaitom/beacon/tree/main/docs/examples/folder-source',
  author: 'someone-with-a-long-login',
  icon: 'mdi-folder-music',
  image: null,
}

const { fetchDirectory, fetchAllStars } = vi.hoisted(() => ({
  fetchDirectory: vi.fn(),
  // Never the network here; a big count is the widest it gets.
  fetchAllStars: vi.fn(async (apps: { repository: string }[]) => {
    return new Map(apps.map((app) => [app.repository, 123456]))
  }),
}))

vi.mock('@/services/externalSourceDirectory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/externalSourceDirectory')>()),
  fetchDirectory,
  fetchAllStars,
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
  beforeEach(() => fetchDirectory.mockResolvedValue([LONG_APP]))

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

  it.each([
    ['a desktop window', 1280, 900],
    ['a phone', 390, 844],
  ])(
    'scrolls a long list inside the dialog on %s, header and buttons staying put',
    async (_, w, h) => {
      fetchDirectory.mockResolvedValue(
        Array.from({ length: 12 }, (_, n) => ({
          ...LONG_APP,
          repository: `https://github.com/someone/app-${n}`,
        })),
      )
      const card = await open(w, h)
      const body = card.querySelector('.v-card-text') as HTMLElement
      const rect = () => card.getBoundingClientRect()

      // Capped like every dialog with content (.beacon-dialog in base.css);
      // where Vuetify places it in the test page is its business, not this.
      expect(rect().height).toBeLessThanOrEqual(h * 0.7 + 1)
      expect(getComputedStyle(body).overflowY).toBe('auto')
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)

      // The hero above and the buttons below stay inside the card.
      const hero = card.querySelector('.source-directory__hero')!.getBoundingClientRect()
      const actions = card.querySelector('.source-directory__actions')!.getBoundingClientRect()
      expect(hero.top).toBeGreaterThanOrEqual(rect().top - 1)
      expect(actions.bottom).toBeLessThanOrEqual(rect().bottom + 1)

      // And the note under the last card can be scrolled into view.
      body.scrollTop = body.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 50))
      const notice = card.querySelector('.source-directory__notice')!.getBoundingClientRect()
      expect(notice.bottom).toBeLessThanOrEqual(body.getBoundingClientRect().bottom + 1)
    },
  )
})
