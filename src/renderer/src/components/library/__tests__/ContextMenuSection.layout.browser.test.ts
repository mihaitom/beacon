// Real-browser layout test for the headings that split a context menu into
// its sections — run via `pnpm test:layout`. Both things it checks are
// things jsdom reports as zero whatever the CSS says: where the heading sits
// relative to the menu items under it, and the hairline that .panel-title
// draws with a ::after pseudo-element.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@/assets/base.css'
import { i18n } from '@/i18n'
import TileContextMenu from '../TileContextMenu.vue'
import ContextMenuSection from '../ContextMenuSection.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

let menu: { open(event: MouseEvent): void } | null = null

const Harness = defineComponent({
  setup() {
    return () =>
      h(components.VApp, null, {
        default: () =>
          h(
            'div',
            {
              style: 'height: 400px',
              onContextmenu: (event: MouseEvent) => {
                event.preventDefault()
                menu?.open(event)
              },
            },
            [
              h(
                TileContextMenu,
                {
                  ref: (instance: unknown) => {
                    if (instance) menu = instance as { open(event: MouseEvent): void }
                  },
                },
                {
                  default: () => [
                    h(ContextMenuSection, { label: 'Playback' }),
                    h(components.VListItem, null, {
                      default: () => h(components.VListItemTitle, null, { default: () => 'Play' }),
                    }),
                    h(ContextMenuSection, { label: 'Details' }),
                    h(components.VListItem, null, {
                      default: () => h(components.VListItemTitle, null, { default: () => 'Info' }),
                    }),
                  ],
                },
              ),
            ],
          ),
      })
  },
})

async function openMenu() {
  await page.viewport(1200, 800)
  const wrapper = mount(Harness, { attachTo: document.body, global: { plugins: [vuetify, i18n] } })
  wrappers.push(wrapper)
  document
    .querySelector('[style*="height: 400px"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
  // v-menu's own enter transition, same wait the other menu layout test uses.
  await new Promise((resolve) => setTimeout(resolve, 300))
  return [...document.querySelectorAll('.menu-section')] as HTMLElement[]
}

describe('context menu section headings', () => {
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    menu = null
    document.body.innerHTML = ''
  })

  /** The heading names the group under it, so it has to start where those
   * items start. It carries its own padding rather than inheriting one, and
   * a v-list-item's is Vuetify's to change — this is what catches the two
   * drifting apart. */
  it('lines its text up with the menu items below it', async () => {
    const sections = await openMenu()
    expect(sections.length).toBe(2)

    const item = document.querySelector('.v-list-item') as HTMLElement
    const itemContentLeft =
      item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft)

    for (const section of sections) {
      const textLeft =
        section.getBoundingClientRect().left + parseFloat(getComputedStyle(section).paddingLeft)
      expect(textLeft).toBeCloseTo(itemContentLeft, 0)
    }
  })

  /** .panel-title's hairline is what lets the heading replace the
   * <v-divider /> it grew out of: without it the sections stop being
   * visibly separated at all. It is a ::after with `flex: 1`, so it only
   * has a width once the heading is actually laid out as a flex row. */
  it('draws the hairline that stands in for the divider', async () => {
    const [section] = await openMenu()

    const rule = getComputedStyle(section!, '::after')
    expect(parseFloat(rule.width)).toBeGreaterThan(20)
    expect(parseFloat(rule.height)).toBeCloseTo(1, 1)
  })
})
