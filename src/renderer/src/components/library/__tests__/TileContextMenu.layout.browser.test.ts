// Real-browser test for the tile context menu on a page that actually
// scrolls — run via `pnpm test:layout`. jsdom lays nothing out, so a menu
// opened at the pointer's coordinates measures as fine there whatever the
// page underneath is doing; the bug this exists for only appears once the
// page is scrolled, which is exactly the part jsdom has no notion of.
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import TileContextMenu from '../TileContextMenu.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

const TILE_COUNT = 40
const TILE_HEIGHT = 180

/** A page of tiles tall enough to scroll, each with its own menu — the
 * shape of the album and artist grids, without their data. */
const menus: { open(event: MouseEvent): void }[] = []

const TileGrid = defineComponent({
  setup() {
    return () =>
      h(components.VApp, null, {
        default: () =>
          h(
            'div',
            { class: 'grid' },
            Array.from({ length: TILE_COUNT }, (_, i) =>
              h(
                'div',
                {
                  class: 'tile',
                  'data-index': i,
                  style: `height: ${TILE_HEIGHT}px; background: #333; margin-bottom: 8px`,
                  onContextmenu: (event: MouseEvent) => {
                    event.preventDefault()
                    menus[i]?.open(event)
                  },
                },
                [
                  h(TileContextMenu, {
                    ref: (menu: unknown) => {
                      if (menu) menus[i] = menu as { open(event: MouseEvent): void }
                    },
                  }),
                ],
              ),
            ),
          ),
      })
  },
})

function mountGrid() {
  const wrapper = mount(TileGrid, {
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function settle(): Promise<void> {
  // The overlay's scroll strategy is applied a tick after it opens (see
  // Vuetify's useScrollStrategies), so a single frame isn't enough.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function rightClickTile(index: number): void {
  const tile = document.querySelector(`[data-index="${index}"]`) as HTMLElement
  const box = tile.getBoundingClientRect()
  tile.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(box.left + 20),
      clientY: Math.round(box.top + 20),
    }),
  )
}

function openMenus(): Element[] {
  return [...document.querySelectorAll('.v-overlay--active .v-list')]
}

describe('a tile context menu on a scrolled page', () => {
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    menus.length = 0
    document.body.innerHTML = ''
    window.scrollTo(0, 0)
  })

  it('opens at the pointer on the first screenful', async () => {
    await page.viewport(1200, 800)
    mountGrid()
    await settle()

    rightClickTile(1)
    await settle()

    expect(openMenus()).toHaveLength(1)
  })

  it('opens just the same once the page is scrolled down', async () => {
    // The reported failure: the first tiles answered a right-click, and
    // further down the page nothing opened at all.
    await page.viewport(1200, 800)
    mountGrid()
    await settle()

    window.scrollTo(0, TILE_HEIGHT * 20)
    await settle()
    rightClickTile(22)
    await settle()

    const menus = openMenus()
    expect(menus).toHaveLength(1)
    const box = menus[0]!.getBoundingClientRect()
    expect(box.height).toBeGreaterThan(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
  })

  it('dismisses itself rather than sliding over unrelated content when the page scrolls', async () => {
    // A menu anchored to a *point* has nothing to stay glued to, so the
    // alternative to closing is watching it drift across whatever scrolls
    // past underneath.
    await page.viewport(1200, 800)
    mountGrid()
    await settle()
    rightClickTile(1)
    await settle()
    expect(openMenus()).toHaveLength(1)

    window.scrollTo(0, TILE_HEIGHT * 10)
    await settle()

    expect(openMenus()).toHaveLength(0)
  })

  it('leaves the page where it was', async () => {
    // Whatever the menu does about scrolling, it must not move the content
    // out from under the pointer that opened it. Blocking the scroll (a
    // dialog's strategy) does exactly that: the document goes
    // `position: fixed` and window.scrollY collapses to 0 for as long as
    // the menu is open — which is what made the grids flicker.
    await page.viewport(1200, 800)
    mountGrid()
    await settle()

    window.scrollTo(0, TILE_HEIGHT * 20)
    await settle()
    const before = window.scrollY
    const tileBefore = document.querySelector('[data-index="22"]')!.getBoundingClientRect().top

    rightClickTile(22)
    await settle()

    expect(window.scrollY).toBe(before)
    expect(document.querySelector('[data-index="22"]')!.getBoundingClientRect().top).toBeCloseTo(
      tileBefore,
      0,
    )
  })
})
