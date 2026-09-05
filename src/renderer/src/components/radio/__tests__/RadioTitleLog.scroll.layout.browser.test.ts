// Real-browser test that the title log actually scrolls where it is used —
// run via `pnpm test:layout`. jsdom lays nothing out, so scrollHeight and
// clientHeight are both 0 there and any assertion about scrolling passes
// whatever the CSS says.
//
// Both places it goes are fixed boxes, and `overflow-y: auto` on its own is
// not enough in either: NowPlayingView gives it a fixed 85cqh with
// `overflow: hidden`, where a shorter child is simply clipped, and the
// drawer gives it a flex slot, where the default `min-height: auto` keeps
// it from shrinking below its content so there is never anything to
// scroll. A thousand-entry log showed one screenful and no way to reach
// the rest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
// Same order as main.ts: the app's own stylesheet first, which is what
// makes base.css's @layer declaration the authoritative one. Reversed,
// @layer base lands behind Vuetify's utility layer and its `* { margin: 0 }`
// reset silently cancels every mb-*/pa-* in the markup under test.
import '@/assets/main.css'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import RadioTitleLog from '../RadioTitleLog.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []

/** Far more entries than fit anywhere — the log holds up to a thousand. */
const ENTRIES = Array.from({ length: 200 }, (_, i) => ({
  title: `Artist ${i} - Track ${i}`,
  at: 1_757_000_000 + i * 200,
}))

/** Mounts the log the way its callers really use it: their own class lands
 * on the component's *root*, which is what sizes it — NowPlayingView's
 * .now-playing__lyrics and the drawer's own slot rule both do exactly
 * that. Anything that sized a wrapper instead would be testing a shape
 * that does not occur. */
function mountAsCallerDoes(hostStyle: string, rootStyle: string, count = ENTRIES.length) {
  const host = document.createElement('div')
  host.setAttribute('style', hostStyle)
  document.body.appendChild(host)
  const wrapper = mount(RadioTitleLog, {
    props: { entries: ENTRIES.slice(0, count) },
    attachTo: host,
    global: { plugins: [vuetify, i18n], mocks: { $router: { push: () => {} } } },
  })
  wrappers.push(wrapper)
  const root = wrapper.get('.title-log').element as HTMLElement
  // Vue Test Utils mounts into a wrapper div of its own, which would leave
  // the root a grandchild of the host — not a flex item of it, the way the
  // drawer really has it. Reparenting puts it where the callers put it.
  host.appendChild(root)
  root.setAttribute('style', rootStyle)
  return { root, scroller: wrapper.get('.title-log__scroll').element }
}

describe('RadioTitleLog scrolling', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await page.viewport(390, 844)
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    document.body.innerHTML = ''
  })

  it('scrolls inside the fixed, clipped box NowPlayingView gives it', () => {
    // .now-playing__lyrics: a fixed height with `overflow: hidden`, applied
    // to this component's own root. That is the phone case the report was
    // about.
    const { root, scroller } = mountAsCallerDoes('', 'height: 400px; overflow: hidden;')

    expect(root.getBoundingClientRect().height).toBeCloseTo(400, 0)
    expect(scroller.clientHeight).toBeGreaterThan(0)
    expect(scroller.clientHeight).toBeLessThanOrEqual(400)
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)

    scroller.scrollTop = scroller.scrollHeight
    expect(scroller.scrollTop).toBeGreaterThan(0)
  })

  it('scrolls inside the drawer slot rather than growing past it', () => {
    // A column with a toolbar above and this filling the rest, which is
    // .beacon-drawer__log.
    const { root, scroller } = mountAsCallerDoes(
      'display: flex; flex-direction: column; height: 400px;',
      'flex: 1 1 auto; min-height: 0;',
    )

    expect(root.getBoundingClientRect().height).toBeLessThanOrEqual(400)
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)

    scroller.scrollTop = scroller.scrollHeight
    expect(scroller.scrollTop).toBeGreaterThan(0)
  })

  it('leaves a short log unstretched, with nothing to scroll', () => {
    const { scroller } = mountAsCallerDoes('', 'height: 400px; overflow: hidden;', 2)

    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight)
  })
})
