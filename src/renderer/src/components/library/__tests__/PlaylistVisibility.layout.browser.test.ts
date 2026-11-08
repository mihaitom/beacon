// Whether the words fit their tile depends on real text metrics, per language.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import 'vuetify/styles'
import PlaylistVisibility from '../PlaylistVisibility.vue'

const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)))

describe('PlaylistVisibility', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  // The dialog's content width at its narrowest in use.
  it.each(['en', 'de', 'es', 'fr', 'it'])(
    'keeps its words inside the tiles in %s',
    async (lang) => {
      ;(i18n.global as unknown as { locale: string }).locale = lang
      const host = document.createElement('div')
      host.style.width = '320px'
      document.body.appendChild(host)
      wrapper = mount(PlaylistVisibility, {
        attachTo: host,
        props: { modelValue: false },
        global: { plugins: [createVuetify({ components, directives }), i18n] },
      })
      await frame()

      for (const tile of wrapper.findAll('button')) {
        const box = tile.element.getBoundingClientRect()
        const text = tile.element.querySelector('.playlist-visibility__text')!
        const words = text.getBoundingClientRect()
        expect(words.top).toBeGreaterThanOrEqual(box.top)
        expect(words.bottom).toBeLessThanOrEqual(box.bottom)
        expect(words.right).toBeLessThanOrEqual(box.right)
      }
    },
  )
})
