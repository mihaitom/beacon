import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useLibraryStore } from '@/stores/library'
import ArtistCredit from '../ArtistCredit.vue'
import type { Artist } from '@/types/library'

function artist(id: string, name: string): Artist {
  return {
    id,
    name,
    albumCount: 0,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

async function mountCredit(props: Record<string, unknown>, onRowClick = () => {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  // Inside a clickable row, the way SongRow and SongCard use it.
  const Row = {
    components: { ArtistCredit },
    props: ['credit'],
    template: '<div @click="onRowClick"><artist-credit v-bind="$attrs" :credit="credit" /></div>',
    methods: { onRowClick },
  }
  return mount(Row, { props, global: { plugins: [router] } })
}

describe('ArtistCredit', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useLibraryStore().artists = [
      artist('magician', 'The Magician'),
      artist('years', 'Years & Years'),
    ]
  })

  it('links each known performer on their own', async () => {
    const wrapper = await mountCredit({ credit: 'The Magician feat. Years & Years' })

    const links = wrapper.findAll('a')
    expect(links.map((link) => link.text())).toEqual(['The Magician', 'Years & Years'])
    expect(links.map((link) => link.attributes('href'))).toEqual([
      '/artists/magician',
      '/artists/years',
    ])
    expect(wrapper.text()).toContain('·')
    expect(wrapper.text()).not.toContain('feat.')
  })

  it('does not hand a click on a name to the row around it', async () => {
    const onRowClick = vi.fn()
    const wrapper = await mountCredit({ credit: 'The Magician feat. Years & Years' }, onRowClick)

    await wrapper.find('a').trigger('click')

    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('links into the phone shell when asked to', async () => {
    const wrapper = await mountCredit({ credit: 'The Magician', mobile: true })

    expect(wrapper.get('a').attributes('href')).toBe('/m/artists/magician')
  })

  it('renders plain text where it must not be a link', async () => {
    const wrapper = await mountCredit({ credit: 'The Magician feat. Years & Years', linked: false })

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toContain('The Magician')
    expect(wrapper.text()).toContain('Years & Years')
  })

  it('falls back to the server id for a credit the library does not know', async () => {
    const wrapper = await mountCredit({ credit: 'Somebody Else', artistId: 'server-id' })

    expect(wrapper.get('a').attributes('href')).toBe('/artists/server-id')
  })
})
