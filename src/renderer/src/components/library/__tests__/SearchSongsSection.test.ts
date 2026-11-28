import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { makeSong } from '@/stores/__tests__/fixtures'
import SearchSongsSection from '../SearchSongsSection.vue'

const vuetify = createVuetify({ components, directives })

const SongTableStub = {
  name: 'SongTable',
  props: ['songs', 'loading'],
  template: '<div class="table">{{ songs.length }}</div>',
}

function songs(count: number) {
  return Array.from({ length: count }, (_, i) => makeSong(`s${i}`))
}

function mountSection(list = songs(30), foldable = true) {
  return mount(SearchSongsSection, {
    props: { title: 'Songs', songs: list, foldable },
    global: { plugins: [vuetify, i18n], stubs: { SongTable: SongTableStub } },
  })
}

/** A long list of matching titles must not push the sections after it -
 * AudioMuse's "sounds like" and lyrics results - out of reach. */
describe('SearchSongsSection', () => {
  it('shows the first matches of a long list, and all of them on request', async () => {
    const wrapper = mountSection()
    const shown = () => Number(wrapper.get('.table').text())
    expect(shown()).toBeLessThan(30)

    await wrapper.get('button').trigger('click')
    expect(shown()).toBe(30)

    await wrapper.get('button').trigger('click')
    expect(shown()).toBeLessThan(30)
  })

  it('has nothing to unfold when every match already shows', () => {
    const wrapper = mountSection(songs(3))
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.get('.table').text()).toBe('3')
  })

  it('shows everything when nothing follows it on the page', () => {
    const wrapper = mountSection(songs(30), false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.get('.table').text()).toBe('30')
  })

  it('starts folded again for a new search', async () => {
    const wrapper = mountSection()
    await wrapper.get('button').trigger('click')

    await wrapper.setProps({ songs: songs(25) })

    expect(Number(wrapper.get('.table').text())).toBeLessThan(25)
  })
})
