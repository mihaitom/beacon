import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import QualityTips from '../QualityTips.vue'

const vuetify = createVuetify({ components, directives })

function mountTips(lines: string[]) {
  return mount(QualityTips, {
    props: { lines },
    global: { plugins: [vuetify, i18n] },
    attachTo: document.body,
  })
}

/** Whether the tooltip is actually shown is a question about a real
 * overlay, which jsdom has no layout to answer — it keeps the content in
 * the document either way. So these check what the tooltip says and how it
 * is reached, and the browser suite is where "does it open" would belong.
 */
describe('QualityTips', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders one line per recommendation', async () => {
    mountTips(['At home: Original.', 'Out and about: AAC 192.'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Rendered into an overlay outside the component's own tree.
    const shown = document.body.textContent ?? ''
    expect(shown).toContain('At home: Original.')
    expect(shown).toContain('Out and about: AAC 192.')
  })

  it('titles the advice rather than dropping the reader into a list', async () => {
    mountTips(['Anything'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.textContent).toContain('Recommendations')
  })

  /** Behind a button rather than a `title` attribute precisely so it can be
   * reached without a mouse — half of this app runs on a phone, where
   * there is no hover to open anything with. */
  it('opens from a real button, with a name a screen reader can read', () => {
    const wrapper = mountTips(['Anything'])
    const button = wrapper.get('button')

    expect(button.attributes('aria-label')).toBe('Recommendations')
  })
})
