// Whether a row stays put when albums arrive at its front is decided by the
// browser's scroll snapping, which jsdom does not have.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n } from '@/i18n'
import AlbumShelf from '../AlbumShelf.vue'
import type { Album } from '@/types/library'

/** A render function: the browser suite runs the runtime-only Vue build,
 * which renders a `template` stub as nothing. */
const CardStub = defineComponent({
  props: { album: { type: Object, required: true } },
  setup(props) {
    return () => h('div', { style: 'width: 160px; height: 200px' }, props.album.id)
  },
})

const albums = (...ids: string[]) => ids.map((id) => ({ id, name: id, artist: 'x' }) as Album)
const manyAlbums = albums(...Array.from({ length: 12 }, (_, index) => `old-${index}`))

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)))
}

describe('AlbumShelf when its list changes', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function mountShelf() {
    const host = document.createElement('div')
    host.style.width = '600px'
    document.body.appendChild(host)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: CardStub }],
    })
    wrapper = mount(AlbumShelf, {
      attachTo: host,
      props: { title: 'Shelf', albums: manyAlbums },
      global: {
        plugins: [createVuetify({ components, directives }), i18n, router],
        stubs: { AlbumCard: CardStub },
      },
    })
    await frame()
    return wrapper.find('.album-shelf-row').element as HTMLElement
  }

  it('shows albums added at the front when the row was at its start', async () => {
    const row = await mountShelf()
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth)
    expect(row.scrollLeft).toBe(0)

    await wrapper!.setProps({ albums: [...albums('new-1', 'new-2'), ...manyAlbums] })
    await nextTick()
    await frame()

    expect(row.scrollLeft).toBe(0)
  })

  it('stays with the album in view when the row was scrolled along', async () => {
    const row = await mountShelf()
    row.scrollLeft = 360
    await frame()
    const before = row.scrollLeft
    expect(before).toBeGreaterThan(0)

    await wrapper!.setProps({ albums: [...albums('new-1', 'new-2'), ...manyAlbums] })
    await nextTick()
    await frame()

    expect(row.scrollLeft).toBeGreaterThan(before)
  })
})
